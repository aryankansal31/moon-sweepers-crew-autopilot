"""Moon Sweepers trainer launcher.

Starts the copied game (if it isn't already running), injects agent/src/trainer.ts with Frida
and shows a small control panel.

The agent is eternalized and Frida detaches straight away, so closing this window (or killing
it) never touches the game. The panel and the agent talk only through two files next to this
script: config.json (settings, written by both) and status.json (written by the agent).

usage: python moon_trainer.py [--nogui] [--set key=value ...]
"""
import argparse
import itertools
import json
import os
import subprocess
import sys
import time

import frida

ROOT = os.path.dirname(os.path.abspath(__file__))
GAME_DIR = os.path.join(ROOT, "game")
EXE = os.path.join(GAME_DIR, "MoonSweepers.exe")
AGENT = os.path.join(ROOT, "agent", "src", "trainer.ts")
CONFIG_PATH = os.path.join(ROOT, "config.json")
STATUS_PATH = os.path.join(ROOT, "status.json")
CREW_PATH = os.path.join(ROOT, "crew.json")
CREW_REQUEST_PATH = os.path.join(ROOT, "crew-request.json")  # panel -> agent: hire requests
STATUS_STALE_SECONDS = 3

DEFAULTS = {
    "enabled": True,
    "timeScale": 2.0,
    "moveMult": 1.5,
    "cleanWidthMult": 1.5,
    "cleanDepthMult": 1.0,
    "capacityMult": 2.0,
    "depositSpeedMult": 3.0,
    "vehicleMult": 1.5,
    "robotBinMult": 3.0,
    "autoDeposit": True,
    "autoSell": True,
    "mapLandmarks": True,
    "hotkeys": True,
}

SLIDERS = [  # key, label, min, max, step
    ("timeScale", "Game speed (x)", 0.5, 10, 0.5),
    ("moveMult", "Walk speed (x)", 1, 5, 0.25),
    ("vehicleMult", "Vehicle speed (x)", 1, 5, 0.25),
    ("cleanWidthMult", "Cleaning width (x)", 1, 5, 0.25),
    ("cleanDepthMult", "Cleaning depth (x)", 1, 5, 0.25),
    ("capacityMult", "Container capacity (x)", 1, 10, 0.5),
    ("depositSpeedMult", "Deposit speed (x)", 1, 10, 0.5),
    ("robotBinMult", "Robot bin size + unload (x)", 1, 10, 0.5),
]
TOGGLES = [
    ("enabled", "Trainer enabled (off = normal game)"),
    ("autoDeposit", "Auto-deposit when container is full"),
    ("autoSell", "Auto-sell station tray"),
    ("mapLandmarks", "Show every flag and site on the map (raised ones dimmed)"),
    ("hotkeys", "Hotkeys (F5/F6 speed, F7 1x, F8 auto, F9 robot bins, F10 deposit now, F11 crew)"),
]


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return cfg


def save_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)  # atomic, so the agent never reads half a file


def read_status():
    """The agent's latest status, or None if the game isn't running a trainer right now."""
    try:
        with open(STATUS_PATH, encoding="utf-8") as f:
            s = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return s if time.time() * 1000 - s.get("at", 0) < STATUS_STALE_SECONDS * 1000 else None


CREW_NAMES = {"sweeper": "Dusty (Sweeper)", "hauler": "Hank (Hauler)"}
CREW_PRICES = {"sweeper": 450, "hauler": 350}  # same as agent/src/crew/hires.ts PRICES


def crew_lines(status):
    """One status line per helper that is out, as the agent reports them."""
    return list((status or {}).get("crew", []))


def _crew_data(text):
    try:
        d = json.loads(text) if text else {}
    except json.JSONDecodeError:
        d = {}
    return d if isinstance(d, dict) else {}


def hired_kinds(text, game_key=None):
    """Helpers hired in crew.json: for one game, or in any game when game_key is None."""
    games = _crew_data(text).get("games", {})
    kinds = []
    for key, g in games.items():
        if game_key is None or key == game_key:
            kinds += [k for k in g.get("hired", []) if k not in kinds]
    return kinds


def set_paused(text, kind, paused):
    """crew.json text with only `kind`'s pause flag changed (the agent owns everything else).

    None when `text` can't be read as a crew file: writing then would erase every paid hire."""
    if text:
        try:
            d = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(d, dict):
            return None
    else:
        d = {}
    d.setdefault("paused", {})[kind] = paused
    return json.dumps(d, indent=2)


_request_seq = itertools.count(1)


def hire_request(kind):
    """crew-request.json text asking the agent to hire `kind`, with a fresh id per click.

    The clock alone isn't enough: Windows' time_ns is coarse, so two clicks could share an id."""
    return json.dumps({"id": f"{time.time_ns():x}-{next(_request_seq)}", "hire": kind})


def hire_reply(status, req_id):
    """The agent's answer to request `req_id` (status.json crewReply), or None if not answered yet."""
    reply = (status or {}).get("crewReply") or {}
    return reply.get("text") if reply.get("id") == req_id else None


def write_hire_request(text):
    tmp = CREW_REQUEST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, CREW_REQUEST_PATH)


def read_crew():
    """crew.json's text, "" if there is none yet, or None if it exists but can't be read now."""
    try:
        with open(CREW_PATH, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""
    except OSError:
        return None


def write_crew(text):
    tmp = CREW_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, CREW_PATH)


def find_game_pids():
    return [p.pid for p in frida.get_local_device().enumerate_processes()
            if p.name.lower() == "moonsweepers.exe"]


def try_attach(pid):
    """Attach, or return None if the process is a dead instance still tearing down."""
    try:
        return frida.attach(pid)
    except (frida.NotSupportedError, frida.ProcessNotFoundError, frida.ProcessNotRespondingError) as e:
        print(f"[trainer] skipping pid {pid}: {e}")
        return None


def start_game():
    # A crashed game can linger as an unkillable, terminating process; attaching to it fails
    # with 0xc000010a, so skip such pids and launch a fresh copy.
    dead = set()
    for pid in find_game_pids():
        session = try_attach(pid)
        if session:
            print(f"[trainer] attached to running game (pid {pid})")
            return session
        dead.add(pid)
    print("[trainer] launching", EXE)
    subprocess.Popen([EXE], cwd=GAME_DIR)
    for _ in range(120):
        time.sleep(1)
        fresh = [pid for pid in find_game_pids() if pid not in dead]
        if fresh:
            time.sleep(5)  # let GameAssembly.dll load before injecting
            session = try_attach(fresh[0])
            if session:
                return session
            dead.add(fresh[0])
    sys.exit("game did not start")


def inject(cfg):
    save_config(cfg)
    compiler = frida.Compiler()
    compiler.on("diagnostics", lambda diags: [print(f"[compile] {d['file']['path']}:{d['file']['line']}: {d['text']}")
                                              for d in diags if d.get("category") == "error"])
    bundle = compiler.build(AGENT, project_root=os.path.join(ROOT, "agent"))
    session = start_game()
    script = session.create_script(bundle)
    script.on("message", lambda m, _d: print("[agent]", m.get("payload", m.get("description"))))
    script.load()
    info = script.exports_sync.init({"config": CONFIG_PATH, "status": STATUS_PATH, "crew": CREW_PATH})
    if info["duplicate"]:
        print(f"[trainer] already active in pid {info['pid']}; opening the panel only")
        script.unload()  # nothing was hooked by this copy
    else:
        script.eternalize()
        print(f"[trainer] injected into pid {info['pid']}")
    session.detach()


def run_gui():
    import tkinter as tk
    from tkinter import ttk

    cfg = load_config()
    root = tk.Tk()
    root.title("Moon Sweepers Trainer")
    root.attributes("-topmost", True)
    frame = ttk.Frame(root, padding=12)
    frame.grid()
    widgets = {}

    def set_value(key, value):
        cfg[key] = value
        save_config(cfg)

    for row, (key, label, lo, hi, step) in enumerate(SLIDERS):
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w")
        var = tk.DoubleVar(value=cfg[key])
        value_lbl = ttk.Label(frame, width=6, text=f"{cfg[key]:g}")
        value_lbl.grid(row=row, column=2)

        def changed(_v, key=key, var=var, lbl=value_lbl, step=step):
            snapped = round(var.get() / step) * step
            lbl.config(text=f"{snapped:g}")
            if snapped != cfg[key]:
                set_value(key, snapped)

        ttk.Scale(frame, from_=lo, to=hi, variable=var, length=260, command=changed).grid(row=row, column=1, padx=8)
        widgets[key] = (var, value_lbl)

    base = len(SLIDERS)
    for i, (key, label) in enumerate(TOGGLES):
        var = tk.BooleanVar(value=cfg[key])
        ttk.Checkbutton(frame, text=label, variable=var,
                        command=lambda key=key, var=var: set_value(key, var.get())).grid(
            row=base + i, column=0, columnspan=3, sticky="w")
        widgets[key] = (var, None)

    status = ttk.Label(frame, text="", foreground="#555", justify="left")
    status.grid(row=base + len(TOGGLES), column=0, columnspan=3, sticky="w", pady=(8, 0))

    # Crew: a "working" switch per helper (pauses it without un-hiring), enabled once hired.
    row = base + len(TOGGLES) + 1
    ttk.Label(frame, text="Crew: press F11 in a shift for the crew window, or hire here (solo shifts only)").grid(row=row, column=0, columnspan=3, sticky="w", pady=(8, 0))
    crew_vars = {}
    crew_boxes = {}

    def toggle_crew(kind):
        text = read_crew()
        new = set_paused(text, kind, not crew_vars[kind].get()) if text is not None else None
        if new is None:  # crew.json busy or mid-write: leave it alone, the next poll resets the box
            return
        try:
            write_crew(new)
        except OSError:
            pass

    hire_buttons = {}
    pending = {"id": None, "kind": None}

    def hire(kind):
        text = hire_request(kind)
        try:
            write_hire_request(text)
        except OSError as e:
            hire_note.config(text=f"Couldn't send the request: {e}")
            return
        pending["id"], pending["kind"] = json.loads(text)["id"], kind
        hire_note.config(text=f"Hiring {CREW_NAMES[kind]}...")

    for i, (kind, name) in enumerate(CREW_NAMES.items()):
        button = ttk.Button(frame, text=f"Hire {name.split(' ')[0]} (${CREW_PRICES[kind]})", width=18,
                            command=lambda k=kind: hire(k))
        button.grid(row=row + 1 + i, column=0, sticky="w")
        var = tk.BooleanVar(value=True)
        box = ttk.Checkbutton(frame, text=f"{name} working", variable=var, command=lambda k=kind: toggle_crew(k))
        box.grid(row=row + 1 + i, column=1, columnspan=2, sticky="w")
        crew_vars[kind], crew_boxes[kind], hire_buttons[kind] = var, box, button
    hire_note = ttk.Label(frame, text="", foreground="#1a6", justify="left", wraplength=520)
    hire_note.grid(row=row + 1 + len(CREW_NAMES), column=0, columnspan=3, sticky="w")
    crew_status = ttk.Label(frame, text="", foreground="#555", justify="left", wraplength=520)
    crew_status.grid(row=row + 2 + len(CREW_NAMES), column=0, columnspan=3, sticky="w")
    ttk.Label(frame, text="Closing this window leaves the trainer running in the game.",
              foreground="#888").grid(row=row + 3 + len(CREW_NAMES), column=0, columnspan=3, sticky="w")

    def poll_crew(s):
        text = read_crew()
        hired = hired_kinds(text, s.get("gameKey") if s else None)
        paused = _crew_data(text).get("paused", {})
        for kind, box in crew_boxes.items():
            box.state(["!disabled"] if kind in hired else ["disabled"])
            crew_vars[kind].set(not paused.get(kind, False))
            hire_buttons[kind].state(["disabled"] if kind in hired or s is None else ["!disabled"])
        if pending["id"]:
            reply = hire_reply(s, pending["id"])
            if reply:
                hire_note.config(text=reply)
                pending["id"] = None
        lines = crew_lines(s)
        crew_status.config(text="\n".join(lines) if lines else ("No crew hired yet." if not hired else ""))

    def poll():
        # Pick up hotkey changes the agent wrote to config.json.
        disk = load_config()
        for k, v in disk.items():
            if v != cfg[k]:
                cfg[k] = v
                var, lbl = widgets[k]
                var.set(v)
                if lbl:
                    lbl.config(text=f"{v:g}")
        s = read_status()
        if s is None:
            status.config(text="Game not running (or still loading).")
        else:
            where = "in shift" if s["inGame"] else "menu"
            status.config(text=f"{where} | speed {s['timeScale']:g}x | robots {s['robots']} | "
                               f"deposits {s['deposits']} | sales {s['sales']}"
                               + (f"\nlandmarks {s['landmarks']} | nearest unraised: {s['nearestLandmark']}"
                                  if s.get("nearestLandmark") else "")
                               + (f"\n{s['lastError']}" if s["lastError"] else ""))
        poll_crew(s)
        root.after(500, poll)

    poll()
    root.mainloop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nogui", action="store_true", help="inject and exit without the control panel")
    ap.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE", help="override config values")
    args = ap.parse_args()

    cfg = load_config()
    for kv in args.set:
        k, v = kv.split("=", 1)
        if k not in DEFAULTS:
            sys.exit(f"unknown setting {k}")
        cfg[k] = v.lower() in ("1", "true", "on") if isinstance(DEFAULTS[k], bool) else float(v)

    inject(cfg)
    print("[trainer] settings:", json.dumps(cfg))
    if not args.nogui:
        run_gui()


if __name__ == "__main__":
    main()
