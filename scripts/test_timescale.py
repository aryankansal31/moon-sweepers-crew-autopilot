import os, time, frida, subprocess, sys, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
build = lambda n: frida.Compiler().build(os.path.join(ROOT, "agent", "src", n), project_root=os.path.join(ROOT, "agent"))
pid = next(p.pid for p in frida.get_local_device().enumerate_processes() if p.name.lower() == "moonsweepers.exe")
sess = frida.attach(pid)
tr = sess.create_script(build("trainer.ts")); tr.load()
pr = sess.create_script(build("probe.ts")); pr.load(); time.sleep(1)
for scale in (1, 3):
    tr.exports_sync.set_config({"timeScale": scale}); time.sleep(1.5)
    a = pr.exports_sync.snapshot(); time.sleep(4); b = pr.exports_sync.snapshot()
    print(f"timeScale {scale}: game seconds per real second = {(b['time']-a['time'])/(b['wall']-a['wall']):.2f}")
tr.exports_sync.set_config({"timeScale": 1}); time.sleep(1)
