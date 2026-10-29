import "frida-il2cpp-bridge";

// Runtime dump of non-engine assemblies: works regardless of global-metadata version.
const SKIP = /^(mscorlib|System|Mono\.|UnityEngine|Unity\.|netstandard|Steamworks|Newtonsoft|DOTween|Il2Cpp)/;

Il2Cpp.perform(() => {
    send({ type: "info", unity: Il2Cpp.unityVersion, assemblies: Il2Cpp.domain.assemblies.map(a => a.name) });
    for (const asm of Il2Cpp.domain.assemblies) {
        const full = !SKIP.test(asm.name);
        let buf = `// ===== Assembly: ${asm.name}\n`;
        for (const klass of asm.image.classes) {
            try {
                buf += full ? `${klass.toString()}\n\n` : `// ${klass.type.name}\n`;
            } catch (e) {
                buf += `// <error dumping ${klass.name}: ${e}>\n`;
            }
            if (buf.length > 1_000_000) { send({ type: "chunk", asm: asm.name, data: buf }); buf = ""; }
        }
        send({ type: "chunk", asm: asm.name, data: buf });
    }
    send({ type: "done" });
});
