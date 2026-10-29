"""Launch (or attach to) the copied Moon Sweepers and load a compiled Frida agent.

usage: python run_agent.py <agent.ts> [--attach] [--out FILE] [--wait SECONDS]
"""
import argparse, os, subprocess, sys, time, threading
import frida

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME_DIR = os.path.join(ROOT, "game")
EXE = os.path.join(GAME_DIR, "MoonSweepers.exe")

ap = argparse.ArgumentParser()
ap.add_argument("agent")
ap.add_argument("--attach", action="store_true", help="attach to running game instead of launching")
ap.add_argument("--out", help="write 'chunk' messages to this file")
ap.add_argument("--wait", type=float, default=8.0, help="seconds to let the game boot before attaching")
ap.add_argument("--timeout", type=float, default=0, help="exit after N seconds (0 = run until game exits / Ctrl+C)")
ap.add_argument("--pid", type=int, help="attach to this pid")
ap.add_argument("--sandbox", action="store_true", help="attach to the sandbox game (sandbox/pid)")
args = ap.parse_args()

compiler = frida.Compiler()
compiler.on("diagnostics", lambda d: print("[compile]", d, file=sys.stderr))
bundle = compiler.build(os.path.abspath(args.agent), project_root=os.path.join(ROOT, "agent"))

if not args.attach:
    subprocess.Popen([EXE], cwd=GAME_DIR)
    time.sleep(args.wait)

pid = args.pid or (int(open(os.path.join(ROOT, "sandbox", "pid")).read()) if args.sandbox else None)
for _ in range(0 if pid else 60):
    procs = [p for p in frida.get_local_device().enumerate_processes() if p.name.lower() == "moonsweepers.exe"]
    if procs:
        pid = procs[0].pid
        break
    time.sleep(1)
if pid is None:
    sys.exit("MoonSweepers.exe not running")

session = frida.attach(pid)
done = threading.Event()
out = open(args.out, "w", encoding="utf-8") if args.out else None

def on_message(msg, data):
    if msg["type"] == "error":
        print("[agent error]", msg.get("stack") or msg.get("description"), file=sys.stderr)
        return
    p = msg["payload"]
    if isinstance(p, dict) and p.get("type") == "chunk" and out:
        out.write(p["data"]); out.flush()
    elif isinstance(p, dict) and p.get("type") == "done":
        done.set()
    else:
        print("[agent]", p, flush=True)

session.on("detached", lambda reason, crash: (print("[detached]", reason), done.set()))
script = session.create_script(bundle)
script.on("message", on_message)
script.load()
print(f"[runner] agent loaded into pid {pid}", flush=True)

try:
    done.wait(args.timeout or None)
except KeyboardInterrupt:
    pass
if out:
    out.close()
