"""Find direct call (E8) or jmp (E9) rel32 sites targeting an RVA in GameAssembly.dll, and name
the containing methods from analysis/dump.cs.

usage: xrefs.py <rva-hex> [opcode-hex, default e8]
"""
import bisect
import os
import re
import sys

import pefile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
target = int(sys.argv[1], 16)
op = bytes.fromhex(sys.argv[2]) if len(sys.argv) > 2 else bytes.fromhex("e8")

starts, names, cur = [], [], None
for line in open(os.path.join(ROOT, "analysis", "dump.cs"), encoding="utf-8"):
    m = re.match(r"^(?:class|struct|enum|interface|abstract class|sealed class|static class)\s+(\S+)", line.strip())
    if m and not line.startswith(" "):
        cur = m.group(1)
    m = re.search(r"(\S+)\(.*\); // 0x([0-9a-f]+)$", line)
    if m and cur:
        starts.append(int(m.group(2), 16))
        names.append(f"{cur}::{m.group(1)}")
order = sorted(range(len(starts)), key=lambda i: starts[i])
starts = [starts[i] for i in order]
names = [names[i] for i in order]

pe = pefile.PE(os.path.join(ROOT, "game", "GameAssembly.dll"), fast_load=True)
# IL2CPP puts generated game code in its own "il2cpp" section; runtime code is in .text.
for sec in pe.sections:
    if sec.Name.rstrip(b"\0") not in (b".text", b"il2cpp"):
        continue
    data, base = sec.get_data(), sec.VirtualAddress
    i = data.find(op)
    while i != -1:
        if i + 5 <= len(data):
            rel = int.from_bytes(data[i + 1:i + 5], "little", signed=True)
            if base + i + 5 + rel == target:
                k = bisect.bisect_right(starts, base + i) - 1
                print(f"{base + i:08x} in {names[k] if k >= 0 else '?'}")
        i = data.find(op, i + 1)
