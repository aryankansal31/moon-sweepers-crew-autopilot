"""Attach the read-only raise watcher to the live game (pid from status.json) for N seconds."""
import json, os, sys, time, frida
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 600
c = frida.Compiler()
c.on("diagnostics", lambda ds: [print("[compile]", d["file"]["line"], d["text"], flush=True) for d in ds if d.get("category") == "error"])
bundle = c.build(os.path.join(ROOT, "agent", "src", "raise-watch.ts"), project_root=os.path.join(ROOT, "agent"))
pid = json.load(open(os.path.join(ROOT, "status.json")))["pid"]
s = frida.attach(pid).create_script(bundle)
s.on("message", lambda m, d: print(time.strftime("%H:%M:%S"), m.get("payload", m.get("stack") or m.get("description")), flush=True))
s.load()
time.sleep(seconds)
s.unload()
