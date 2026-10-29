import "frida-il2cpp-bridge";

// Read-only: log the arguments of the game's own MoonWorld.CleanToolStroke calls (robots, brushes).
// x64 IL2CPP: rcx = this, rdx/r8/r9 = &from/&to/&fromRight, then on the stack: &toRight, width,
// depth, dose, edge, &push, inventoryId, vehicleStorageId, MethodInfo.
Il2Cpp.perform(() => {
    const World = Il2Cpp.domain.assembly("Assembly-CSharp").image.class("MoonCleaners.MoonWorld");
    const addr = World.method("CleanToolStroke").virtualAddress;
    const v3 = (p: NativePointer) => [p.readFloat(), p.add(4).readFloat(), p.add(8).readFloat()].map(n => n.toFixed(3)).join(",");
    const str = (p: NativePointer) => p.isNull() ? "null" : `"${new Il2Cpp.String(p).content}"`;
    let n = 0;
    Interceptor.attach(addr, {
        onEnter(args) {
            if (n >= 12) return;
            const sp = (this.context as X64CpuContext).rsp;
            const arg = (i: number) => sp.add(0x28 + 8 * (i - 4));  // i = 0-based arg index after this
            this.log = `from ${v3(args[1])} to ${v3(args[2])} fromRight ${v3(args[3])} toRight ${v3(arg(4).readPointer())} ` +
                `width ${arg(5).readFloat().toFixed(3)} depth ${arg(6).readFloat().toFixed(3)} dose ${arg(7).readFloat().toFixed(3)} ` +
                `edge ${arg(8).readFloat().toFixed(3)} push ${v3(arg(9).readPointer())} inv ${str(arg(10).readPointer())} veh ${str(arg(11).readPointer())}`;
        },
        onLeave(ret) {
            if (n >= 12 || !this.log) return;
            n++;
            send(`${this.log} -> ${ret.toInt32()}`);
        },
    });
    send("watching CleanToolStroke");
});
