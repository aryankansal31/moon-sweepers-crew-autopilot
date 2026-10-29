"""Disassemble an IL2CPP method by RVA and annotate call targets with names from analysis/dump.cs.
usage: disasm.py <rva-hex> [max_insns]"""
import re, sys, os, pefile, capstone
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
names = {}
cur = None
for line in open(os.path.join(ROOT, "analysis", "dump.cs"), encoding="utf-8"):
    m = re.match(r"^(?:class|struct|enum|interface|abstract class|sealed class|static class)\s+(\S+)", line.strip())
    if m and not line.startswith(" "): cur = m.group(1)
    m = re.search(r"(\S+)\(.*\); // 0x([0-9a-f]+)$", line)
    if m and cur: names.setdefault(int(m.group(2), 16), f"{cur}::{m.group(1)}")
pe = pefile.PE(os.path.join(ROOT, "game", "GameAssembly.dll"), fast_load=True)
rva = int(sys.argv[1], 16); n = int(sys.argv[2]) if len(sys.argv) > 2 else 400
code = pe.get_data(rva, n * 8)
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
for i, ins in enumerate(md.disasm(code, rva)):
    note = ""
    if ins.mnemonic in ("call", "jmp") and ins.op_str.startswith("0x"):
        t = int(ins.op_str, 16); note = names.get(t, "")
    print(f"{ins.address:08x}  {ins.mnemonic:6} {ins.op_str:40} {note}")
    if ins.mnemonic in ("ret", "int3") and i > 20 and ins.mnemonic == "int3": break
    if i >= n: break
