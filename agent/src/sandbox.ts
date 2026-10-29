import "frida-il2cpp-bridge";

// Sandbox isolation for a second, development copy of the game. Loaded by scripts/sandbox.py into a
// *spawned, still suspended* process, so these hooks are in place before the game runs any code.
//
// Rather than only hooking MoonSaveSlots.get_Folder, every Win32 file call whose path is under the
// game's persistent data folder is rewritten into the sandbox folder. That also covers what
// get_Folder can't: session.running / session.last (crash detection), Crash reports, Player.log,
// and anything Unity's native side writes. The game's PlayerPrefs registry key is redirected the
// same way, so the sandbox never changes Aryan's settings.
//
// Any write that still names the live folder is reported as an "audit" message; the sandbox's
// acceptance check requires there to be none.

interface Init { liveRoot: string; sandboxRoot: string; liveRegKey: string; sandboxRegKey: string }

let cfg: Init | null = null;
let redirected = 0;

const plain = (p: string) => p.replace(/\//g, "\\").replace(/^\\\\\?\\/, "");
const norm = (p: string) => plain(p).toLowerCase();

function rewrite(path: string): string | null {
    if (!cfg) return null;
    const n = norm(path);
    const live = norm(cfg.liveRoot);
    if (n !== live && !n.startsWith(live + "\\")) return null;
    return cfg.sandboxRoot + plain(path).slice(cfg.liveRoot.length);
}

const WRITE_FNS = new Set(["CreateFileW", "CreateFile2", "CreateDirectoryW", "RemoveDirectoryW", "DeleteFileW",
    "MoveFileExW", "MoveFileWithProgressW", "ReplaceFileW", "CopyFileW", "CopyFile2", "SetFileAttributesW"]);

// export name -> indices of its path arguments
const PATH_FNS: Record<string, number[]> = {
    CreateFileW: [0], CreateFile2: [0], CreateDirectoryW: [0], RemoveDirectoryW: [0], DeleteFileW: [0],
    MoveFileExW: [0, 1], MoveFileWithProgressW: [0, 1], ReplaceFileW: [0, 1, 2], CopyFileW: [0, 1], CopyFile2: [0, 1],
    FindFirstFileW: [0], FindFirstFileExW: [0], GetFileAttributesW: [0], GetFileAttributesExW: [0],
    SetFileAttributesW: [0],
};

function hookPaths(mod: Module) {
    for (const [name, idxs] of Object.entries(PATH_FNS)) {
        const addr = mod.findExportByName(name);
        if (!addr) continue;
        Interceptor.attach(addr, {
            onEnter(args) {
                const keep: NativePointer[] = [];
                for (const i of idxs) {
                    if (args[i].isNull()) continue;
                    const path = args[i].readUtf16String();
                    if (!path) continue;
                    const to = rewrite(path);
                    if (to) {
                        const p = Memory.allocUtf16String(to);
                        keep.push(p);
                        args[i] = p;
                        redirected++;
                    } else if (cfg && WRITE_FNS.has(name) && norm(path).includes(norm(cfg.liveRoot))) {
                        send({ type: "audit", fn: name, path });
                    }
                }
                (this as any).keep = keep;  // keep replacement strings alive for the duration of the call
            },
        });
    }
}

function hookRegistry(mod: Module) {
    // RegOpenKeyExW(hKey, lpSubKey, ...) and RegCreateKeyExW(hKey, lpSubKey, ...)
    for (const name of ["RegOpenKeyExW", "RegCreateKeyExW"]) {
        const addr = mod.findExportByName(name);
        if (!addr) continue;
        Interceptor.attach(addr, {
            onEnter(args) {
                if (!cfg || args[1].isNull()) return;
                const sub = args[1].readUtf16String();
                if (!sub || !sub.toLowerCase().startsWith(cfg.liveRegKey.toLowerCase())) return;
                const p = Memory.allocUtf16String(cfg.sandboxRegKey + sub.slice(cfg.liveRegKey.length));
                (this as any).keep = p;
                args[1] = p;
            },
        });
    }
}

rpc.exports = {
    init(c: Init) {
        cfg = c;
        const kb = Process.getModuleByName("kernelbase.dll");
        hookPaths(kb);
        hookRegistry(kb);
        return { pid: Process.id };
    },
    // After resume, once the IL2CPP runtime is up: mute the sandbox. Best-effort; the game already
    // keeps running unfocused (MoonFramePacing.BackgroundRate), and this build strips
    // Application.set_runInBackground.
    settle() {
        return Il2Cpp.perform(() => Il2Cpp.mainThread.schedule(() => {
            try {
                const audio = Il2Cpp.domain.assembly("UnityEngine.AudioModule").image;
                audio.class("UnityEngine.AudioListener").method("set_volume").invoke(0);
                return "muted";
            } catch (e) {
                return `not muted: ${e}`;
            }
        }));
    },
    stats: () => ({ redirected }),
};
