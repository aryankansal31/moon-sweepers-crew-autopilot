import "frida-il2cpp-bridge";

// Read-only: log where money comes from. Doubles are passed in xmm registers on x64; read them
// from the CPU context. CreditLaunch(double payload, double stored) -> bool, LaunchWorth(double)
// -> Decimal (returned via hidden pointer in rdx), PaySection(int region, string cleaner),
// TryLaunchDustWorth(double capacity, Decimal worth), TeamWallet.set_Item(string, Decimal).
Il2Cpp.perform(() => {
    const game = Il2Cpp.domain.assembly("Assembly-CSharp").image;
    const World = game.class("MoonCleaners.MoonWorld");
    const Dec = Il2Cpp.corlib.class("System.Decimal");
    const dec = (p: NativePointer) => Dec.method<number>("ToDouble").invoke(new Il2Cpp.ValueType(p, Dec.type));
    const xmm = (ctx: CpuContext, i: number) => {
        const c = ctx as any;
        return c[`xmm${i}`] ? new Float64Array(c[`xmm${i}`])[0] : NaN;
    };
    const log = (s: string) => send(`${new Date().toISOString().slice(11, 19)} ${s}`);
    Interceptor.attach(World.method("CreditLaunch").virtualAddress, {
        onEnter() { this.args = `payload ${xmm(this.context, 1).toFixed(3)} stored ${xmm(this.context, 2).toFixed(3)}`; },
        onLeave(r) { log(`CreditLaunch(${this.args}) -> ${r.toInt32() & 0xff}`); },
    });
    Interceptor.attach(World.method("TryLaunchDustWorth").virtualAddress, {
        onEnter(a) { log(`TryLaunchDustWorth(capacity ${xmm(this.context, 1).toFixed(3)}, worth $${dec(a[2]).toFixed(4)})`); },
    });
    Interceptor.attach(World.method("PaySection").virtualAddress, {
        onEnter(a) { log(`PaySection(region ${a[1].toInt32()})`); },
    });
    Interceptor.attach(World.nested("TeamWallet").method("set_Item").virtualAddress, {
        onEnter(a) { log(`wallet[${new Il2Cpp.String(a[1]).content}] = $${dec(a[2]).toFixed(4)}`); },
    });
    log("watching money");
});
