"""Compile-check the Frida agent bundle and the launcher.

usage: python -I scripts/build_agent.py [agent/src/trainer.ts]
Prints `errors: []` and exits 0 when both compile; otherwise prints each error and exits 1.
"""
import os
import py_compile
import sys

import frida

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
entry = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "agent", "src", "trainer.ts"))

errors = []
compiler = frida.Compiler()
compiler.on("diagnostics", lambda diags: errors.extend(
    f"{d['file']['path']}:{d['file']['line']}: {d['text']}" for d in diags if d.get("category") == "error"))
try:
    compiler.build(entry, project_root=os.path.join(ROOT, "agent"))
except frida.InvalidArgumentError:
    if not errors:
        errors.append(f"{entry}: compilation failed")

# The launcher is part of every shipped change, so a syntax error there must fail the build too.
try:
    py_compile.compile(os.path.join(ROOT, "moon_trainer.py"), doraise=True)
except py_compile.PyCompileError as e:
    errors.append(str(e).strip())

for e in errors:
    print(e)
print("errors:", "[]" if not errors else len(errors))
sys.exit(1 if errors else 0)
