"""Disassemble a GameAssembly function and name every call target, resolving engine methods that
analysis/dump.cs doesn't list by asking the running sandbox game (probe.ts `resolve`).

usage: python -I scripts/annotate.py <rva-hex> [max_insns=800] [--calls]
  --calls   print only call/jmp lines and ret (the call graph), not every instruction
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
args = [a for a in sys.argv[1:] if not a.startswith("--")]
calls_only = "--calls" in sys.argv
rva = args[0]
count = args[1] if len(args) > 1 else "800"

lines = subprocess.run([PY, "-I", os.path.join(ROOT, "scripts", "disasm.py"), rva, count],
                       capture_output=True, text=True, check=True).stdout.splitlines()
# Stop after the function's own ret/int3 padding.
body = []
for ln in lines:
    body.append(ln)
    parts = ln.split()
    if len(parts) >= 2 and parts[1] == "int3" and len(body) > 3:
        break

unnamed = sorted({p.split()[2] for p in body
                  if len(p.split()) == 3 and p.split()[1] in ("call", "jmp") and p.split()[2].startswith("0x")})
names = {}
if unnamed:
    out = subprocess.run([PY, "-I", os.path.join(ROOT, "scripts", "probe.py"), *unnamed],
                         capture_output=True, text=True, timeout=120).stdout
    start = out.find("{")
    if start >= 0:
        names = json.loads(out[start:out.rfind("}") + 1])

for ln in body:
    parts = ln.split()
    if len(parts) == 3 and parts[1] in ("call", "jmp") and parts[2].startswith("0x"):
        ln = f"{ln}  {names.get(parts[2][2:].lstrip('0'), '')}"
    if not calls_only or (len(parts) >= 2 and parts[1] in ("call", "jmp", "ret")):
        print(ln)
