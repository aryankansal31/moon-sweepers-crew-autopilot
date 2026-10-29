"""usage: probe.py [--sandbox | --live | --pid N] <rpc> [<rpc> ...]   e.g. probe.py --sandbox startShift snapshot

Targets the sandbox game by default (sandbox/pid). --live targets Aryan's game via the pid in the
main checkout's status.json: use it only for read-only RPCs.
"""
import os, sys, time, json, frida
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
argv = sys.argv[1:]
if "--pid" in argv:
    i = argv.index("--pid"); pid = int(argv[i + 1]); del argv[i:i + 2]
elif "--live" in argv:
    argv.remove("--live")
    main_root = os.path.dirname(os.path.dirname(os.path.dirname(ROOT))) if ".claude" in ROOT else ROOT
    pid = json.load(open(os.path.join(main_root, "status.json")))["pid"]
else:
    if "--sandbox" in argv:
        argv.remove("--sandbox")
    pid = int(open(os.path.join(ROOT, "sandbox", "pid")).read())
compiler = frida.Compiler()
compiler.on("diagnostics", lambda ds: [print("[compile]", d["file"]["line"], d["text"]) for d in ds if d.get("category") == "error"])
bundle = compiler.build(os.path.join(ROOT, "agent", "src", "probe.ts"), project_root=os.path.join(ROOT, "agent"))
s = frida.attach(pid).create_script(bundle)
s.on("message", lambda m, d: print("[msg]", m.get("payload", m.get("description"))))
s.load(); time.sleep(1)
ARGS = [a for a in argv if not a.startswith("0x")]
RVAS = [a[2:] for a in argv if a.startswith("0x")]
if RVAS: print(json.dumps(s.exports_sync.resolve(RVAS), indent=1))
for cmd in ARGS:
    if cmd.startswith("sleep"):
        time.sleep(float(cmd[5:])); continue
    name, _, arg = cmd.partition(":")
    fn = getattr(s.exports_sync, name)
    print(cmd, "->", json.dumps(fn(arg.split(",")) if arg else fn(), indent=1))
