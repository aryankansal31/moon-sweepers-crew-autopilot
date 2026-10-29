"""Development copy of the game, isolated from Aryan's live game and save.

usage:
  python -I scripts/sandbox.py start   # spawn, isolate, load trainer (non-eternal); stays attached
  python -I scripts/sandbox.py shift   # start the shift in the sandbox
  python -I scripts/sandbox.py stop    # quit the sandbox game

Everything the sandbox writes under the game's AppData folder goes to sandbox/data instead, its
registry settings go to a separate key, and its trainer uses sandbox/config.json, status.json and
crew.json. sandbox/audit.log lists any write that still reached the live folder: it must stay empty.
"""
import json
import os
import shutil
import subprocess
import sys
import time

import frida

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SANDBOX = os.path.join(ROOT, "sandbox")
DATA = os.path.join(SANDBOX, "data")
GAME_DIR = os.path.join(ROOT, "game")
EXE = os.path.join(GAME_DIR, "MoonSweepers.exe")
LIVE_ROOT = os.path.join(os.environ["USERPROFILE"], "AppData", "LocalLow", "DragDropGames", "MoonSweepers")
LIVE_REG = r"Software\DragDropGames\MoonSweepers"
SANDBOX_REG = r"Software\DragDropGames\MoonSweepersSandbox"
PID_PATH = os.path.join(SANDBOX, "pid")
AUDIT_PATH = os.path.join(SANDBOX, "audit.log")
BOOT_SECONDS = 8


def wait_for_ticks(status_path, pid, timeout=120):
    """Block until the sandbox trainer's status.json shows this pid ticking."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            s = json.load(open(status_path, encoding="utf-8"))
            if s.get("pid") == pid and s.get("ticks", 0) > 0:
                return
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.5)
    raise TimeoutError("sandbox trainer never started ticking")


def build(entry):
    errors = []
    c = frida.Compiler()
    c.on("diagnostics", lambda ds: errors.extend(f"{d['file']['path']}:{d['file']['line']}: {d['text']}"
                                                 for d in ds if d.get("category") == "error"))
    try:
        return c.build(os.path.join(ROOT, "agent", "src", entry), project_root=os.path.join(ROOT, "agent"))
    except frida.InvalidArgumentError:
        sys.exit("\n".join(errors) or f"{entry}: compilation failed")


def prepare():
    """First run: copy the live saves into the sandbox. An existing sandbox is never overwritten."""
    if os.path.exists(os.path.join(DATA, "MoonSessions")):
        return
    os.makedirs(DATA, exist_ok=True)
    # Aryan's game may be saving while we copy: skip its temp files and retry if a file vanishes.
    dest = os.path.join(DATA, "MoonSessions")
    for attempt in range(10):
        try:
            shutil.copytree(os.path.join(LIVE_ROOT, "MoonSessions"), dest, ignore=shutil.ignore_patterns("*.tmp"))
            break
        except shutil.Error:
            shutil.rmtree(dest, ignore_errors=True)
            time.sleep(2)
    else:
        sys.exit("could not copy the live save (it kept changing); try again")
    # In a worktree (<main>/.claude/worktrees/<name>) the live trainer's config is three levels up.
    live_cfg = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(ROOT))), "config.json")
    for candidate in (os.path.join(ROOT, "config.json"), live_cfg):
        if os.path.exists(candidate):
            shutil.copy(candidate, os.path.join(SANDBOX, "config.json"))
            break


def minimize(pid):
    """Minimize the sandbox window without activating it (SW_SHOWMINNOACTIVE = 7)."""
    ps = (f"$p = Get-Process -Id {pid}; for ($i=0; $i -lt 60 -and $p.MainWindowHandle -eq 0; $i++) "
          "{ Start-Sleep -Milliseconds 500; $p.Refresh() }; "
          "Add-Type -Name W -Namespace S -MemberDefinition "
          "'[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int c);'; "
          "[S.W]::ShowWindow($p.MainWindowHandle, 7) | Out-Null")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False)


def start():
    prepare()
    sandbox_js, trainer_js = build("sandbox.ts"), build("trainer.ts")
    device = frida.get_local_device()
    pid = device.spawn([EXE, "-screen-fullscreen", "0", "-screen-width", "1280", "-screen-height", "720",
                        "-logFile", os.path.join(DATA, "Player.log")], cwd=GAME_DIR)
    session = device.attach(pid)
    audit = open(AUDIT_PATH, "a", encoding="utf-8")

    def on_message(msg, _data):
        p = msg.get("payload")
        if isinstance(p, dict) and p.get("type") == "audit":
            audit.write(json.dumps(p) + "\n")
            audit.flush()
            print("[AUDIT] live write:", p, flush=True)
        elif msg["type"] == "error":
            print("[agent error]", msg.get("stack") or msg.get("description"), flush=True)
        else:
            print("[agent]", p, flush=True)

    iso = session.create_script(sandbox_js)
    iso.on("message", on_message)
    iso.load()
    iso.exports_sync.init({"liveRoot": LIVE_ROOT, "sandboxRoot": DATA,
                           "liveRegKey": LIVE_REG, "sandboxRegKey": SANDBOX_REG})
    device.resume(pid)
    with open(PID_PATH, "w") as f:
        f.write(str(pid))
    print(f"[sandbox] game pid {pid}, isolation active", flush=True)
    try:
        minimize(pid)
        # Touching IL2CPP while Unity is still booting crashed the game once (scheduling onto the
        # main thread during render-pipeline set-up), so wait like the launcher does, then load the
        # trainer, and only settle once its tick proves the main loop is running.
        time.sleep(BOOT_SECONDS)
        trainer = session.create_script(trainer_js)
        trainer.on("message", on_message)
        trainer.load()
        trainer.exports_sync.init({"config": os.path.join(SANDBOX, "config.json"),
                                   "status": os.path.join(SANDBOX, "status.json"),
                                   "crew": os.path.join(SANDBOX, "crew.json")})
        wait_for_ticks(os.path.join(SANDBOX, "status.json"), pid)
        print("[sandbox] settle:", iso.exports_sync.settle(), flush=True)
        # Isolation must outlive this script: if Python dies, the sandbox must still never write live.
        # (An eternalized script takes no more RPC calls, so this comes after settle.)
        iso.eternalize()
    except Exception:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=False, capture_output=True)
        raise
    print("[sandbox] trainer loaded (non-eternal)", flush=True)

    done = []
    session.on("detached", lambda reason, crash: done.append(reason))
    try:
        while not done:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    print("[sandbox] detached:", done[0] if done else "interrupted", flush=True)


def probe(*cmds, timeout=None):
    try:
        subprocess.run([sys.executable, "-I", os.path.join(ROOT, "scripts", "probe.py"), "--sandbox", *cmds],
                       timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "start":
        start()
    elif cmd == "shift":
        probe("startShift", timeout=60)
    elif cmd == "stop":
        probe("quit", timeout=20)
        time.sleep(5)
        pid = int(open(PID_PATH).read())
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=False, capture_output=True)
    else:
        sys.exit(__doc__)
