"""Print selected fields of sandbox/status.json every N seconds for M seconds.

usage: python -I scripts/watch_status.py [interval_s=15] [duration_s=300]
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
interval = float(sys.argv[1]) if len(sys.argv) > 1 else 15
duration = float(sys.argv[2]) if len(sys.argv) > 2 else 300
end = time.time() + duration
while True:
    try:
        s = json.load(open(os.path.join(ROOT, "sandbox", "status.json"), encoding="utf-8"))
        age = time.time() - s["at"] / 1000
        print(time.strftime("%H:%M:%S"), f"age {age:.1f}s inGame {s['inGame']} sales {s['sales']}",
              "|", "; ".join(s.get("crew", [])) or "no crew", "|", s.get("lastError") or "", flush=True)
    except (OSError, json.JSONDecodeError) as e:
        print(time.strftime("%H:%M:%S"), "status unreadable:", e, flush=True)
    if time.time() >= end:
        break
    time.sleep(interval)
