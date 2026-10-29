"""After `sandbox.py start` (run in the background, logging to LOG): wait for the trainer, start the
shift, wait until in-game, and optionally move the player next to a cleaning robot.

usage: python -I scripts/sandbox_prep.py LOG [--dirt | --fresh]
  --dirt   next to a robot that is cleaning (partly swept ground)
  --fresh  untouched ground 300-900 m from the station
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
log, dirt, fresh = sys.argv[1], "--dirt" in sys.argv, "--fresh" in sys.argv


def probe(*cmds, timeout=90):
    return subprocess.run([PY, "-I", os.path.join(ROOT, "scripts", "probe.py"), *cmds],
                          capture_output=True, text=True, timeout=timeout).stdout


def wait(pred, what, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return
        time.sleep(1)
    sys.exit(f"timed out waiting for {what}")


def log_has(*words):
    try:
        text = open(log, encoding="utf-8", errors="replace").read()
    except FileNotFoundError:
        return False
    if "Traceback" in text or "[agent error]" in text:
        sys.exit("sandbox failed:\n" + text[-2000:])
    return all(w in text for w in words)


def in_game():
    try:
        s = json.load(open(os.path.join(ROOT, "sandbox", "status.json"), encoding="utf-8"))
        return s.get("inGame") and time.time() - s["at"] / 1000 < 3
    except (OSError, json.JSONDecodeError, KeyError):
        return False


wait(lambda: log_has("[sandbox] trainer loaded"), "trainer", 240)
print("trainer loaded", flush=True)
print(probe("startShift").strip().splitlines()[-1], flush=True)
wait(in_game, "shift", 240)
print("in shift", flush=True)
if fresh:
    min_dist = os.environ.get("FRESH_MIN_M", "0")
    print(probe(f"moveToFresh:{min_dist}", timeout=180).strip().splitlines()[-1], flush=True)
if dirt:
    for _ in range(20):
        out = probe("moveToDirt")
        print(out.strip().splitlines()[-1], flush=True)
        if "moved" in out:
            break
        time.sleep(8)
