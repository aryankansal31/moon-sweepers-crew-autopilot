import os, time, frida
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bundle = frida.Compiler().build(os.path.join(ROOT, "agent", "src", "trainer.ts"), project_root=os.path.join(ROOT, "agent"))
pid = next(p.pid for p in frida.get_local_device().enumerate_processes() if p.name.lower() == "moonsweepers.exe")
s = frida.attach(pid).create_script(bundle)
s.on("message", lambda m, d: print("[msg]", m.get("payload", m.get("stack") or m.get("description"))))
s.load(); api = s.exports_sync
api.set_config({"autoSell": True, "robotMult": 3, "timeScale": 2})
time.sleep(3)
print("depositNow ->", api.deposit_now())
time.sleep(2)
print("status", api.get_status())
