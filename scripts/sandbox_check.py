"""Isolation check for the sandbox game (Task 1 acceptance, reusable by later tasks).

usage: python -I scripts/sandbox_check.py [minutes=2]
Passes (exit 0) when:
  - the sandbox wrote save files under sandbox/data/MoonSessions in the last N minutes,
  - sandbox/audit.log is empty (no write ever reached the live folder),
  - the live session.running still belongs to Aryan's game, not the sandbox,
  - Aryan's live trainer status is fresh (his game is still running normally).
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.dirname(os.path.dirname(os.path.dirname(ROOT))) if ".claude" in ROOT else ROOT
LIVE = os.path.join(os.environ["USERPROFILE"], "AppData", "LocalLow", "DragDropGames", "MoonSweepers")
minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 2
cutoff = time.time() - minutes * 60


def recent(folder):
    out = []
    for d, _, files in os.walk(folder):
        out += [os.path.join(d, f) for f in files if os.path.getmtime(os.path.join(d, f)) >= cutoff]
    return out


sandbox_pid = open(os.path.join(ROOT, "sandbox", "pid")).read().strip()
checks = []
written = recent(os.path.join(ROOT, "sandbox", "data", "MoonSessions"))
checks.append((f"sandbox wrote {len(written)} save file(s) in the last {minutes:g} min", len(written) > 0))
audit = open(os.path.join(ROOT, "sandbox", "audit.log"), encoding="utf-8").read().strip()
checks.append((f"audit.log empty ({len(audit.splitlines())} live writes)", not audit))
owner = open(os.path.join(LIVE, "session.running")).readline().strip()
checks.append((f"live session.running owner {owner} is not the sandbox ({sandbox_pid})", owner != sandbox_pid))
status = json.load(open(os.path.join(MAIN, "status.json")))
age = time.time() - status["at"] / 1000
checks.append((f"Aryan's game pid {status['pid']} status is {age:.1f}s old", age < 5))

for text, ok in checks:
    print(("PASS " if ok else "FAIL ") + text)
sys.exit(0 if all(ok for _, ok in checks) else 1)
