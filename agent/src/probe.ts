import "frida-il2cpp-bridge";
import { HelperBody, NAMES } from "./crew/body.ts";
import { add, cross, dist, norm, scale, sub, tangent, type Vec3 } from "./crew/vec.ts";
import { callDecimal, decimal, decimalValue, enumValue, positionOf, surfacePoint, toVec3, valueType as crewValueType, vector3 } from "./crew/unity.ts";
import * as crewWorld from "./crew/world.ts";
import { CrewWindow } from "./crew/window.ts";
import { crewWindowModel } from "./crew/window-model.ts";
import { HireStore, type HelperKind } from "./crew/hires.ts";
import { hireHelper } from "./crew/hiring.ts";
import { Navigator } from "./crew/nav.ts";

// Test-only helper: drive the game from outside (start shift, read player state).
let game: Il2Cpp.Image;
const cls = (n: string) => game.class(`MoonCleaners.${n}`);
// Errors are returned as text: a throw inside mainThread.schedule never settles the RPC (the probe hung).
const main = <T>(f: () => T) => Il2Cpp.perform(() => Il2Cpp.mainThread.schedule(() => {
    try { return f(); } catch (e) { return `ERROR ${(e as Error)?.stack ?? e}` as unknown as T; }
}));

function snapshot() {
    const Session = cls("MoonSession");
    const out: Record<string, unknown> = {
        inGame: Session.method<boolean>("get_InGame").invoke(),
        loading: Session.method<boolean>("get_Loading").invoke(),
        time: Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Time").method<number>("get_time").invoke(),
        wall: Date.now() / 1000,
    };
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    if (walker.isNull()) return out;
    const inv = walker.field<Il2Cpp.Object>("upgradeAccount").value;
    if (!inv.isNull()) {
        out.kg = inv.method<number>("get_Kilograms").invoke();
        out.capacityKg = inv.method<number>("get_CapacityKg").invoke();
        out.full = inv.method<boolean>("get_IsFull").invoke();
        out.money = inv.method("get_Money").invoke()!.toString();
        const pid = inv.field<Il2Cpp.String>("playerId").value;
        const world = inv.method<Il2Cpp.Object>("get_World").invoke();
        out.playerId = pid.content;
        if (!world.isNull()) {
            for (const m of ["MoveSpeedMultiplier", "CleaningWidthMultiplier", "ContainerCapacityMultiplier", "DepositTimeMultiplier"])
                out[m] = world.method<number>(m, 1).invoke(pid);
        }
    }
    const st = cls("MoonDustStation").field<Il2Cpp.Object>("stations").value;
    out.stations = st.isNull() ? 0 : st.method<number>("get_Count").invoke();
    if (!st.isNull() && (out.stations as number) > 0) {
        const s0 = st.method<Il2Cpp.Object>("get_Item").invoke(0);
        out.tray = s0.method<number>("get_TrayKilograms").invoke();
        out.stored = s0.method<number>("get_StoredKilograms").invoke();
    }
    const rb = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
    out.robots = rb.isNull() ? 0 : rb.method<number>("get_Count").invoke();
    const pos = walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke();
    out.pos = pos.toString();
    return out;
}

rpc.exports = {
    snapshot: () => main(snapshot),
    startShift: () => main(() => { cls("MoonSession").method("StartShift").invoke(); return true; }),
    quit: () => main(() => { cls("MoonSession").method("QuitGame").invoke(); return true; }),
    returnToMenu: () => main(() => { cls("MoonSession").method("ReturnToMenu").invoke(); return true; }),
};

Il2Cpp.perform(() => { game = Il2Cpp.domain.assembly("Assembly-CSharp").image; send("probe ready"); });

// Map GameAssembly RVAs to method names across every loaded assembly.
rpc.exports.resolve = (rvas: string[]) => Il2Cpp.perform(() => {
    const base = Process.getModuleByName("GameAssembly.dll").base;
    const want = new Set(rvas.map(r => parseInt(r, 16)));
    const out: Record<string, string> = {};
    for (const a of Il2Cpp.domain.assemblies) for (const k of a.image.classes) for (const m of k.methods) {
        if (m.virtualAddress.isNull()) continue;
        const rva = m.virtualAddress.sub(base).toInt32();
        if (want.has(rva)) out[rva.toString(16)] = `${k.type.name}::${m.name}`;
    }
    return out;
});

// Read-only view of every active robot vacuum.
rpc.exports.robots = () => main(() => {
    const list = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
    const out: Record<string, unknown>[] = [];
    if (list.isNull()) return out;
    const n = list.method<number>("get_Count").invoke();
    for (let i = 0; i < n; i++) {
        const r = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const o: Record<string, unknown> = {};
        for (const f of ["state", "waitingAs", "cleaningSpeed", "travelSpeed", "acceleration", "turnRate", "speed",
                         "capacityKilograms", "unloadKilogramsPerSecond", "cleaningWidth", "laneIndex", "round",
                         "<Recoveries>k__BackingField", "<HexesDone>k__BackingField", "detourUntil", "progressSince", "owed"]) {
            try { o[f] = String(r.field(f).value); } catch (e) { o[f] = `?${e}`; }
        }
        for (const m of ["get_StatusText", "get_Sweeping", "get_Travelling", "get_AreaClean", "get_DustKilograms"]) {
            try { const v = r.method(m).invoke(); o[m] = v instanceof Il2Cpp.String ? v.content : String(v); } catch (e) { o[m] = `?${e}`; }
        }
        try { o.waitReason = r.field<Il2Cpp.String>("waitReason").value.content; } catch (e) { }
        out.push(o);
    }
    return out;
});

// Read-only: shop prices for calibrating new offers.
rpc.exports.prices = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const out: Record<string, unknown> = {};
    if (walker.isNull()) return out;
    const world = walker.field<Il2Cpp.Object>("world").value;
    const cat = world.method<Il2Cpp.Object>("get_UpgradeCatalog").invoke();
    const tools = cat.field<Il2Cpp.Array<Il2Cpp.Object>>("tools").value;
    out.tools = Array.from(tools).map(t => `${t.field<Il2Cpp.Object>("tool").value.field<Il2Cpp.String>("displayName").value.content}: $${t.field("purchaseDollars").value}`);
    const garage: string[] = [];
    for (let v = 0; v < 8; v++) {
        try {
            const o = cls("MoonWorld").method<Il2Cpp.Object>("GarageOfferFor").invoke(v);
            if (o.isNull()) continue;
            garage.push(`${v}: $${o.field("price").value} ${o.field<Il2Cpp.String>("summary").value.content}`);
        } catch (e) { break; }
    }
    out.garage = garage;
    const inv = walker.field<Il2Cpp.Object>("upgradeAccount").value;
    out.money = inv.method("get_Money").invoke()!.toString();
    return out;
});

// Read-only: compare each robot's own bin size with the world's storage record for it.
rpc.exports.robotStorage = () => main(() => {
    const list = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
    const out: string[] = [];
    if (list.isNull()) return out;
    for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
        const r = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const world = r.field<Il2Cpp.Object>("world").value;
        const id = r.field<Il2Cpp.String>("storageId").value;
        out.push(`${id.content}: robot cap ${r.field("capacityKilograms").value}, world cap ${world.method("VehicleDustCapacity").invoke(id)}, holds ${r.method("get_DustKilograms").invoke()}`);
    }
    return out;
});

// Sync the world's storage record to each robot's own bin size.
rpc.exports.fitRobotStorage = () => main(() => {
    const list = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
    const out: string[] = [];
    for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
        const r = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const world = r.field<Il2Cpp.Object>("world").value;
        const id = r.field<Il2Cpp.String>("storageId").value;
        world.method("FitVehicleCapacity").invoke(id, r.field<number>("capacityKilograms").value);
        out.push(`${id.content}: world cap now ${world.method("VehicleDustCapacity").invoke(id)}`);
    }
    return out;
});

// Read-only: every robot dock in the world, whether its robot is live, and distance to the player.
rpc.exports.docks = () => main(() => {
    const Dock = cls("MoonRobotDock");
    const list = Dock.method<Il2Cpp.Object>("get_All").invoke();
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const wp = walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke();
    const n = list.method<number>("get_Count").invoke();
    const out: string[] = [`docks: ${n}`];
    for (let i = 0; i < n; i++) {
        const d = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const dp = d.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke();
        const dist = Math.sqrt(["x", "y", "z"].reduce((s, a) => s + ((dp.field<number>(a).value as number) - (wp.field<number>(a).value as number)) ** 2, 0));
        const robot = d.method<Il2Cpp.Object>("get_Robot").invoke();
        let line = `dock ${d.method("get_DockId").invoke()} owner=${d.method<Il2Cpp.String>("get_Owner").invoke().content} dist=${dist.toFixed(0)}m stored=${(d.method<number>("get_StoredKilograms").invoke()).toFixed(1)}kg full=${d.method("get_Full").invoke()} status="${d.method<Il2Cpp.String>("get_Status").invoke().content}" robot=${robot.isNull() ? "none" : "live"}`;
        if (!robot.isNull()) line += ` robotState=${robot.field("state").value} enabled=${robot.method("get_isActiveAndEnabled").invoke()} holds=${(robot.method<number>("get_DustKilograms").invoke()).toFixed(1)}`;
        out.push(line);
    }
    const active = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
    out.push(`active list: ${active.isNull() ? 0 : active.method("get_Count").invoke()}`);
    return out;
});

// Read-only: landmark totals, raised counts, rewards, and a sample.
rpc.exports.landmarks = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const Kind = cls("MoonLandmarkKind");
    const out: Record<string, unknown> = {
        inPlay: world.method("get_LandmarksInPlay").invoke(),
        total: world.method("get_LandmarkCount").invoke(),
        raised: world.method("get_RaisedLandmarkCount").invoke(),
    };
    const n = world.method<number>("get_LandmarkCount").invoke();
    const sample: string[] = [];
    let flags = 0, sites = 0, raisedFlags = 0, raisedSites = 0;
    for (let i = 0; i < n; i++) {
        const l = world.method<Il2Cpp.Object>("Landmark").invoke(i);
        const site = l.method<boolean>("get_IsSite").invoke();
        const up = world.method<boolean>("IsLandmarkRaised").invoke(i);
        if (site) { sites++; if (up) raisedSites++; } else { flags++; if (up) raisedFlags++; }
        if (i < 4 || (site && sample.length < 8)) sample.push(`${i} ${site ? "site" : "flag"} "${l.field<Il2Cpp.String>("name").value.content}" lat=${l.field("latitude").value} lon=${l.field("longitude").value} raised=${up}`);
    }
    Object.assign(out, { flags, sites, raisedFlags, raisedSites, sample });
    return out;
});

// Read-only: check LandmarkDirection * |player| lines up with spawned flag views.
rpc.exports.landmarkGeo = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const v = (o: Il2Cpp.ValueType) => ["x", "y", "z"].map(a => o.field<number>(a).value as number);
    const pos = (c: Il2Cpp.Object) => v(c.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke());
    const wt = pos(world);
    const p = pos(walker);
    const out: string[] = [`world origin ${wt.map(n => n.toFixed(1))} player ${p.map(n => n.toFixed(1))} |p|=${Math.hypot(...p).toFixed(1)}`];
    const views = Il2Cpp.gc.choose(cls("MoonLandmarkFlag")).slice(0, 4);
    for (const f of views) {
        const i = f.method<number>("get_Index").invoke();
        const d = v(world.method<Il2Cpp.ValueType>("LandmarkDirection").invoke(i));
        const fp = pos(f);
        out.push(`flag ${i}: view ${fp.map(n => n.toFixed(1))} |view|=${Math.hypot(...fp).toFixed(1)} dir ${d.map(n => n.toFixed(4))} |dir|=${Math.hypot(...d).toFixed(3)} dir*|view| ${d.map(n => (n * Math.hypot(...fp)).toFixed(1))}`);
    }
    return out;
});

rpc.exports.worldFrame = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const q = world.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_rotation").invoke();
    const d = world.method<Il2Cpp.ValueType>("LandmarkDirection").invoke(0);
    return { rotation: q.toString(), dir0: d.toString(),
             norm: Math.hypot(...["x", "y", "z"].map(a => d.field<number>(a).value as number)) };
});

// Read-only: same nearest-unraised calculation as trainer.ts updateLandmarks, top 3.
rpc.exports.nearestLandmarks = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const p = walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke();
    const [x, y, z] = ["x", "y", "z"].map(a => p.field<number>(a).value as number);
    const r = Math.hypot(x, y, z);
    const rows: [number, string][] = [];
    for (let i = 0; i < world.method<number>("get_LandmarkCount").invoke(); i++) {
        if (world.method<boolean>("IsLandmarkRaised").invoke(i)) continue;
        const d = world.method<Il2Cpp.ValueType>("LandmarkDirection").invoke(i);
        const dot = ((d.field<number>("x").value as number) * x + (d.field<number>("y").value as number) * y + (d.field<number>("z").value as number) * z) / r;
        const l = world.method<Il2Cpp.Object>("Landmark").invoke(i);
        rows.push([Math.acos(Math.max(-1, Math.min(1, dot))) * r, `${l.field<Il2Cpp.String>("name").value.content} (${l.method("get_IsSite").invoke() ? "site" : "flag"})`]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    return rows.slice(0, 3).map(([m, n]) => `${n}: ${m.toFixed(0)} m`);
});

// Read-only: spawned landmark views vs world raised state.
rpc.exports.landmarkViews = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const wp = walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke();
    const v = (o: Il2Cpp.ValueType) => ["x", "y", "z"].map(a => o.field<number>(a).value as number);
    const [px, py, pz] = v(wp);
    const out: string[] = [];
    for (const name of ["MoonLandmarkFlag", "MoonLunarSite"]) {
        for (const view of Il2Cpp.gc.choose(cls(name))) {
            try {
                const i = view.method<number>("get_Index").invoke();
                const p = v(view.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke());
                const l = world.method<Il2Cpp.Object>("Landmark").invoke(i);
                out.push(`${name} #${i} "${l.field<Il2Cpp.String>("name").value.content}" dist=${Math.hypot(p[0]-px, p[1]-py, p[2]-pz).toFixed(0)}m viewRaised=${view.method("get_Raised").invoke()} worldRaised=${world.method("IsLandmarkRaised").invoke(i)}`);
            } catch (e) { out.push(`${name}: ${e}`); }
        }
    }
    const inter = Il2Cpp.gc.choose(cls("MoonLandmarkInteraction"));
    out.push(`interactions: ${inter.length}`);
    return out;
});

// Count live instances two ways (GC scan vs Unity's own registry).
rpc.exports.countObjects = (names: string[]) => main(() => {
    const Obj = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Object");
    const find = Obj.methods.find(m => m.name === "FindObjectsOfType" && m.parameterCount === 1 && !m.isGeneric);
    const out: string[] = [];
    for (const n of names) {
        const k = cls(n);
        let unity = "n/a";
        try { if (find) unity = String((find.invoke(k.type.object) as Il2Cpp.Array).length); } catch (e) { unity = `err ${e}`; }
        out.push(`${n}: gc=${Il2Cpp.gc.choose(k).length} unity=${unity}`);
    }
    return out;
});

// Where does GameAssembly keep the TypeInfo pointer for a class? (RVA of the metadata slot)
rpc.exports.typeInfoSlots = (names: string[]) => Il2Cpp.perform(() => {
    const mod = Process.getModuleByName("GameAssembly.dll");
    const out: Record<string, string[]> = {};
    for (const n of names) {
        const h = cls(n).handle;
        const bytes = [0, 1, 2, 3, 4, 5, 6, 7].map(i => h.shr(i * 8).and(0xff).toInt32().toString(16).padStart(2, "0")).join(" ");
        out[n] = Memory.scanSync(mod.base, mod.size, bytes).map(m => m.address.sub(mod.base).toString(16));
    }
    return out;
});

// Count how often a GameAssembly function runs over a window (read-only listener).
rpc.exports.countCalls = (args: string[]) => new Promise(resolve => {
    const [rvaHex, msText] = args;
    const base = Process.getModuleByName("GameAssembly.dll").base;
    let n = 0;
    const l = Interceptor.attach(base.add(parseInt(rvaHex, 16)), { onEnter() { n++; } });
    setTimeout(() => { l.detach(); resolve(`${rvaHex}: ${n} calls in ${msText} ms`); }, parseInt(msText, 10));
});

rpc.exports.landmarkRewards = () => main(() => {
    const W = cls("MoonWorld");
    const Kind = cls("MoonLandmarkKind");
    const flag = Kind.field<Il2Cpp.ValueType>("Flag").value;
    const site = Kind.field<Il2Cpp.ValueType>("Site").value;
    return { flag: String(W.method("LandmarkReward").invoke(flag)), site: String(W.method("LandmarkReward").invoke(site)) };
});

// Save-slot identity (Task 2): active slot, slot summary, FreshSave, and switching slots (sandbox only).
rpc.exports.slotInfo = () => main(() => {
    const S = cls("MoonSaveSlots");
    const active = S.method<number>("get_Active").invoke();
    const sum = S.method<Il2Cpp.Object>("Read").invoke(active);
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    let fresh: unknown = "n/a";
    if (!walker.isNull()) fresh = walker.field<Il2Cpp.Object>("world").value.method("get_FreshSave").invoke();
    return {
        active, folder: S.method<Il2Cpp.String>("SlotFolder").invoke(active).content, fresh,
        summary: sum.isNull() ? null : { playSeconds: sum.field("playSeconds").value, dollars: sum.field("dollars").value,
                                         lastPlayedTicks: String(sum.field("lastPlayedTicks").value) },
    };
});
// Task 4 debugging: run the spawn one piece at a time, catching errors so the promise resolves.
rpc.exports.bodyStep = (args: string[]) => main(() => {
    try {
        const step = args[0];
        const Demo = cls("MoonDemoCrew");
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        if (step === "vec") return vector3([1, 2, 3]).toString();
        if (step === "look") return Demo.method<Il2Cpp.Object>("Look").invoke(4, 1, 8).toString();
        if (step === "of") return Demo.method<Il2Cpp.Object>("Of").invoke(walker).toString();
        if (step === "act") return enumValue(Demo.nested("Act"), "Stand").toString();
        if (step === "add") {
            const crew = Demo.method<Il2Cpp.Object>("Of").invoke(walker);
            const m = crew.method<Il2Cpp.Object>("Add").invoke(Il2Cpp.string("Test"), Demo.method<Il2Cpp.Object>("Look").invoke(4, 1, 8),
                Il2Cpp.string("household_broom"), vector3(positionOf(walker)), vector3([0, 0, 1]), enumValue(Demo.nested("Act"), "Stand"));
            return `member ${m.handle} remote ${m.field<Il2Cpp.Object>("remote").value.handle}`;
        }
        return "unknown step";
    } catch (e) {
        return `ERROR ${e}\n${(e as Error).stack}`;
    }
});

// Task 4 sandbox check: spawn both helper bodies 5 m ahead of the player and walk them 20 m.
const testBodies: { kind: string; body: HelperBody; target: Vec3 }[] = [];
let testTick: InvocationListener | null = null;
rpc.exports.spawnTest = () => main(() => { try { return spawnTestBody(); } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; } });
function spawnTestBody() {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const t = walker.method<Il2Cpp.Object>("get_transform").invoke();
    const p = positionOf(walker);
    const f = toVec3(t.method<Il2Cpp.ValueType>("get_forward").invoke());
    const r = toVec3(t.method<Il2Cpp.ValueType>("get_right").invoke());
    for (const [i, kind] of (["sweeper", "hauler"] as const).entries()) {
        const start = add(add(p, scale(f, 5)), scale(r, i * 2));
        const target = surfacePoint(walker.field<Il2Cpp.Object>("world").value, add(start, scale(f, 20)));
        const body = HelperBody.spawn(walker, kind, start);
        body.setAct("Walk");
        body.walkTo(target, 1.4);
        testBodies.push({ kind, body, target });
    }
    // Drive update() from the per-frame tick like the crew manager will. (A setInterval that keeps
    // queueing Il2Cpp.mainThread.schedule jobs jams the scheduler and later RPCs never run.)
    testTick = Interceptor.attach(cls("MoonFramePacer").method("Update").virtualAddress, {
        onLeave() { for (const b of testBodies) { try { b.body.update(); } catch (e) { /* reported by spawnCheck */ } } },
    });
    return testBodies.map(b => ({ kind: b.kind, start: b.body.position.map(n => n.toFixed(1)), target: b.target.map(n => n.toFixed(1)) }));
}
rpc.exports.spawnCheck = () => main(() => testBodies.map(b => {
    const drawn = b.body.drawnPosition;
    const remote = b.body.remote;
    return {
        kind: b.kind, arrived: b.body.arrived,
        drawnToTarget: drawn ? dist(drawn, b.target).toFixed(2) : "no body",
        remote: remote.isNull() ? "none" : remote.handle.toString(),
        nameTag: remote.isNull() ? "" : remote.method<Il2Cpp.String>("get_DisplayName").invoke().content,
        expectedName: NAMES[b.kind as "sweeper" | "hauler"],
    };
}));
// One sample per body: computed (segment) point vs drawn (remote transform) point, and radii.
rpc.exports.spawnSample = () => main(() => testBodies.map(b => {
    const c = b.body.position, d = b.body.drawnPosition;
    const r = (v: Vec3) => Math.hypot(...v).toFixed(2);
    return `${b.kind}: computed→target ${dist(c, b.target).toFixed(2)} drawn→target ${d ? dist(d, b.target).toFixed(2) : "-"} drawn→computed ${d ? dist(d, c).toFixed(2) : "-"} |computed| ${r(c)} |drawn| ${d ? r(d) : "-"}`;
}));

// Task 4: what height is "the ground" at the player? player vs MeshGround vs SurfaceAt.
rpc.exports.surfaceProbe = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const p = positionOf(walker);
    const r = Math.hypot(...p);
    const dir = vector3(p.map(v => v / r) as Vec3);
    const out: Record<string, unknown> = { playerRadius: r.toFixed(2), grounded: walker.method("get_Grounded").invoke() };
    for (const m of world.class.methods.filter(m => m.name === "SurfaceAt" || m.name === "MeshGround")) {
        out[`${m.name}(${m.parameters.map(p => p.type.name).join(",")})`] = "seen";
    }
    try {
        const mg = world.method<Il2Cpp.ValueType>("MeshGround").invoke(dir);
        out.meshGroundRadius = Math.hypot(...toVec3(mg)).toFixed(2);
    } catch (e) { out.meshGround = `${e}`; }
    try {
        const up = Memory.alloc(12), onStructure = Memory.alloc(4);
        const s = world.method<Il2Cpp.ValueType>("SurfaceAt").invoke(dir, up, onStructure);
        out.surfaceAtRadius = Math.hypot(...toVec3(s)).toFixed(2);
        out.onStructure = onStructure.readU8();
    } catch (e) { out.surfaceAt = `${e}`; }
    return out;
});

// Read-only: where each helper is relative to the player, and what its segment looks like.
rpc.exports.crewWhere = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const player = surfacePoint(world, positionOf(walker));
    const list = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker).field<Il2Cpp.Object>("members").value;
    const out: string[] = [];
    for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
        const m = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const a = toVec3(m.field<Il2Cpp.ValueType>("position").value), b = toVec3(m.field<Il2Cpp.ValueType>("to").value);
        out.push(`${m.field<Il2Cpp.String>("name").value.content}: from-player ${dist(a, player).toFixed(1)} m, to-player ${dist(b, player).toFixed(1)} m, ` +
            `segment ${dist(a, b).toFixed(2)} m travelled ${(m.field<number>("travelled").value as number).toFixed(2)} speed ${m.field("speed").value} act ${m.field("act").value}`);
    }
    return out;
});

// Read-only: raw MoonDemoCrew member fields for every member on the local walker.
rpc.exports.demoMembers = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const crew = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker);
    const list = crew.field<Il2Cpp.Object>("members").value;
    const out: string[] = [`active ${crew.method("get_Active").invoke()} enabled ${crew.method("get_isActiveAndEnabled").invoke()}`];
    for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
        const m = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const v = (n: string) => toVec3(m.field<Il2Cpp.ValueType>(n).value);
        out.push(`${m.field<Il2Cpp.String>("name").value.content}: act ${m.field("act").value} speed ${m.field("speed").value} ` +
            `travelled ${(m.field<number>("travelled").value as number).toFixed(3)} seg ${dist(v("position"), v("to")).toFixed(3)} ` +
            `touching ${m.field("touching").value} dressed ${m.field("dressed").value}`);
    }
    return out;
});

// Sandbox only: move the player to fresh ground — a spot 300-900 m from the nearest station where
// the dirt sensor finds dust at 8 points around it (15 m out).
rpc.exports.moveToFresh = (args: string[]) => main(() => {
    const minDist = parseFloat((args ?? [])[0] ?? "0");
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const base = positionOf(crewWorld.stations()[0]);
        const up = norm(base);
        const e1 = norm(cross(up, [0, 0, 1])), e2 = norm(cross(up, e1));
        crewWorld.ensureHopper(world, "crew/test", 500);
        for (const d of [300, 450, 600, 750, 900, 1100, 1300].filter(x => x >= minDist)) for (let k = 0; k < 12; k++) {
            const ang = (k / 12) * 2 * Math.PI;
            const c = surfacePoint(world, add(base, add(scale(e1, Math.cos(ang) * d), scale(e2, Math.sin(ang) * d))));
            let dirty = 0;
            for (let j = 0; j < 8; j++) {
                const a2 = (j / 8) * 2 * Math.PI;
                const q = surfacePoint(world, add(c, add(scale(e1, Math.cos(a2) * 15), scale(e2, Math.sin(a2) * 15))));
                if (crewWorld.senseDirt(world, q, "crew/test") > 0) dirty++;
            }
            if (dirty === 8) {
                walker.method<Il2Cpp.Object>("get_transform").invoke().method("set_position").invoke(vector3(add(c, scale(norm(c), 1.5))));
                return `moved to fresh ground ${d} m from the station (bearing ${(ang * 180 / Math.PI).toFixed(0)}°)`;
            }
        }
        return "no fresh spot found";
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Try the crew-page design on the live shop, report which rows are drawn, then restore and close.
rpc.exports.crewPageTest = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const Shop = cls("MoonUpgradeShop");
    const shop = Shop.method<Il2Cpp.Object>("ForCamera").invoke(walker.field<Il2Cpp.Object>("viewCamera").value);
    const offers = shop.field<Il2Cpp.Object>("offers").value;
    const all = () => { const l: Il2Cpp.Object[] = []; for (let i = 0; i < offers.method<number>("get_Count").invoke(); i++) l.push(offers.method<Il2Cpp.Object>("get_Item").invoke(i)); return l; };
    const isCrew = (o: Il2Cpp.Object) => /^(Dusty|Hank) /.test(o.field<Il2Cpp.String>("name").value.content ?? "");
    const go = (o: Il2Cpp.Object) => { const r = o.field<Il2Cpp.Object>("row").value; return r.isNull() ? null : r.method<Il2Cpp.Object>("get_gameObject").invoke(); };
    const active = () => all().filter(o => go(o)?.method<boolean>("get_activeSelf").invoke()).map(o => `${o.field("kind").value}:${o.field<Il2Cpp.String>("name").value.content}`);
    const Cat = Shop.nested("Category");
    const report: Record<string, unknown> = {};
    shop.method("set_PrototypeTesting").invoke(true);
    if (!shop.method<boolean>("get_IsOpen").invoke()) shop.method("SetOpen").invoke(true);
    shop.method("OpenInventory").invoke(false);
    report.rowsBuilt = all().filter(o => go(o) !== null).length;
    for (const o of all()) if (isCrew(o)) o.field("category").value = enumValue(Cat, "Tools");
    shop.method("SelectCategory").invoke(enumValue(Cat, "Tools"));
    report.protoTools = active();
    for (const o of all()) if (!isCrew(o)) go(o)?.method("SetActive").invoke(false);
    report.hidden = active();
    shop.method("Refresh").invoke();
    report.afterRefresh = active();
    const dusty = all().find(o => /^Dusty/.test(o.field<Il2Cpp.String>("name").value.content ?? ""));
    if (dusty) shop.method("SelectOffer").invoke(dusty, true);
    const sel = shop.field<Il2Cpp.Object>("selectedOffer").value;
    report.selected = sel.isNull() ? null : sel.field<Il2Cpp.String>("name").value.content;
    report.category = String(shop.field("selectedCategory").value);
    // restore
    for (const o of all()) if (isCrew(o)) o.field("category").value = enumValue(Cat, "BaseEquipment");
    shop.method("SetOpen").invoke(false);
    shop.method("set_PrototypeTesting").invoke(false);
    report.closed = !shop.method<boolean>("get_IsOpen").invoke();
    return report;
});

// UI experiment: build a window with the game's own MoonWorkshopKit and leave it up (uiClose removes it).
function color(r: number, g: number, b: number, a = 1): Il2Cpp.ValueType {
    const c = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Color").alloc().unbox();
    c.field<number>("r").value = r; c.field<number>("g").value = g; c.field<number>("b").value = b; c.field<number>("a").value = a;
    return c;
}
rpc.exports.uiTest = () => main(() => {
    const Kit = cls("MoonWorkshopKit");
    const kit = Kit.alloc();
    kit.method(".ctor").invoke();
    const info: Record<string, unknown> = {
        fonts: ["head", "text", "caps"].map(f => { const v = kit.field<Il2Cpp.Object>(f).value; return v.isNull() ? null : v.method<Il2Cpp.String>("get_name").invoke().content; }),
    };
    const stage = kit.method<Il2Cpp.Object>("Stage").invoke(NULL as unknown as Il2Cpp.Object, Il2Cpp.string("CrewWindow"), 400, true);
    info.stage = stage.isNull() ? null : stage.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke().content;
    const root = kit.field<Il2Cpp.Object>("root").value;
    info.root = root.isNull() ? null : root.method<Il2Cpp.String>("get_name").invoke().content;
    const frame = kit.field<Il2Cpp.Object>("frame").value;
    const parent = (frame.isNull() ? stage : frame) as Il2Cpp.Object;
    const plate = kit.method<Il2Cpp.Object>("Plate").invoke(parent, Il2Cpp.string("CrewPlate"), 560, 240, 800, 560, true, true);
    const face = kit.field<Il2Cpp.Object>("head").value;
    const body = kit.field<Il2Cpp.Object>("text").value;
    const Align = Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TextAlignmentOptions");
    const left = Align.field<Il2Cpp.ValueType>("Left").value;
    kit.method("Text").invoke(plate, Il2Cpp.string("CREW"), 40, 30, 700, 70, 56, color(1, 0.95, 0.85), face, left);
    kit.method("Text").invoke(plate, Il2Cpp.string("Dusty the Sweeper  -  $450"), 40, 140, 700, 50, 34, color(0.27, 0.88, 0.94), body, left);
    kit.method("Text").invoke(plate, Il2Cpp.string("Hank the Hauler  -  $350"), 40, 220, 700, 50, 34, color(0.27, 0.88, 0.94), body, left);
    info.plate = plate.isNull() ? null : "ok";
    return info;
});
const crewWindow = new CrewWindow();
// Draw the real crew window with a sample state. args: [money, hired kinds joined by "+", message]
rpc.exports.crewWindow = (args: string[]) => main(() => {
    const [money, hired, message] = args ?? [];
    crewWindow.show(crewWindowModel({ hired: (hired ? hired.split("+") : []) as HelperKind[], money: parseFloat(money ?? "0"),
        inCrewSession: false, message: message ?? "" }));
    return "shown";
});
// Run the real hireHelper against an empty hire list (charges sandbox money). args: [kind]
rpc.exports.hireTest = (args: string[]) => main(() => {
    const world = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke().field<Il2Cpp.Object>("world").value;
    const wallet = () => callDecimal(world.class.method("WalletDollars"), world, Il2Cpp.string("local").handle);
    const store = new HireStore(null);
    const before = wallet();
    const first = hireHelper(world, args[0] as HelperKind, { store: () => store, gameKey: () => "probe/test", onHire: () => {} });
    const second = hireHelper(world, args[0] as HelperKind, { store: () => store, gameKey: () => "probe/test", onHire: () => {} });
    return { before, after: wallet(), first, second, hired: store.hired("probe/test") };
});
rpc.exports.uiCount = () => main(() => {
    const Obj = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Object");
    const GO = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.GameObject");
    const all = Obj.method<Il2Cpp.Array<Il2Cpp.Object>>("FindObjectsByType", 2);
    void all;
    let n = 0;
    for (const go of Il2Cpp.gc.choose(GO)) {
        try { if (go.method<Il2Cpp.String>("get_name").invoke().content === "CrewWindow") n++; } catch (e) { /* destroyed */ }
    }
    return n;
});
rpc.exports.uiClose = () => main(() => {
    const GO = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.GameObject");
    // The trainer names each window "CrewWindow#<n>"; older experiments used plain "CrewWindow".
    const found: string[] = [];
    for (const name of ["CrewWindow", ...Array.from({ length: 200 }, (_, i) => `CrewWindow#${i + 1}`)]) {
        const go = GO.method<Il2Cpp.Object>("Find").invoke(Il2Cpp.string(name));
        if (go.isNull()) continue;
        found.push(name);
        Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Object").method("Destroy", 1).invoke(go);
    }
    return found.length ? `destroyed ${found.join(" ")}` : "none";
});

// Storage state for crew ids, plus one 3 m test stroke ahead of the player into a given storage.
rpc.exports.storages = (args: string[]) => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const ids = ["crew/sweeper", "crew/sensor", "crew/hauler"];
    const read = () => Object.fromEntries(ids.map(id => [id,
        `${world.method<number>("VehicleDustKilograms").invoke(Il2Cpp.string(id)).toFixed(3)} / ${world.method<number>("VehicleDustCapacity").invoke(Il2Cpp.string(id))}`]));
    const out: Record<string, unknown> = { before: read() };
    if (args?.[0]) {
        const p = surfacePoint(world, positionOf(walker));
        const fwd = toVec3(walker.field<Il2Cpp.Object>("viewCamera").value.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_forward").invoke());
        const q = surfacePoint(world, add(p, scale(norm(fwd), 3)));
        out.cells = crewWorld.cleanStroke(world, p, q, 3, 2, 1, 0.05, args[0]);
        out.after = read();
    }
    return out;
});

// One 3 m stroke ahead of the player with an explicit inventoryId. args: [inventoryId, storageId, sideways m]
rpc.exports.strokeWith = (args: string[]) => main(() => {
    const [inv, storage, side] = args;
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const p0 = surfacePoint(world, positionOf(walker));
    const up = norm(p0);
    const fwd = norm(toVec3(walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_forward").invoke()));
    const right = norm(cross(up, fwd));
    const p = surfacePoint(world, add(p0, scale(right, parseFloat(side ?? "0"))));
    const q = surfacePoint(world, add(p, scale(fwd, 3)));
    const kg = () => world.method<number>("VehicleDustKilograms").invoke(Il2Cpp.string(storage));
    const before = kg();
    const heading = norm(sub(q, p));
    const r = norm(cross(norm(p), heading));
    const cells = world.method<number>("CleanToolStroke").invoke(vector3(p), vector3(q), vector3(r), vector3(r), 3, 2, 1, 0.05,
        vector3(heading), Il2Cpp.string(inv), Il2Cpp.string(storage));
    return { inv, storage, cells, kg: (kg() - before).toFixed(4) };
});

rpc.exports.selectSlot = (args: string[]) => main(() => {
    const belt = Il2Cpp.gc.choose(cls("MoonToolbelt"))[0];
    if (!belt) return "no toolbelt";
    const ok = belt.method<boolean>("SelectSlot").invoke(parseInt(args[0]));
    const tools: string[] = [];
    for (let i = 0; i < 6; i++) { const t = belt.method<Il2Cpp.Object>("ToolAtSlot").invoke(i); tools.push(t.isNull() ? "-" : t.method<Il2Cpp.String>("get_name").invoke().content ?? "?"); }
    return { ok, tools };
});

// Per helper: walking speed, whether it stands inside/under a building, distance from the player.
rpc.exports.crewNav = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const player = surfacePoint(world, positionOf(walker));
    const list = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker).field<Il2Cpp.Object>("members").value;
    const out: string[] = [`pace ${crewWorld.playerPace(world).toFixed(1)} m/s, player covered ${crewWorld.covered(player)}`];
    for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
        const m = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        const a = toVec3(m.field<Il2Cpp.ValueType>("position").value), b = toVec3(m.field<Il2Cpp.ValueType>("to").value);
        const t = m.field<number>("travelled").value as number, d = dist(a, b);
        const here = surfacePoint(world, d > 0 ? add(a, scale(norm(sub(b, a)), Math.min(t, d))) : a);
        out.push(`${m.field<Il2Cpp.String>("name").value.content}: speed ${(m.field<number>("speed").value as number).toFixed(1)}, ` +
            `covered ${crewWorld.covered(here)}, ${dist(here, player).toFixed(0)} m from player, act ${m.field("act").value}`);
    }
    return out;
});

// From the first helper's spot: what knee-height rays hit within 12 m in 8 directions (all hits, in order).
rpc.exports.raysFromHelper = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const m = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker).field<Il2Cpp.Object>("members").value
        .method<Il2Cpp.Object>("get_Item").invoke(0);
    const here = surfacePoint(world, toVec3(m.field<Il2Cpp.ValueType>("position").value));
    const physics = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image;
    const all = physics.class("UnityEngine.Physics").methods.find(x => x.name === "RaycastAll" && x.parameterCount === 5 &&
        x.parameters[0].type.name === "UnityEngine.Vector3")!;
    const trig = enumValue(physics.class("UnityEngine.QueryTriggerInteraction"), "Ignore");
    const up = norm(here);
    const e1 = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(up, e1);
    const origin = add(here, scale(up, 0.8));
    const out: string[] = [];
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        const dir = norm(add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a))));
        const hits = all.invoke(vector3(origin), vector3(dir), 12, -1, trig) as Il2Cpp.Array<Il2Cpp.ValueType>;
        const names: string[] = [];
        for (let j = 0; j < hits.length; j++) {
            const h = hits.get(j);
            const c = h.method<Il2Cpp.Object>("get_collider").invoke();
            names.push(`${h.method<number>("get_distance").invoke().toFixed(1)}:${c.isNull() ? "?" : c.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke().content}`);
        }
        out.push(`${i * 45}°: ${names.join(", ") || "clear"}  clearPath12=${crewWorld.clearPath(here, surfacePoint(world, add(here, scale(dir, 12))))}` +
            ` clearPath4.5=${crewWorld.clearPath(here, surfacePoint(world, add(here, scale(dir, 4.5))))}`);
    }
    return out;
});

// Plan a walk with the real Navigator + clearPath from the player's ground point to a point
// `range` m away at `deg` degrees, stepping to each waypoint. args: [deg, range]
rpc.exports.navPlan = (args: string[]) => main(() => {
    const deg = parseFloat(args[0]), range = parseFloat(args[1]);
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    let pos = surfacePoint(world, positionOf(walker));
    const up = norm(pos);
    const e1 = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(up, e1);
    const a = (deg * Math.PI) / 180;
    const goal = surfacePoint(world, add(pos, scale(add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a))), range)));
    const nav = new Navigator();
    const steps: string[] = [`direct clear: ${crewWorld.clearPath(pos, goal)}`];
    for (let i = 0; i < 25 && dist(pos, goal) > 1; i++) {
        const next = surfacePoint(world, nav.next(pos, goal, crewWorld.clearPath));
        steps.push(`${i}: ${next === goal || dist(next, goal) < 0.01 ? "goal" : "waypoint"} ${dist(pos, next).toFixed(1)} m, leg clear ${crewWorld.clearPath(pos, next)}, ${dist(next, goal).toFixed(1)} m left`);
        if (dist(next, pos) < 0.05) break;
        pos = dist(next, goal) < 13 && crewWorld.clearPath(next, goal) ? goal : next;
    }
    steps.push(`reached: ${dist(pos, goal) <= 1}`);
    return steps;
});

// Route through a station: from its approach point to 15 m beyond the station on the far side.
rpc.exports.navThroughStation = (args: string[]) => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const s = crewWorld.stations()[parseInt(args?.[0] ?? "0")];
    const centre = surfacePoint(world, positionOf(s));
    let pos = crewWorld.approachPoint(world, centre);
    const goal = surfacePoint(world, add(centre, scale(norm(sub(centre, pos)), parseFloat(args?.[1] ?? "35"))));
    const nav = new Navigator();
    const steps: string[] = [`start→goal ${dist(pos, goal).toFixed(1)} m, direct clear: ${crewWorld.clearPath(pos, goal)}, goal covered ${crewWorld.covered(goal)}`];
    for (let i = 0; i < 30 && dist(pos, goal) > 1; i++) {
        const next = surfacePoint(world, nav.next(pos, goal, crewWorld.clearPath));
        steps.push(`${i}: ${dist(pos, next).toFixed(1)} m, leg clear ${crewWorld.clearPath(pos, next)}, ${dist(next, goal).toFixed(1)} m left`);
        if (dist(next, pos) < 0.05) break;
        pos = next;
    }
    steps.push(`reached: ${dist(pos, goal) <= 1}`);
    return steps;
});

// Feed a packager 2 kg from the sweeper hopper. args: [packagerId, "transfer" | "crew"]
rpc.exports.packTest = (args: string[]) => main(() => {
    const id = parseInt(args[0]), mode = args[1];
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const store = `${cls("MoonWorld").method<Il2Cpp.String>("PackagerStoragePrefix").invoke(id).content}local`;
    const read = () => `hopper ${crewWorld.hopperKg(world, "crew/sweeper").toFixed(3)}, ${store} ${crewWorld.hopperKg(world, store).toFixed(3)}, ` +
        `PackagerKilograms ${world.method<number>("PackagerKilograms").invoke(id).toFixed(3)}, holds ${world.method<boolean>("PackagerHolds").invoke(id)}, ` +
        `status "${world.method<Il2Cpp.String>("PackagerStatus").invoke(id).content}", wallet ${callDecimal(world.class.method("WalletDollars"), world, Il2Cpp.string("local").handle).toFixed(2)}`;
    const before = read();
    let result: unknown = null;
    if (mode === "transfer") result = crewWorld.transferDust(world, "crew/sweeper", store, 2);
    if (mode === "crew") {
        const taken = world.method<number>("TakeVehicleDust").invoke(Il2Cpp.string("crew/sweeper"), 2);
        result = { taken, accepted: world.method<number>("CrewPackagerLoad").invoke(Il2Cpp.string("local"), id, taken) };
    }
    return { before, result, after: read() };
});
rpc.exports.packRead = (args: string[]) => main(() => {
    const id = parseInt(args[0]);
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    return `PackagerKilograms ${world.method<number>("PackagerKilograms").invoke(id).toFixed(3)}, holds ${world.method<boolean>("PackagerHolds").invoke(id)}, ` +
        `status "${world.method<Il2Cpp.String>("PackagerStatus").invoke(id).content}", wallet ${callDecimal(world.class.method("WalletDollars"), world, Il2Cpp.string("local").handle).toFixed(2)}`;
});

// Driving test: while the probe is loaded, feed one parked vehicle throttle/steer in its FixedUpdate.
// args: [storageId, throttle, steer]. driveStop removes the hook. driveRead reports the vehicle.
let driveHooked = false;
const driveInput = new Map<string, { throttle: number; steer: number }>();
function vehicleBy(id: string): Il2Cpp.Object | null {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    for (const { key, value } of crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("garageVehicles").value)) {
        if ((key as unknown as Il2Cpp.String).content === id) return value;
    }
    return null;
}
rpc.exports.driveStart = (args: string[]) => main(() => {
    const [id, t, s] = args;
    const v = vehicleBy(id);
    if (!v) return `no vehicle ${id}`;
    driveInput.set(v.handle.toString(), { throttle: parseFloat(t), steer: parseFloat(s) });
    if (!driveHooked) {
        driveHooked = true;
        cls("MoonPrototypeVehicle").method("FixedUpdate").implementation = function () {
            const self = this as Il2Cpp.Object;
            const input = driveInput.get(self.handle.toString());
            if (input) {
                self.field<number>("throttle").value = input.throttle;
                self.field<number>("steer").value = input.steer;
                self.field<boolean>("brake").value = false;
            }
            self.method("FixedUpdate").invoke();
        };
    }
    const body = v.field<Il2Cpp.Object>("body").value;
    return { start: positionOf(v).map(x => x.toFixed(2)).join(","), kinematic: body.method("get_isKinematic").invoke(), sleeping: body.method("IsSleeping").invoke() };
});
rpc.exports.driveRead = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (!v) return `no vehicle ${args[0]}`;
    const body = v.field<Il2Cpp.Object>("body").value;
    const vel = toVec3(body.method<Il2Cpp.ValueType>("get_linearVelocity").invoke());
    const t = v.method<Il2Cpp.Object>("get_transform").invoke();
    const fwd = toVec3(t.method<Il2Cpp.ValueType>("get_forward").invoke());
    const right = toVec3(t.method<Il2Cpp.ValueType>("get_right").invoke());
    const sp = Math.hypot(...vel) || 1;
    const along = (vel[0] * fwd[0] + vel[1] * fwd[1] + vel[2] * fwd[2]) / sp;
    const side = (vel[0] * right[0] + vel[1] * right[1] + vel[2] * right[2]) / sp;
    void along; void side;
    (globalThis as any).__drive = { velAlongForward: along.toFixed(2), velAlongRight: side.toFixed(2), forwardSpeed: v.method<number>("get_ForwardSpeed").invoke().toFixed(2) };
    return { pos: positionOf(v).map(x => x.toFixed(2)).join(","), speed: v.method<number>("get_Speed").invoke().toFixed(2),
             ...(globalThis as any).__drive, flipped: v.field("<Flipped>k__BackingField").value, grounded: v.field("<Grounded>k__BackingField").value,
             kinematic: body.method("get_isKinematic").invoke(), throttle: v.field("throttle").value, dust: v.method<number>("get_DustKilograms").invoke().toFixed(2) };
});
// Put a vehicle on open ground beside the garage nearest the player (test setup).
rpc.exports.vehicleHome = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (!v) return `no vehicle ${args[0]}`;
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const player = positionOf(walker);
    const g = crewWorld.sceneObjects("MoonGarage").sort((a, b) => dist(positionOf(a), player) - dist(positionOf(b), player))[0];
    const spot = toVec3(g.method<Il2Cpp.ValueType>("Spot").invoke().field<Il2Cpp.ValueType>("position").value);
    const pad = crewWorld.approachPoint(world, surfacePoint(world, spot));
    // args[1]: another vehicle to park beside (8 m to its right) instead of the garage
    const beside = args[1] ? vehicleBy(args[1]) : null;
    const away = beside
        ? surfacePoint(world, add(positionOf(beside), scale(toVec3(beside.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_right").invoke()), 8)))
        : pad;
    const at = add(away, scale(norm(away), 1.5));
    // Upright: rotate so the vehicle's up is the ground normal (keep a heading along the surface).
    const Quat = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Quaternion");
    const up = norm(at);
    const fwd = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const rot = Quat.method<Il2Cpp.ValueType>("LookRotation", 2).invoke(vector3(fwd), vector3(up));
    v.field<Il2Cpp.Object>("body").value.method("set_rotation").invoke(rot);
    const body = v.field<Il2Cpp.Object>("body").value;
    body.method("set_position").invoke(vector3(at));
    body.method("set_linearVelocity").invoke(vector3([0, 0, 0]));
    body.method("set_angularVelocity").invoke(vector3([0, 0, 0]));
    v.method<Il2Cpp.Object>("get_transform").invoke().method("set_position").invoke(vector3(at));
    return `placed beside garage ${g.field("<Id>k__BackingField").value}, ${dist(at, player).toFixed(0)} m from player`;
});

// Read-only: where MoonWorld.GroundSolid is true, at distances from the player in 4 directions.
rpc.exports.solidRadius = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const p = surfacePoint(world, positionOf(walker));
    const up = norm(p);
    const e1 = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(up, e1);
    const out: string[] = [];
    for (const [name, dir] of [["e1", e1], ["-e1", scale(e1, -1)], ["e2", e2], ["-e2", scale(e2, -1)]] as [string, Vec3][]) {
        const row: string[] = [];
        for (const d of [50, 100, 200, 300, 400, 500, 700, 1000, 1500]) {
            const q = surfacePoint(world, add(p, scale(dir, d)));
            row.push(`${d}:${world.method<boolean>("GroundSolid").invoke(vector3(add(q, scale(norm(q), 0.5)))) ? "Y" : "n"}`);
        }
        out.push(`${name} ${row.join(" ")}`);
    }
    return out;
});

// World storages whose id starts with args[0], with kg/capacity. With args[1]/[2]: move args[2] kg
// from the first match into storage args[1] (test setup: no dust is created).
rpc.exports.storagesLike = (args: string[]) => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const ids = crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("vehicleStorage").value)
        .map(e => (e.key as unknown as Il2Cpp.String).content ?? "").filter(id => id.startsWith(args[0]));
    const out = ids.map(id => `${id} ${crewWorld.hopperKg(world, id).toFixed(1)}/${world.method<number>("VehicleDustCapacity").invoke(Il2Cpp.string(id))}`);
    if (args[1] && ids.length) out.push(`moved ${crewWorld.transferDust(world, ids[0], args[1], parseFloat(args[2])).toFixed(1)} kg from ${ids[0]} to ${args[1]}`);
    return out;
});

// What surrounds a vehicle: knee-height hits within 15 m in 8 directions, the nearest garage pad,
// and whether the ground under it counts as solid.
rpc.exports.vehicleRays = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (!v) return `no vehicle ${args[0]}`;
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const here = surfacePoint(world, positionOf(v));
    const up = norm(here);
    const physics = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image;
    const all = physics.class("UnityEngine.Physics").methods.find(x => x.name === "RaycastAll" && x.parameterCount === 5 &&
        x.parameters[0].type.name === "UnityEngine.Vector3")!;
    const trig = enumValue(physics.class("UnityEngine.QueryTriggerInteraction"), "Ignore");
    const fwd = norm(tangent(here, toVec3(v.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_forward").invoke())));
    const left = cross(up, fwd);
    const out: string[] = [`solid ${world.method<boolean>("GroundSolid").invoke(vector3(add(here, scale(up, 0.5))))}, ` +
        `kinematic ${v.field<Il2Cpp.Object>("body").value.method("get_isKinematic").invoke()}, heldStill ${v.field("heldStill").value}`];
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        const dir = norm(add(scale(fwd, Math.cos(a)), scale(left, Math.sin(a))));
        const hits = all.invoke(vector3(add(here, scale(up, 0.8))), vector3(dir), 15, -1, trig) as Il2Cpp.Array<Il2Cpp.ValueType>;
        const names: string[] = [];
        for (let j = 0; j < hits.length; j++) {
            const h = hits.get(j);
            const c = h.method<Il2Cpp.Object>("get_collider").invoke();
            names.push(`${h.method<number>("get_distance").invoke().toFixed(1)}:${c.isNull() ? "?" : c.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke().content}`);
        }
        out.push(`${i * 45}° (0=forward, 90=left): ${names.join(", ") || "clear"}`);
    }
    const g = crewWorld.sceneObjects("MoonGarage").sort((a, b) => dist(positionOf(a), here) - dist(positionOf(b), here))[0];
    if (g) {
        const spot = toVec3(g.method<Il2Cpp.ValueType>("Spot").invoke().field<Il2Cpp.ValueType>("position").value);
        const pad = crewWorld.approachPoint(world, surfacePoint(world, spot));
        out.push(`nearest garage ${g.field("<Id>k__BackingField").value}: pad ${dist(pad, here).toFixed(0)} m away, direct path clear ${crewWorld.clearPath(here, pad)}`);
    }
    return out;
});

// Open the garage menu: args [garageId, tab] (tab 1 = Upgrades); "close" closes it. Reports the rows.
rpc.exports.garageMenu = (args: string[]) => main(() => {
    const menus = crewWorld.sceneObjects("MoonGarageMenu");
    if (!menus.length) return "no garage menu";
    const m = menus[0];
    if (args[0] === "close") { m.method("SetOpen").invoke(false); return "closed"; }
    const ok = m.method<boolean>("Open", 2).invoke(parseInt(args[0]), parseInt(args[1] ?? "1"));
    const rows = m.field<Il2Cpp.Object>("upgradeRows").value;
    const out: string[] = [`open ${ok}, page ${m.field("page").value}, garage ${m.field("garage").value}, menus ${menus.length}`];
    for (let i = 0; !rows.isNull() && i < rows.method<number>("get_Count").invoke(); i++) {
        const r = rows.method<Il2Cpp.Object>("get_Item").invoke(i);
        const title = r.field<Il2Cpp.Object>("title").value;
        const label = r.field<Il2Cpp.Object>("label").value;
        const rect = label.isNull() ? null : label.method<Il2Cpp.Object>("get_rectTransform").invoke();
        out.push(`row ${i}: kind ${r.field("kind").value} "${title.isNull() ? "" : title.method<Il2Cpp.String>("get_text").invoke().content}" level ${r.field("level").value}/${r.field("max").value} shown ${r.field("shown").value}` +
            (rect ? ` anchoredPos ${rect.method<Il2Cpp.ValueType>("get_anchoredPosition").invoke().toString()} parent ${rect.method<Il2Cpp.Object>("get_parent").invoke().method<Il2Cpp.String>("get_name").invoke().content}` : ""));
    }
    return out;
});

// The last upgrade row's GameObject tree, and where each UpgradeRow field sits in it.
rpc.exports.rowTree = () => main(() => {
    const m = crewWorld.sceneObjects("MoonGarageMenu")[0];
    const rows = m.field<Il2Cpp.Object>("upgradeRows").value;
    const r = rows.method<Il2Cpp.Object>("get_Item").invoke(rows.method<number>("get_Count").invoke() - 1);
    const root = r.field<Il2Cpp.Object>("label").value.method<Il2Cpp.Object>("get_transform").invoke();
    const out: string[] = [];
    const walk = (t: Il2Cpp.Object, depth: number) => {
        const go = t.method<Il2Cpp.Object>("get_gameObject").invoke();
        out.push(`${"  ".repeat(depth)}${go.method<Il2Cpp.String>("get_name").invoke().content} active ${go.method("get_activeSelf").invoke()}`);
        for (let i = 0; i < t.method<number>("get_childCount").invoke(); i++) walk(t.method<Il2Cpp.Object>("GetChild").invoke(i), depth + 1);
    };
    walk(root, 0);
    const pathOf = (comp: Il2Cpp.Object) => {
        if (comp.isNull()) return "null";
        let t = comp.method<Il2Cpp.Object>("get_transform").invoke();
        const parts: string[] = [];
        while (!t.isNull() && !t.equals(root)) {
            parts.unshift(t.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke().content ?? "?");
            t = t.method<Il2Cpp.Object>("get_parent").invoke();
        }
        return t.isNull() ? "outside the row" : parts.join("/") || "(root)";
    };
    for (const f of ["label", "title", "state", "tagText", "glyph", "pips", "tag"]) out.push(`field ${f}: ${pathOf(r.field<Il2Cpp.Object>(f).value)}`);
    const hover = r.field<Il2Cpp.Object>("hover").value, pop = r.field<Il2Cpp.Object>("pop").value;
    out.push(`hover ${hover.isNull() ? "null" : hover.class.name}, pop ${pop.isNull() ? "null" : pop.class.name}`);
    return out;
});

// Click a UI button by its GameObject name (onClick.Invoke, as a mouse click would).
rpc.exports.clickNamed = (args: string[]) => main(() => {
    const go = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.GameObject").method<Il2Cpp.Object>("Find").invoke(Il2Cpp.string(args[0]));
    if (go.isNull()) return `no ${args[0]}`;
    const Button = Il2Cpp.domain.assembly("UnityEngine.UI").image.class("UnityEngine.UI.Button");
    const b = go.method<Il2Cpp.Object>("GetComponent", 1).overload("System.Type").invoke(Button.type.object);
    if (b.isNull()) return "no button";
    b.method<Il2Cpp.Object>("get_onClick").invoke().method("Invoke").invoke();
    return "clicked";
});
// Show another model on the garage's Upgrades page (as clicking it in the strip would).
rpc.exports.pickModel = (args: string[]) => main(() => {
    const m = crewWorld.sceneObjects("MoonGarageMenu")[0];
    m.method("PickModel").invoke(parseInt(args[0]));
    const item = m.field<Il2Cpp.Object>("itemName").value.method<Il2Cpp.String>("get_text").invoke().content;
    return `picked ${args[0]}, panel shows "${item}"`;
});
// Press the garage menu's action button; report the wallet before/after and the status line.
rpc.exports.menuAct = () => main(() => {
    const m = crewWorld.sceneObjects("MoonGarageMenu")[0];
    const w = m.method<Il2Cpp.Object>("get_World").invoke();
    const wallet = () => callDecimal(w.class.method("WalletDollars"), w, Il2Cpp.string("local").handle).toFixed(2);
    const before = wallet();
    m.method("Act").invoke();
    const status = m.field<Il2Cpp.Object>("status").value;
    return { before, after: wallet(), status: status.isNull() ? "" : status.method<Il2Cpp.String>("get_text").invoke().content };
});

// Read-only: garage views in the scene (id, distance from the player).
rpc.exports.garages = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const p = positionOf(walker);
    return crewWorld.sceneObjects("MoonGarage").map(g => `garage ${g.field("<Id>k__BackingField").value} at ${dist(positionOf(g), p).toFixed(0)} m`);
});
// Bring a stored vehicle out at a garage view: args [garageId, vehicle model, storageId].
rpc.exports.bringOut = (args: string[]) => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const g = crewWorld.sceneObjects("MoonGarage").find(x => String(x.field("<Id>k__BackingField").value) === args[0]);
    if (!g) return `no garage view ${args[0]}`;
    const r = world.method("BringOut").invoke(g, parseInt(args[1]), Il2Cpp.string(args[2]));
    return `BringOut -> ${r}; in world now: ${vehicleBy(args[2]) ? "yes" : "no"}`;
});

rpc.exports.vehicleFlip = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (!v) return `no vehicle ${args[0]}`;
    v.method("FlipUpright").invoke();
    return "FlipUpright called";
});

// Read-only: a vehicle's control flags and body settings.
rpc.exports.vehicleFlags = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (!v) return `no vehicle ${args[0]}`;
    const body = v.field<Il2Cpp.Object>("body").value;
    const out: Record<string, unknown> = {};
    for (const f of ["ready", "brake", "workHeld", "boost", "cleaningLatched", "<IsDriven>k__BackingField", "<Autopilot>k__BackingField",
                     "<Grounded>k__BackingField", "<Flipped>k__BackingField", "padMoved", "CruiseOn", "nextWork"]) {
        try { out[f] = v.field(f).value; } catch (e) { out[f] = "n/a"; }
    }
    out.padGarage = v.field<Il2Cpp.Object>("padGarage").value.isNull() ? null : "set";
    out.enabled = v.method("get_enabled").invoke();
    out.bodySleeping = body.method("IsSleeping").invoke();
    out.constraints = String(body.method("get_constraints").invoke());
    out.mass = body.method("get_mass").invoke();
    return out;
});

// Stand the player 12 m from a vehicle, looking at it (for screenshots).
rpc.exports.lookAtVehicle = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (!v) return `no vehicle ${args[0]}`;
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const vp = positionOf(v);
    const right = toVec3(v.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_right").invoke());
    const stand = surfacePoint(world, add(vp, scale(right, -12)));
    const t = walker.method<Il2Cpp.Object>("get_transform").invoke();
    t.method("set_position").invoke(vector3(add(stand, scale(norm(stand), 1.5))));
    const Quat = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Quaternion");
    t.method("set_rotation").invoke(Quat.method<Il2Cpp.ValueType>("LookRotation", 2).invoke(vector3(norm(tangent(stand, sub(vp, stand)))), vector3(norm(stand))));
    return "standing beside it";
});

rpc.exports.driveStop = (args: string[]) => main(() => {
    const v = vehicleBy(args[0]);
    if (v) driveInput.delete(v.handle.toString());
    return "stopped";
});

// Garage unload test for one vehicle. args: [storageId, "info" | "fill" | "unload"]
rpc.exports.garageTest = (args: string[]) => main(() => {
    const [id, mode] = args;
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const v = vehicleBy(id);
    if (!v) return `no vehicle ${id}`;
    const owned = crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("ownedVehicles").value)
        .find(e => (e.key as unknown as Il2Cpp.String).content === id)?.value;
    const gid = owned ? owned.field<number>("garage").value as number : -1;
    const out0: Record<string, unknown> = {};
    const gp = crewValueType(Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Vector3"));
    const found = world.method<boolean>("GaragePosition").invoke(gid, gp.handle);
    const spot = found ? toVec3(gp) : null;
    out0.garagePosition = found ? `${spot!.map(x => x.toFixed(1)).join(",")}, ${dist(spot!, positionOf(v)).toFixed(1)} m from the vehicle, ` +
        `${dist(spot!, surfacePoint(world, spot!)).toFixed(1)} m above ground` : "not found";
    out0.views = crewWorld.sceneObjects("MoonGarage").map(g => {
        const s = toVec3(g.method<Il2Cpp.ValueType>("Spot").invoke().field<Il2Cpp.ValueType>("position").value);
        const sg = surfacePoint(world, s);
        const rot = g.method<Il2Cpp.ValueType>("Spot").invoke().field<Il2Cpp.ValueType>("rotation").value;
        const Quat = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Quaternion");
        const fwd = toVec3(Quat.method<Il2Cpp.ValueType>("op_Multiply", 2).overload("UnityEngine.Quaternion", "UnityEngine.Vector3").invoke(rot, vector3([0, 0, 1])));
        const axis: string[] = [];
        for (const sign of [-1]) for (const k of [25, 30, 35, 40, 50, 60]) {
            const q = surfacePoint(world, add(sg, scale(fwd, sign * k)));
            axis.push(`${sign > 0 ? "+" : "-"}${k}: covered ${crewWorld.covered(q)} wallsClear ${crewWorld.clearWalls(q, sg)}`);
        }
        const physics = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image;
        const all = physics.class("UnityEngine.Physics").methods.find(x => x.name === "RaycastAll" && x.parameterCount === 5 &&
            x.parameters[0].type.name === "UnityEngine.Vector3")!;
        const o = add(sg, scale(norm(sg), 0.8));
        const hits = all.invoke(vector3(o), vector3(scale(fwd, -1)), 40, -1, enumValue(physics.class("UnityEngine.QueryTriggerInteraction"), "Ignore")) as Il2Cpp.Array<Il2Cpp.ValueType>;
        const names: string[] = [];
        for (let j = 0; j < hits.length; j++) {
            const h = hits.get(j);
            const c = h.method<Il2Cpp.Object>("get_collider").invoke();
            names.push(`${h.method<number>("get_distance").invoke().toFixed(1)}:${c.isNull() ? "?" : c.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke().content}`);
        }
        axis.push(`hits back from pad: ${names.join(", ")}`);
        return `axis [${axis.join("; ")}] ` +
            `id ${g.field("<Id>k__BackingField").value} at ${dist(positionOf(g), positionOf(v)).toFixed(0)} m; spot ${dist(s, positionOf(v)).toFixed(0)} m from vehicle, ` +
            `${dist(s, sg).toFixed(1)} m above ground, covered ${crewWorld.covered(sg)}, approach ${dist(sg, crewWorld.approachPoint(world, sg)).toFixed(1)} m out`;
    });
    const silo = cls("MoonWorld").method<Il2Cpp.String>("GarageSiloPrefix").invoke(gid).content;
    const info = () => ({
        garage: gid, spotDist: spot ? dist(spot, positionOf(v)).toFixed(1) : null,
        spotCovered: spot ? crewWorld.covered(surfacePoint(world, spot)) : null,
        vehicleKg: v.method<number>("get_DustKilograms").invoke().toFixed(2),
        siloKg: world.method<number>("GarageSiloKilograms").invoke(gid).toFixed(2), silo,
    });
    const out: Record<string, unknown> = { ...out0, before: info() };
    if (mode === "fill") out.moved = crewWorld.transferDust(world, "crew/sweeper", id, 5);
    if (mode === "unload") {
        const reason = Memory.alloc(Process.pointerSize);
        reason.writePointer(NULL);
        out.kg = world.method<number>("UnloadIntoGarage").invoke(Il2Cpp.string(id), Il2Cpp.string("local"), gid, 50, reason);
        const r = reason.readPointer();
        out.reason = r.isNull() ? "" : new Il2Cpp.String(r).content;
    }
    out.after = info();
    return out;
});

// Read-only: every spawned vehicle (MoonWorld.garageVehicles) and its owned record.
rpc.exports.vehicles = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const player = surfacePoint(world, positionOf(walker));
    const out: string[] = [];
    for (const { key, value: v } of crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("garageVehicles").value)) {
        if (v.isNull()) continue;
        const p = positionOf(v);
        const g = surfacePoint(world, p);
        const spec = v.field<Il2Cpp.Object>("<Spec>k__BackingField").value;
        out.push(`${(key as unknown as Il2Cpp.String).content}: ${spec.isNull() ? "?" : spec.field<Il2Cpp.String>("name").value.content} idx ${v.field("<Index>k__BackingField").value}, ` +
            `${dist(g, player).toFixed(0)} m from player, ${dist(p, g).toFixed(1)} m above ground, driven ${v.method("get_IsDriven").invoke()}, ` +
            `autopilot ${v.method("get_Autopilot").invoke()}, dust ${v.method<number>("get_DustKilograms").invoke().toFixed(1)}/${v.method<number>("get_DustCapacityKg").invoke()}, ` +
            `speed ${v.method<number>("get_Speed").invoke().toFixed(2)}, width ${v.method<number>("get_CleaningWidth").invoke().toFixed(2)}, ` +
            `cleaning ${v.method("get_CleaningEnabled").invoke()}, flipped ${v.field("<Flipped>k__BackingField").value}`);
    }
    for (const { key, value: o } of crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("ownedVehicles").value)) {
        out.push(`owned ${(key as unknown as Il2Cpp.String).content}: garage ${o.field("garage").value} vehicle ${o.field("vehicle").value} inWorld ${o.field("inWorld").value} holder ${o.field<Il2Cpp.String>("holder").value?.content}`);
    }
    return out;
});

// Read-only: every packager (depot kind 10) and the world storages named after it.
rpc.exports.packagers = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const player = surfacePoint(world, positionOf(walker));
    const kind = cls("MoonWorld").field<number>("PackagerKind").value;
    const storages = crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("vehicleStorage").value)
        .map(e => (e.key as unknown as Il2Cpp.String).content ?? "");
    const out: string[] = [`PackagerKind ${kind}, capacity ${cls("MoonWorld").field("PackagerCapacityKg").value} kg`];
    for (const { key, value } of crewWorld.dictionaryEntries(world.field<Il2Cpp.Object>("depots").value)) {
        if (value.field<number>("kind").value !== kind) continue;
        const id = value.field<number>("id").value as number;
        const p: Vec3 = [value.field<number>("x").value as number, value.field<number>("y").value as number, value.field<number>("z").value as number];
        const prefix = cls("MoonWorld").method<Il2Cpp.String>("PackagerStoragePrefix").invoke(id).content ?? "";
        const t = world.method<Il2Cpp.Object>("get_transform").invoke();
        const wp = toVec3(t.method<Il2Cpp.ValueType>("TransformPoint", 1).invoke(vector3(p)));
        const wg = surfacePoint(world, wp);
        out.push(`TransformPoint: ${dist(wp, player).toFixed(0)} m from player, ${dist(wp, wg).toFixed(1)} m above ground, ` +
            `covered ${crewWorld.covered(wg)}, approach ${dist(wg, crewWorld.approachPoint(world, wg)).toFixed(1)} m out`);
        const views = crewWorld.sceneObjects("MoonPackagerView");
        out.push(`${views.length} packager views: ids ${views.map(v => v.field("id").value).join(",")}`);
        const view = views.find(v => v.field<number>("id").value === id);
        const vp = view ? surfacePoint(world, positionOf(view)) : null;
        out.push(`view: ${vp ? `${dist(vp, player).toFixed(0)} m from player, covered ${crewWorld.covered(vp)}, approach ${dist(vp, crewWorld.approachPoint(world, vp)).toFixed(1)} m out` : "none"}`);
        out.push(`packager ${id} (key ${key}): ${dist(p, player).toFixed(0)} m from player, stored ${value.field("stored").value}, ` +
            `PackagerKilograms ${world.method<number>("PackagerKilograms").invoke(id)}, holds ${world.method<boolean>("PackagerHolds").invoke(id)}, ` +
            `status "${world.method<Il2Cpp.String>("PackagerStatus").invoke(id).content}", prefix "${prefix}", ` +
            `storages [${storages.filter(s => s.startsWith(prefix)).map(s => `${s}=${world.method<number>("VehicleDustKilograms").invoke(Il2Cpp.string(s)).toFixed(2)}/${world.method<number>("VehicleDustCapacity").invoke(Il2Cpp.string(s))}`).join(", ")}]`);
    }
    return out;
});

rpc.exports.stationApproach = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    return crewWorld.stations().map(s => {
        const p = surfacePoint(world, positionOf(s));
        const q = crewWorld.approachPoint(world, p);
        return `station ${s.method<number>("get_Index").invoke()}: covered ${crewWorld.covered(p)}, approach ${dist(p, q).toFixed(1)} m out, ` +
            `approach covered ${crewWorld.covered(q)}`;
    });
});

rpc.exports.methodsOf = (args: string[]) => main(() => {
    const [asm, klass, name] = args;
    return Il2Cpp.domain.assembly(asm).image.class(klass).methods.filter(m => !name || m.name === name)
        .map(m => `${m.name}(${m.parameters.map(p => p.type.name).join(", ")})`);
});

// Read-only: player speed inputs, and what knee-height rays from the player hit in 16 directions.
rpc.exports.navInfo = (args: string[]) => main(() => {
    const range = parseFloat(args?.[0] ?? "40");
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const settings = world.field<Il2Cpp.Object>("settings").value;
    const out: Record<string, unknown> = {
        runSpeed: settings.field("runSpeed").value,
        moveMult: world.method<number>("MoveSpeedMultiplier", 1).invoke(Il2Cpp.string("local")),
    };
    const Physics = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image.class("UnityEngine.Physics");
    const Hit = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image.class("UnityEngine.RaycastHit");
    const raycast = Physics.methods.find(m => m.name === "Raycast" && m.parameterCount === 6 && m.parameters[0].type.name === "UnityEngine.Vector3")!;
    const Trig = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image.class("UnityEngine.QueryTriggerInteraction");
    const ground = surfacePoint(world, positionOf(walker));
    const up = norm(ground);
    const origin = add(ground, scale(up, 0.8));
    // Two tangent directions on the sphere at the player.
    const e1 = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const e2 = cross(up, e1);
    const rays: string[] = [];
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * 2 * Math.PI;
        const dir = norm(add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a))));
        const hit = crewValueType(Hit);
        const ok = raycast.invoke(vector3(origin), vector3(dir), hit.handle, range, -1, enumValue(Trig, "Ignore")) as boolean;
        if (!ok) { rays.push(`${(a * 180 / Math.PI).toFixed(0)}°: clear`); continue; }
        const col = hit.method<Il2Cpp.Object>("get_collider").invoke();
        const go = col.isNull() ? null : col.method<Il2Cpp.Object>("get_gameObject").invoke();
        rays.push(`${(a * 180 / Math.PI).toFixed(0)}°: ${hit.method<number>("get_distance").invoke().toFixed(1)} m ` +
            `${go ? go.method<Il2Cpp.String>("get_name").invoke().content : "?"} layer ${go ? go.method<number>("get_layer").invoke() : "?"}`);
    }
    out.rays = rays;
    return out;
});

// Save what the game is drawing to a PNG (written at the end of the frame).
rpc.exports.screenshot = (args: string[]) => main(() => {
    const SC = Il2Cpp.domain.assembly("UnityEngine.ScreenCaptureModule").image.class("UnityEngine.ScreenCapture");
    SC.method("CaptureScreenshot", 1).invoke(Il2Cpp.string(args[0]));
    return args[0];
});

// Read-only: what the shop has built, and whether the crew cards pass its filters.
rpc.exports.shopInfo = () => main(() => {
    const Shop = cls("MoonUpgradeShop");
    const concepts = Shop.field<Il2Cpp.Array<Il2Cpp.ValueType>>("Concepts").value;
    const names: string[] = [];
    for (let i = 0; i < concepts.length; i++) names.push(`${i}:${concepts.get(i).field<Il2Cpp.String>("name").value.content}/${concepts.get(i).field("category").value}`);
    const labels = Shop.field<Il2Cpp.Array<Il2Cpp.String>>("CategoryLabels").value;
    const cats = ["Tools", "Vehicles", "Inventory", "BaseEquipment", "Suit"];
    const out: Record<string, unknown> = {
        concepts: names,
        labels: Array.from({ length: labels.length }, (_, i) => labels.get(i)?.content),
        sold: cats.map(c => `${c}=${Shop.method<boolean>("Sold").invoke(enumValue(Shop.nested("Category"), c))}`),
    };
    out.shops = Il2Cpp.gc.choose(Shop).map(shop => {
        const offers = shop.field<Il2Cpp.Object>("offers").value;
        const list: string[] = [];
        if (!offers.isNull()) for (let i = 0; i < offers.method<number>("get_Count").invoke(); i++) {
            const o = offers.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (String(o.field("kind").value) !== "Concept") continue;
            list.push(`#${o.field("index").value} ${o.field<Il2Cpp.String>("name").value.content} cat ${o.field("category").value} listed ${shop.method<boolean>("Listed").invoke(o)}`);
        }
        const kinds: Record<string, number> = {};
        if (!offers.isNull()) for (let i = 0; i < offers.method<number>("get_Count").invoke(); i++) {
            const k = String(offers.method<Il2Cpp.Object>("get_Item").invoke(i).field("kind").value);
            kinds[k] = (kinds[k] ?? 0) + 1;
        }
        const go = shop.method<Il2Cpp.Object>("get_gameObject").invoke();
        return { name: go.method<Il2Cpp.String>("get_name").invoke().content, offersNull: offers.isNull(), kinds,
                 open: shop.method<boolean>("get_IsOpen").invoke(), category: String(shop.field("selectedCategory").value), concepts: list };
    });
    return out;
});

// Task 7 sandbox check: drive the shop like a player. args: ["open"] | ["setMoney", "450"] |
// ["buy", "<card name>"] | ["show", "<card name>"].
rpc.exports.shopTest = (args: string[]) => main(() => {
    try {
        const [cmd, arg] = args ?? [];
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const local = Il2Cpp.string("local");
        const wallet = () => callDecimal(world.class.method("WalletDollars"), world, local.handle);
        if (cmd === "setMoney") {
            world.method("ChargeBuild").invoke(local, decimal(parseFloat(arg) - wallet()));
            return { wallet: wallet() };
        }
        const Shop = cls("MoonUpgradeShop");
        const shop = Shop.method<Il2Cpp.Object>("ForCamera").invoke(walker.field<Il2Cpp.Object>("viewCamera").value);
        if (shop.isNull()) return "no shop for this camera";
        if (!shop.method<boolean>("get_IsOpen").invoke()) shop.method("SetOpen").invoke(true);
        const offers = shop.field<Il2Cpp.Object>("offers").value;
        const list: Il2Cpp.Object[] = [];
        for (let i = 0; i < offers.method<number>("get_Count").invoke(); i++) list.push(offers.method<Il2Cpp.Object>("get_Item").invoke(i));
        const text = (f: string) => { const t = shop.field<Il2Cpp.Object>(f).value; return t.isNull() ? "" : t.method<Il2Cpp.String>("get_text").invoke().content; };
        if (cmd === "open") {
            return { concepts: Shop.field<Il2Cpp.Array>("Concepts").value.length,
                     offers: list.map(o => `${o.field("kind").value}#${o.field("index").value} ${o.field<Il2Cpp.String>("name").value.content}`) };
        }
        const offer = list.find(o => o.field<Il2Cpp.String>("name").value.content === arg);
        if (!offer) return `no offer named ${arg}`;
        shop.method("SelectCategory").invoke(offer.field<Il2Cpp.ValueType>("category").value);
        shop.method("SelectOffer").invoke(offer, true);
        const before = wallet();
        if (cmd === "buy") shop.method("ShopAction").invoke();
        shop.method("RefreshDetails").invoke();
        return { walletBefore: before, walletAfter: wallet(), message: shop.method<Il2Cpp.String>("get_LastMessage").invoke()?.content,
                 detailStatus: text("detailStatus"), detailName: text("detailName"), status: text("status") };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Sandbox only: which way does ChargeBuild move the wallet? Charge $1, report before/after.
rpc.exports.chargeTest = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const local = Il2Cpp.string("local");
        const wallet = () => callDecimal(world.class.method("WalletDollars"), world, local.handle);
        const before = wallet();
        world.method("ChargeBuild").invoke(local, decimal(1));
        return { before, after: wallet() };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Read-only: what the Hauler sees.
rpc.exports.haulInfo = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const p = positionOf(walker);
        const s = crewWorld.haulSources(world);
        return {
            docks: s.docks.map(d => `${d.id} full=${d.full} machine=${d.machine} kg=${crewWorld.hopperKg(world, d.id).toFixed(1)} ${dist(d.pos, p).toFixed(0)} m`),
            vehicles: s.vehicles.map(v => `${v.id} kg=${v.kg.toFixed(1)} driven=${v.driven} machine=${v.machine} ${dist(v.pos, p).toFixed(0)} m`),
        };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Sandbox test helper: resize the Sweeper's hopper to (current load + extra) kg.
rpc.exports.sweeperHopper = (args: string[]) => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const kg = crewWorld.hopperKg(world, "crew/sweeper");
    const cap = kg + parseFloat((args ?? [])[0] ?? "3");
    crewWorld.resizeHopper(world, "crew/sweeper", cap);
    return `sweeper hopper ${kg.toFixed(2)} kg, capacity now ${world.method("VehicleDustCapacity").invoke(Il2Cpp.string("crew/sweeper"))} kg`;
});

// Dirt sensor test: does a tiny-dose stroke report dusty cells while removing ~nothing?
rpc.exports.sensorTest = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const t = walker.method<Il2Cpp.Object>("get_transform").invoke();
        const p = positionOf(walker);
        const f = toVec3(t.method<Il2Cpp.ValueType>("get_forward").invoke());
        const r = toVec3(t.method<Il2Cpp.ValueType>("get_right").invoke());
        crewWorld.ensureHopper(world, "crew/test", 500);
        const out: string[] = [];
        for (const [name, dir] of [["fwd", f], ["right", r], ["back", scale(f, -1)], ["left", scale(r, -1)]] as const) {
            for (const d of [8, 16, 24]) {
                const a = surfacePoint(world, add(p, scale(dir, d)));
                const b = surfacePoint(world, add(a, scale(dir === f || dir === scale(f, -1) ? r : f, 0.3)));
                const k0 = crewWorld.hopperKg(world, "crew/test");
                const sense = crewWorld.cleanStroke(world, a, b, 1.0, 0.92, 0.001, 0.05, "crew/test");
                const k1 = crewWorld.hopperKg(world, "crew/test");
                const again = crewWorld.cleanStroke(world, a, b, 1.0, 0.92, 0.001, 0.05, "crew/test");
                out.push(`${name} ${d} m: sense cells ${sense} (+${((k1 - k0) * 1000).toFixed(1)} g), again ${again}`);
            }
        }
        return out;
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Stroke along a demo member's own segment, and along a strip 2 m to its side, into the test hopper.
rpc.exports.strokeOnMember = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const list = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker).field<Il2Cpp.Object>("members").value;
        const m = list.method<Il2Cpp.Object>("get_Item").invoke(0);
        const a = toVec3(m.field<Il2Cpp.ValueType>("position").value);
        let b = toVec3(m.field<Il2Cpp.ValueType>("to").value);
        if (dist(a, b) < 0.3) b = add(a, scale(norm(sub(positionOf(walker), a)), 1));
        const side = scale(norm(cross(norm(a), norm(sub(b, a)))), 2);
        crewWorld.ensureHopper(world, "crew/test", 500);
        const run = (p: Vec3, q: Vec3) => {
            const k0 = crewWorld.hopperKg(world, "crew/test");
            const cells = crewWorld.cleanStroke(world, p, q, 1.0, 0.92, 1, 0.05, "crew/test");
            return `cells ${cells} +${(crewWorld.hopperKg(world, "crew/test") - k0).toFixed(3)} kg`;
        };
        const remote = m.field<Il2Cpp.Object>("remote").value;
        return {
            segment: `${dist(a, b).toFixed(2)} m, |a| ${Math.hypot(...a).toFixed(2)} terrain ${Math.hypot(...surfacePoint(world, a)).toFixed(2)} drawn ${remote.isNull() ? "-" : Math.hypot(...positionOf(remote)).toFixed(2)}`,
            onSegment: run(a, b),
            twoMetresAside: run(surfacePoint(world, add(a, side)), surfacePoint(world, add(b, side))),
        };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Sandbox experiment: set every demo member's held tool (e.g. "" for empty-handed).
rpc.exports.demoTool = (args: string[]) => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const list = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker).field<Il2Cpp.Object>("members").value;
    const tool = (args ?? [])[0] ?? "";
    for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
        list.method<Il2Cpp.Object>("get_Item").invoke(i).field<Il2Cpp.String>("tool").value = Il2Cpp.string(tool);
    }
    return `tool set to "${tool}"`;
});

// Sandbox only: remove every demo-crew member (strays from earlier probe sessions).
rpc.exports.demoClear = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const crew = cls("MoonDemoCrew").method<Il2Cpp.Object>("Of").invoke(walker);
    const n = crew.field<Il2Cpp.Object>("members").value.method<number>("get_Count").invoke();
    crew.method("Clear").invoke();
    return `cleared ${n}, remotes left ${cls("MoonRemotePlayer").field<Il2Cpp.Object>("Shown").value.method("get_Count").invoke()}`;
});
rpc.exports.spawnClear = () => main(() => {
    if (testTick) { testTick.detach(); testTick = null; }
    for (const b of testBodies) b.body.destroy();
    const n = testBodies.length;
    testBodies.length = 0;
    return `removed ${n}`;
});

// Which stroke parameters actually clean? Same dirty strip behind the player, one variable at a time.
rpc.exports.strokeParams = (args: string[]) => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const t = walker.method<Il2Cpp.Object>("get_transform").invoke();
        const p = positionOf(walker);
        const f = toVec3(t.method<Il2Cpp.ValueType>("get_forward").invoke());
        const r = toVec3(t.method<Il2Cpp.ValueType>("get_right").invoke());
        const id = "crew/test";
        crewWorld.ensureHopper(world, id, 500);
        const cases: [string, number, number, number, number, number][] = [
            // name, length m, width, depth, dose, edge  (2 m strokes, one fresh strip each)
            ["w2 dose1", 2, 2, 0.92, 1, 0.05],
            ["w2 dose2", 2, 2, 0.92, 2, 0.05],
            ["w2 dose4", 2, 2, 0.92, 4, 0.05],
            ["w3 dose2", 2, 3, 0.92, 2, 0.05],
            ["w2 dose2 depth2", 2, 2, 2, 2, 0.05],
            ["w2 dose2 again", 2, 2, 0.92, 2, 0.05],
        ];
        const lateral = (args ?? [])[0] === "right" ? 15 : -15;
        return cases.map(([name, len, w, dep, dose, edge], i) => {
            const a = surfacePoint(world, add(add(p, scale(f, -(10 + 4 * i))), scale(r, lateral)));
            const b = surfacePoint(world, add(a, scale(r, -len)));
            const before = crewWorld.hopperKg(world, id);
            const cells = crewWorld.cleanStroke(world, a, b, w, dep, dose, edge, id);
            return `${name}: cells ${cells} +${(crewWorld.hopperKg(world, id) - before).toFixed(4)} kg`;
        });
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Task 5 sandbox check: register a test hopper and run cleaning strokes around the player at
// several distances/directions, reporting kg collected per stroke.
rpc.exports.strokeTest = (args: string[]) => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const id = "crew/test";
        crewWorld.ensureHopper(world, id, 500);
        const t = walker.method<Il2Cpp.Object>("get_transform").invoke();
        const p = positionOf(walker);
        const f = toVec3(t.method<Il2Cpp.ValueType>("get_forward").invoke());
        const r = toVec3(t.method<Il2Cpp.ValueType>("get_right").invoke());
        const width = parseFloat((args ?? [])[0] ?? "0.99");
        const out: string[] = [`hopper cap ${world.method("VehicleDustCapacity").invoke(Il2Cpp.string(id))} kg start ${crewWorld.hopperKg(world, id).toFixed(3)}`];
        for (const d of [10, 20, 30, 45]) for (const [name, dir] of [["fwd", f], ["right", r], ["back", scale(f, -1)], ["left", scale(r, -1)]] as const) {
            const a = surfacePoint(world, add(p, scale(dir, d)));
            const b = surfacePoint(world, add(a, scale(dir === f || dir === r ? r : f, 3)));
            const before = crewWorld.hopperKg(world, id);
            const cells = crewWorld.cleanStroke(world, a, b, width, 0.102, 0.5 * 2.5, 0.04, id);
            out.push(`${name} ${d} m: cells ${cells} kg +${(crewWorld.hopperKg(world, id) - before).toFixed(3)}`);
        }
        return out;
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Sandbox only: move the player onto the terrain a few metres behind a robot that is cleaning,
// so the Sweeper (which works around the player) has dirty ground for payback tuning.
rpc.exports.moveToDirt = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const robots = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
        for (let i = 0; i < robots.method<number>("get_Count").invoke(); i++) {
            const rb = robots.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (String(rb.field("state").value) !== "Cleaning") continue;
            const rt = rb.method<Il2Cpp.Object>("get_transform").invoke();
            const f = toVec3(rt.method<Il2Cpp.ValueType>("get_forward").invoke());
            const r = toVec3(rt.method<Il2Cpp.ValueType>("get_right").invoke());
            // Off to the robot's side, well clear of its lanes, on ground it hasn't swept yet.
            const spot = surfacePoint(world, add(add(positionOf(rb), scale(r, 25)), scale(f, 10)));
            const up = scale(norm(spot), 1.5);
            const body = walker.method<Il2Cpp.Object>("get_transform").invoke();
            body.method("set_position").invoke(vector3(add(spot, up)));
            return `moved to ${spot.map(n => n.toFixed(1))}, ${dist(spot, positionOf(rb)).toFixed(0)} m from robot ${i}`;
        }
        return "no robot is cleaning right now";
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Decimal helpers check: byte-level round trip, and Decimal-returning game calls via callDecimal.
rpc.exports.decimalFixed = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const Dec = Il2Cpp.corlib.class("System.Decimal");
        const round = [1, 2.5, 10, 123.456, -3.25].map(v => `${v}->${decimalValue(decimal(v))}`).join(" ");
        const add = Dec.methods.find(m => m.name === "op_Addition")!;
        const sum = callDecimal(add, null, decimal(2.5).handle, decimal(10).handle);
        const local = Il2Cpp.string("local").handle;
        const money = walker.field<Il2Cpp.Object>("upgradeAccount").value.method("get_Money");
        return {
            roundTrip: round, "2.5+10": sum,
            payoutMultiplier: callDecimal(world.class.method("PayoutMultiplier"), world, local),
            waitingWorth: callDecimal(world.class.method("WaitingWorth"), world),
            pendingDepositKg: callDecimal(world.class.method("PendingDepositKilograms"), world, local),
            wallet: callDecimal(world.class.method("WalletDollars"), world, local),
            moneyGetter: callDecimal(money, walker.field<Il2Cpp.Object>("upgradeAccount").value),
            landmarkRewardFlag: callDecimal(world.class.method("LandmarkReward"), null, cls("MoonLandmarkKind").field<Il2Cpp.ValueType>("Flag").value.handle),
        };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Is Decimal marshalling sane? Round-trip known values through op_Explicit and ToDouble/ToString.
rpc.exports.decimalSanity = () => main(() => {
    const Dec = Il2Cpp.corlib.class("System.Decimal");
    const fromDouble = Dec.methods.find(m => m.name === "op_Explicit" && m.parameterCount === 1 &&
        m.parameters[0].type.name === "System.Double" && m.returnType.name === "System.Decimal")!;
    const toDouble = Dec.methods.find(m => m.name === "ToDouble" && m.parameterCount === 1)!;
    return [1, 2.5, 10, 123.456].map(v => {
        try {
            const d = fromDouble.invoke(v) as Il2Cpp.ValueType;
            const raw = Array.from(new Uint8Array(d.handle.readByteArray(16)!)).map(b => b.toString(16).padStart(2, "0")).join("");
            return `${v} -> ToDouble ${toDouble.invoke(d)} bytes ${raw}`;
        } catch (e) { return `${v} -> ERROR ${e}`; }
    });
});

// Task 5: the parts of the deposit worth formula.
rpc.exports.worthParts = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const Dec = Il2Cpp.corlib.class("System.Decimal");
        const settings = world.field<Il2Cpp.Object>("settings").value;
        const perKg = settings.field<number>("dollarsPerKilogram").value as number;
        const fromDouble = Dec.methods.find(m => m.name === "op_Explicit" && m.parameterCount === 1 &&
            m.parameters[0].type.name === "System.Double" && m.returnType.name === "System.Decimal")!;
        const base = fromDouble.invoke(10 * perKg) as Il2Cpp.ValueType;
        const payout = world.method<Il2Cpp.ValueType>("PayoutMultiplier").invoke(Il2Cpp.string("local"));
        const toD = (v: Il2Cpp.ValueType) => Dec.method<number>("ToDouble").invoke(v);
        return {
            dollarsPerKilogram: perKg, dollarsPerSection: settings.field("dollarsPerSection").value,
            sandValue: settings.field("sandValueMultiplier").value, stoneValue: settings.field("stoneValueMultiplier").value,
            explicitOverloads: Dec.methods.filter(m => m.name === "op_Explicit").map(m => `${m.returnType.name}(${m.parameters.map(p => p.type.name)})`),
            chosen: `${fromDouble.returnType.name}(${fromDouble.parameters.map(p => p.type.name)})`,
            base10kgToDouble: toD(base), payoutToDouble: toD(payout), payoutString: payout.toString(),
        };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Task 5: load the test hopper with real dust (strokes on the dirty patch left of the player),
// deposit it, and read the tray's recorded worth and the world's pending numbers around it.
rpc.exports.loadAndDeposit = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const Dec = Il2Cpp.corlib.class("System.Decimal");
        const d = (v: Il2Cpp.ValueType) => Dec.method<number>("ToDouble").invoke(v);
        const local = Il2Cpp.string("local");
        crewWorld.ensureHopper(world, "crew/test", 500);
        // Sweep a patch in front of a robot that is cleaning (dirty ground by definition).
        const robots = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
        let rb: Il2Cpp.Object | null = null;
        for (let i = 0; i < robots.method<number>("get_Count").invoke(); i++) {
            const c = robots.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (String(c.field("state").value) === "Cleaning") { rb = c; break; }
        }
        if (!rb) return "no robot is cleaning right now";
        const rt = rb.method<Il2Cpp.Object>("get_transform").invoke();
        const p = positionOf(rb);
        const f = toVec3(rt.method<Il2Cpp.ValueType>("get_forward").invoke());
        const r = toVec3(rt.method<Il2Cpp.ValueType>("get_right").invoke());
        for (let lane = -6; lane < 6; lane++) for (let k = 0; k < 6; k++) {
            const a = surfacePoint(world, add(add(p, scale(r, lane)), scale(f, 3 + 2 * k)));
            const b = surfacePoint(world, add(a, scale(f, 2)));
            crewWorld.cleanStroke(world, a, b, 1.0, 0.92, 1, 0.05, "crew/test");
        }
        const loaded = crewWorld.hopperKg(world, "crew/test");
        const s = crewWorld.stations()[0];
        void d;
        const snap = () => ({ waiting: callDecimal(world.class.method("WaitingWorth"), world),
            pendingKg: callDecimal(world.class.method("PendingDepositKilograms"), world, local.handle),
            tray: s.method<number>("get_TrayKilograms").invoke(), trayWorth: decimalValue(s.field<Il2Cpp.ValueType>("trayWorth").value),
            wallet: callDecimal(world.class.method("WalletDollars"), world, local.handle) });
        const before = snap();
        const res = crewWorld.depositHopper(world, "crew/test", s);
        return { loaded, before, deposit: res, after: snap() };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Task 5: where does a vehicle deposit's worth come from? (sandbox only: sets test hopper dust)
rpc.exports.worthTest = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const Dec = Il2Cpp.corlib.class("System.Decimal");
        const d = (v: Il2Cpp.ValueType) => Dec.method<number>("ToDouble").invoke(v);
        const local = Il2Cpp.string("local");
        const snap = (tag: string) => `${tag}: waitingWorth ${d(world.method<Il2Cpp.ValueType>("WaitingWorth").invoke()).toFixed(4)} ` +
            `pendingKg(local) ${d(world.method<Il2Cpp.ValueType>("PendingDepositKilograms").invoke(local)).toFixed(4)} ` +
            `storedStationKg ${world.method<number>("get_StoredStationKilograms").invoke().toFixed(3)}`;
        crewWorld.ensureHopper(world, "crew/test", 500);
        world.method("DevSetVehicleDust").invoke(Il2Cpp.string("crew/test"), 5.0);
        const out = [snap("before"), `hopper ${crewWorld.hopperKg(world, "crew/test")}`];
        const kg = world.method<number>("DepositVehicleDust").invoke(Il2Cpp.string("crew/test"), local, 5.0);
        out.push(`DepositVehicleDust -> ${kg}`, snap("after"));
        return out;
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Task 5: deposit the test hopper through depositHopper and report kg and dollars ($/kg).
rpc.exports.depositTest = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const before = crewWorld.hopperKg(world, "crew/test");
        const s = crewWorld.stations()[0];
        const r = crewWorld.depositHopper(world, "crew/test", s);
        return { hopperBefore: before, ...r, dollarsPerKg: r.kg > 0 ? r.worth / r.kg : null, trayNow: s.method("get_TrayKilograms").invoke() };
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Task 5: dust price, and how much is in the test hopper.
rpc.exports.economy = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const world = walker.field<Il2Cpp.Object>("world").value;
    const s = crewWorld.stations()[0];
    return {
        worthOf1kg: s.method<number>("WorthOf").invoke(1),
        worthOf100kg: s.method<number>("WorthOf").invoke(100),
        testHopperKg: crewWorld.hopperKg(world, "crew/test"),
        money: walker.field<Il2Cpp.Object>("upgradeAccount").value.method("get_Money").invoke()!.toString(),
        payoutMultiplier: String(world.method("PayoutMultiplier").invoke(Il2Cpp.string("local"))),
    };
});

// Task 5: stroke where a cleaning robot is working (known dirty ground): hopper vs player inventory.
rpc.exports.strokeAtRobot = () => main(() => {
    try {
        const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
        const world = walker.field<Il2Cpp.Object>("world").value;
        const list = cls("MoonRobotVacuum").field<Il2Cpp.Object>("active").value;
        const p = positionOf(walker);
        const out: string[] = [];
        crewWorld.ensureHopper(world, "crew/test", 500);
        for (let i = 0; i < list.method<number>("get_Count").invoke(); i++) {
            const rb = list.method<Il2Cpp.Object>("get_Item").invoke(i);
            const state = String(rb.field("state").value);
            const rp = positionOf(rb);
            const ahead = toVec3(rb.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_forward").invoke());
            const a = surfacePoint(world, add(rp, scale(ahead, 1.5)));
            const b = surfacePoint(world, add(a, scale(ahead, 3)));
            const h0 = crewWorld.hopperKg(world, "crew/test");
            const cells = crewWorld.cleanStroke(world, a, b, 0.99, 0.102, 1.25, 0.04, "crew/test");
            const h1 = crewWorld.hopperKg(world, "crew/test");
            // Variant: right passed as edge *points* (position + right * half width).
            const right = norm(cross(norm(a), norm(sub(b, a))));
            const a2 = surfacePoint(world, add(a, scale(right, 2))), b2 = surfacePoint(world, add(b, scale(right, 2)));
            const h2 = crewWorld.hopperKg(world, "crew/test");
            const cellsPts = world.method<number>("CleanToolStroke").invoke(vector3(a2), vector3(b2),
                vector3(add(a2, scale(right, 0.5))), vector3(add(b2, scale(right, 0.5))),
                0.99, 0.102, 1.25, 0.04, vector3(norm(sub(b2, a2))), Il2Cpp.string(""), Il2Cpp.string("crew/test"));
            const h3 = crewWorld.hopperKg(world, "crew/test");
            out.push(`robot ${i} ${state} ${dist(rp, p).toFixed(0)} m away: right-as-direction cells ${cells} +${(h1 - h0).toFixed(3)} kg | right-as-points cells ${cellsPts} +${(h3 - h2).toFixed(3)} kg`);
        }
        return out;
    } catch (e) { return `ERROR ${e}\n${(e as Error).stack}`; }
});

// Task 5: cleaning numbers of each tool (what MoonBrush passes to CleanToolStroke).
rpc.exports.toolStats = () => main(() => {
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    const cat = walker.field<Il2Cpp.Object>("world").value.method<Il2Cpp.Object>("get_UpgradeCatalog").invoke();
    return Array.from(cat.field<Il2Cpp.Array<Il2Cpp.Object>>("tools").value).map(o => {
        const t = o.field<Il2Cpp.Object>("tool").value;
        const f = (n: string) => String(t.field(n).value);
        return `${t.field<Il2Cpp.String>("toolId").value.content}: width ${f("cleaningWidth")} depth ${f("cleaningDepth")} edge ${f("edgeWidth")} rate ${f("removalRate")} onePass ${f("clearInOnePass")} stroke ${f("strokeDuration")}s container ${f("containerKg")}kg`;
    });
});

// Task 4: astronaut look presets, the local look, and tool ids.
rpc.exports.lookInfo = () => main(() => {
    const L = cls("MoonAstronautLook");
    const col = (c: Il2Cpp.ValueType) => ["r", "g", "b"].map(k => (c.field<number>(k).value as number).toFixed(2)).join(",");
    const arr = (n: string) => Array.from(L.field<Il2Cpp.Array<Il2Cpp.ValueType>>(n).value).map(col);
    const local = L.method<Il2Cpp.Object>("get_Local").invoke();
    const walker = cls("MoonRunOver").method<Il2Cpp.Object>("get_LocalWalker").invoke();
    let tools: string[] = [];
    if (!walker.isNull()) {
        const cat = walker.field<Il2Cpp.Object>("world").value.method<Il2Cpp.Object>("get_UpgradeCatalog").invoke();
        tools = Array.from(cat.field<Il2Cpp.Array<Il2Cpp.Object>>("tools").value).map(o => {
            const t = o.field<Il2Cpp.Object>("tool").value;
            return `${t.field<Il2Cpp.String>("toolId").value.content} = ${t.field<Il2Cpp.String>("displayName").value.content}`;
        });
    }
    return {
        suitPresets: arr("SuitPresets"), eyePresets: arr("EyePresets"),
        eyeNames: Array.from(L.field<Il2Cpp.Array<Il2Cpp.String>>("EyeNames").value).map(s => s.content),
        local: { eyes: local.field("eyes").value, eyeColor: col(local.field<Il2Cpp.ValueType>("eyeColor").value), suit: col(local.field<Il2Cpp.ValueType>("suitColor").value) },
        tools,
    };
});

// Sandbox only: put kg into station 0's tray, as a deposit's final MoonDustStation.Take does.
rpc.exports.fillTray = (args: string[]) => main(() => {
    const list = cls("MoonDustStation").field<Il2Cpp.Object>("stations").value;
    const s = list.method<Il2Cpp.Object>("get_Item").invoke(0);
    const world = s.field<Il2Cpp.Object>("world").value;
    s.method("Take").invoke(parseFloat(args[0]), world.method<Il2Cpp.ValueType>("WaitingWorth").invoke());
    const intake = s.method<Il2Cpp.Object>("get_Intake").invoke();
    return { tray: s.method("get_TrayKilograms").invoke(), selling: intake.method("get_Selling").invoke(), canSell: intake.method("get_CanSell").invoke() };
});
rpc.exports.trayState = () => main(() => {
    const list = cls("MoonDustStation").field<Il2Cpp.Object>("stations").value;
    const s = list.method<Il2Cpp.Object>("get_Item").invoke(0);
    const intake = s.method<Il2Cpp.Object>("get_Intake").invoke();
    return { tray: s.method("get_TrayKilograms").invoke(), selling: intake.method("get_Selling").invoke(), canSell: intake.method("get_CanSell").invoke() };
});

rpc.exports.setActiveSlot = (args: string[]) => main(() => {
    cls("MoonSaveSlots").method("set_Active").invoke(parseInt(args[0], 10));
    return cls("MoonSaveSlots").method<number>("get_Active").invoke();
});
