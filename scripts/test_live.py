"""Attach the trainer to a running game and exercise RPC: tick rate, timeScale override, state."""
import os, sys, time, frida
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
c = frida.Compiler()
bundle = c.build(os.path.join(ROOT, "agent", "src", "trainer.ts"), project_root=os.path.join(ROOT, "agent"))
pid = next(p.pid for p in frida.get_local_device().enumerate_processes() if p.name.lower() == "moonsweepers.exe")
s = frida.attach(pid).create_script(bundle)
s.on("message", lambda m, d: print("[msg]", m.get("payload", m)))
s.load()
api = s.exports_sync
time.sleep(2)
st = api.get_status(); print("status", st)
t0 = st["ticks"]; time.sleep(2); print("ticks/sec ~", (api.get_status()["ticks"] - t0) / 2)
patch = eval(sys.argv[1]) if len(sys.argv) > 1 else {"timeScale": 3}
api.set_config(patch); time.sleep(2)
print("after", patch, api.get_status())
api.set_config({"timeScale": 1}); time.sleep(1)
print("reset", api.get_status())
