import "frida-il2cpp-bridge";

// Read-only watcher: logs every landmark raise attempt, its result and reason, and wallet writes.
Il2Cpp.perform(() => {
    const game = Il2Cpp.domain.assembly("Assembly-CSharp").image;
    const World = game.class("MoonCleaners.MoonWorld");
    const Wallet = World.nested("TeamWallet");
    const tryRaise = World.method("TryRaiseLandmark", 3).virtualAddress;
    const mark = World.method("MarkLandmarkRaised", 2).virtualAddress;
    const setItem = Wallet.method("set_Item", 2).virtualAddress;
    const str = (p: NativePointer) => p.isNull() ? "<null>" : new Il2Cpp.String(p).content;

    Interceptor.attach(tryRaise, {
        onEnter(a) { this.index = a[2].toInt32(); this.player = str(a[1]); this.reason = a[3]; },
        onLeave(r) {
            const reasonPtr = (this.reason as NativePointer).readPointer();
            send(`TryRaiseLandmark(player=${this.player}, index=${this.index}) -> ${r.toInt32() & 0xff ? "true" : "false"} reason="${str(reasonPtr)}"`);
        },
    });
    Interceptor.attach(mark, { onEnter(a) { send(`MarkLandmarkRaised(index=${a[1].toInt32()}, player=${str(a[2])})`); } });
    Interceptor.attach(setItem, { onEnter(a) { send(`TeamWallet.set_Item(player=${str(a[1])})`); } });
    send("watching");
});
