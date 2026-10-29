import "frida-il2cpp-bridge";
import { add, cross, dist, norm, scale, sub, tangent, type Vec3 } from "./vec.ts";
import { callDecimal, decimal, enumValue, moon, positionOf, surfacePoint, toVec3, valueType, vector3 } from "./unity.ts";

// Game adapters for crew work. Call only on Unity's main thread (the trainer tick).
//
// Hopper: a helper's dust lives in a vehicle-style storage on MoonWorld (RegisterVehicleStorage /
// FitVehicleCapacity / VehicleDustKilograms), so it is saved and reloaded with the world exactly
// like a vehicle's hopper, and DepositVehicleDust credits it to the local player's wallet.
//
// Cleaning: MoonBrush.Sweep (RVA 0x309d80) calls MoonWorld.CleanToolStroke(from, to, fromRight,
// toRight, width = tool cleaningWidth, depth = cleaningDepth, dose = clamp(seconds) * removalRate,
// edge = edgeWidth, push, inventoryId = the player's, vehicleStorageId = null). Robot vacuums (seen
// with agent/src/stroke-watch.ts) pass inventoryId "local" *and* their storage as vehicleStorageId,
// with unit right vectors, width/depth 0.92, dose 1, edge 0.05; the dust lands in their storage.
// Helpers do the same. An empty inventoryId makes the stroke clean nothing.
//
// Deposit: MoonDustStation.DepositVehicle (RVA 0x33b690) checks the vehicle's speed and distance,
// then: BeginDeposit; w0 = WaitingWorth; kg = DepositVehicleDust(storageId, driverId,
// max(1, station.displayedCanisterKilograms)); w1 = WaitingWorth; station.Take(kg, w1 - w0).
// depositHopper replays that from the distance check on (helpers stand on the terrain point at the
// station, never indoors), with the local player as the driver.

export const LOCAL_PLAYER = "local";

/** Create the hopper if the world doesn't have it yet. An existing one keeps its size. */
export function ensureHopper(world: Il2Cpp.Object, id: string, capKg: number): void {
    const s = Il2Cpp.string(id);
    if (world.method<number>("VehicleDustCapacity").invoke(s) <= 0) world.method("RegisterVehicleStorage").invoke(s, capKg);
}

export function resizeHopper(world: Il2Cpp.Object, id: string, capKg: number): void {
    world.method("FitVehicleCapacity").invoke(Il2Cpp.string(id), capKg);
}

export function hopperKg(world: Il2Cpp.Object, id: string): number {
    return world.method<number>("VehicleDustKilograms").invoke(Il2Cpp.string(id));
}

/** One cleaning stroke from → to on the ground, dust into the hopper. Returns cells cleaned. */
export function cleanStroke(world: Il2Cpp.Object, from: Vec3, to: Vec3, width: number, depth: number,
                            dose: number, edge: number, hopperId: string): number {
    const heading = norm(tangent(from, sub(to, from)));
    const right = norm(cross(norm(from), heading));
    return world.method<number>("CleanToolStroke").invoke(
        vector3(from), vector3(to), vector3(right), vector3(right),
        width, depth, dose, edge, vector3(heading), Il2Cpp.string(LOCAL_PLAYER), Il2Cpp.string(hopperId));
}

// --- Hauler sources ------------------------------------------------------------------------------
// Robot docks and vehicles keep their dust in world storages too (MoonRobotDock.get_StoredKilograms
// and MoonRobotVacuum.get_DustKilograms both read VehicleDustKilograms). MoonRobotDock.Unload moves
// a robot's dust into its dock with MoonWorld.TransferVehicleDust(from, to, maximum), which is what
// the Hauler uses: storage to storage, the total conserved, saved with the world.
// Loose canisters are left alone: the game only moves canister dust into a *player's* inventory
// (CollectDustCanister / TransferCanisterDust), which would fill Aryan's container.

export interface HaulSourceInfo {
    docks: { id: string; pos: Vec3; full: boolean; machine: boolean }[];
    vehicles: { id: string; pos: Vec3; kg: number; driven: boolean; machine: boolean }[];
}

function isMachineStorage(world: Il2Cpp.Object, id: Il2Cpp.String): boolean {
    return world.class.method<boolean>("MachineStorage").invoke(id);
}

// --- Packagers ------------------------------------------------------------------------------------
// A packaging machine is a depot of kind MoonWorld.PackagerKind (10). Its stock lives in per-player
// world storages "packager/<id>/<player>" (PackagerStoragePrefix + player, PackagerCapacityKg 100 kg);
// StepPackagers packs it into capsules and pays the owner (sandbox: 2 kg moved in, packed within 3 s,
// wallet +$2.12 at $1.06/kg). Helpers move their dust in with TransferVehicleDust, like Hank's docks.

export interface PackagerInfo { id: number; pos: Vec3; storage: string; kg: number; capKg: number }

export function packagers(world: Il2Cpp.Object): PackagerInfo[] {
    const World = world.class;
    const kind = World.field<number>("PackagerKind").value as number;
    const capKg = World.field<number>("PackagerCapacityKg").value as number;
    const out: PackagerInfo[] = [];
    for (const { value } of dictionaryEntries(world.field<Il2Cpp.Object>("depots").value)) {
        if (value.field<number>("kind").value !== kind) continue;
        const id = value.field<number>("id").value as number;
        if (!world.method<boolean>("IsPackager").invoke(id)) continue;
        const storage = `${World.method<Il2Cpp.String>("PackagerStoragePrefix").invoke(id).content}${LOCAL_PLAYER}`;
        ensureHopper(world, storage, capKg);  // the game creates it on first load; same id and size
        // Depot coordinates are in world space (the moon's transform is identity, checked in the sandbox).
        const at: Vec3 = [value.field<number>("x").value as number, value.field<number>("y").value as number, value.field<number>("z").value as number];
        out.push({ id, pos: approachPoint(world, surfacePoint(world, at)), storage, kg: hopperKg(world, storage),
                   capKg: world.method<number>("VehicleDustCapacity").invoke(Il2Cpp.string(storage)) });
    }
    return out;
}

/** Move as much of a helper's load as fits into the packager; returns kg moved. */
export function feedPackager(world: Il2Cpp.Object, from: string, p: PackagerInfo): number {
    const room = Math.max(0, p.capKg - hopperKg(world, p.storage));
    return room > 0 ? transferDust(world, from, p.storage, room) : 0;
}

/** Every live instance of a MoonCleaners component in the scene (Object.FindObjectsByType, unsorted). */
export function sceneObjects(className: string): Il2Cpp.Object[] {
    const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
    const find = core.class("UnityEngine.Object").methods.find(m => m.name === "FindObjectsByType" && m.parameterCount === 2 &&
        m.parameters[0].type.name === "System.Type")!;
    const arr = find.invoke(moon(className).type.object, enumValue(core.class("UnityEngine.FindObjectsSortMode"), "None")) as Il2Cpp.Array<Il2Cpp.Object>;
    const out: Il2Cpp.Object[] = [];
    for (let i = 0; i < arr.length; i++) out.push(arr.get(i));
    return out;
}

/** Non-null keys and values of a System.Collections.Generic.Dictionary (reads its _entries). */
export function dictionaryEntries(dict: Il2Cpp.Object): { key: Il2Cpp.Object; value: Il2Cpp.Object }[] {
    const out: { key: Il2Cpp.Object; value: Il2Cpp.Object }[] = [];
    if (dict.isNull()) return out;
    const entries = dict.field<Il2Cpp.Array<Il2Cpp.ValueType>>("_entries").value;
    const count = dict.field<number>("_count").value as number;
    if (entries.isNull()) return out;
    for (let i = 0; i < Math.min(count, entries.length); i++) {
        const e = entries.get(i);
        const key = e.field<Il2Cpp.Object>("key").value;
        const value = e.field<Il2Cpp.Object>("value").value;
        // A removed entry: null key (reference keys) or null value (int keys, e.g. MoonWorld.depots).
        if ((key instanceof Il2Cpp.Object && key.isNull()) || (value instanceof Il2Cpp.Object && value.isNull())) continue;
        out.push({ key, value });
    }
    return out;
}

export function haulSources(world: Il2Cpp.Object): HaulSourceInfo {
    const docks: HaulSourceInfo["docks"] = [];
    const all = moon("MoonRobotDock").method<Il2Cpp.Object>("get_All").invoke();
    for (let i = 0; i < all.method<number>("get_Count").invoke(); i++) {
        const d = all.method<Il2Cpp.Object>("get_Item").invoke(i);
        if (d.isNull()) continue;
        const id = d.method<Il2Cpp.String>("get_StorageId").invoke();
        if (id.isNull()) continue;
        // MachineStorage is true for every "robotdock/..." id (docks can feed belts), so for docks the
        // safety signal is get_Full instead: a full dock's outflow has stopped, so taking from it
        // can't starve a production line. The machine check still guards every other storage.
        docks.push({ id: id.content!, pos: approachPoint(world, surfacePoint(world, positionOf(d))), full: d.method<boolean>("get_Full").invoke(),
                     machine: false });
    }
    // OwnedVehicle.holder is set for any vehicle a player has out (e.g. "local"), so "being driven"
    // comes from the spawned MoonPrototypeVehicle (garageVehicles, keyed by the same storage id).
    const driving = new Set<string>();
    for (const { key, value } of dictionaryEntries(world.field<Il2Cpp.Object>("garageVehicles").value)) {
        if (!value.isNull() && value.method<boolean>("get_IsDriven").invoke()) {
            driving.add((key as unknown as Il2Cpp.String).content!);
        }
    }
    const vehicles: HaulSourceInfo["vehicles"] = [];
    for (const { key, value } of dictionaryEntries(world.field<Il2Cpp.Object>("ownedVehicles").value)) {
        if (!value.field<boolean>("inWorld").value) continue;  // in a garage: the garage empties it
        const storage = key as unknown as Il2Cpp.String;
        vehicles.push({
            id: storage.content!, pos: surfacePoint(world, toVec3(value.field<Il2Cpp.ValueType>("position").value)),
            kg: hopperKg(world, storage.content!), driven: driving.has(storage.content!),
            machine: isMachineStorage(world, storage),
        });
    }
    return { docks, vehicles };
}

/** Move up to `maximum` kg from one world storage to another; returns kg moved. */
export function transferDust(world: Il2Cpp.Object, from: string, to: string, maximum: number): number {
    return world.method<number>("TransferVehicleDust").invoke(Il2Cpp.string(from), Il2Cpp.string(to), maximum);
}

/**
 * Dirt sensor: a 0.3 m stroke with a tiny dose into its own storage; returns the kilograms it
 * picked up (~0.6 g on dusty ground, 0 on clean). Not the cell count: CleanToolStroke counts
 * every cell it passes, dusty or not, so swept ground around a base read as dirty forever and the
 * Sweeper cleaned empty lanes (Aryan's first hire: 648k cells, 0 kg).
 */
export const SENSE_DOSE = 0.001;
const SENSE_MIN_KG = 1e-5;
export function senseDirt(world: Il2Cpp.Object, p: Vec3, sensorId: string): number {
    const along = norm(tangent(p, Math.abs(norm(p)[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const q: Vec3 = [p[0] + along[0] * 0.3, p[1] + along[1] * 0.3, p[2] + along[2] * 0.3];
    const before = hopperKg(world, sensorId);
    cleanStroke(world, p, q, 1.0, 0.92, SENSE_DOSE, 0.05, sensorId);
    const kg = hopperKg(world, sensorId) - before;
    return kg > SENSE_MIN_KG ? kg : 0;
}

// --- Buildings ------------------------------------------------------------------------------------
// Helpers aren't moved by physics (their bodies are placed), so they see buildings with Physics.Raycast (this build strips Linecast)
// at knee height. Terrain is a collider too ("Terrain x:y:z"); its bumps and the moon's curve are
// walkable, so a terrain hit is skipped and the ray continues past it. So are the helpers' own drawn
// bodies ("Crewmate body - Dusty (Sweeper)"), which sit slightly off the computed position and made
// every helper "blocked" by itself.
const PASS_THROUGH = ["Terrain", "Crewmate body"];

const KNEE_M = 0.8;
const ROOF_M = 6;
let raycast: Il2Cpp.Method | null = null, hitClass: Il2Cpp.Class | null = null, ignoreTriggers: Il2Cpp.ValueType | null = null;

function rayHit(origin: Vec3, dir: Vec3, range: number): { distance: number; terrain: boolean } | null {
    if (!raycast) {
        const physics = Il2Cpp.domain.assembly("UnityEngine.PhysicsModule").image;
        raycast = physics.class("UnityEngine.Physics").methods.find(m => m.name === "Raycast" && m.parameterCount === 6 &&
            m.parameters[0].type.name === "UnityEngine.Vector3")!;
        hitClass = physics.class("UnityEngine.RaycastHit");
        ignoreTriggers = enumValue(physics.class("UnityEngine.QueryTriggerInteraction"), "Ignore");
    }
    const hit = valueType(hitClass!);
    if (!raycast.invoke(vector3(origin), vector3(dir), hit.handle, range, -1, ignoreTriggers!)) return null;
    const collider = hit.method<Il2Cpp.Object>("get_collider").invoke();
    const name = collider.isNull() ? "" : collider.method<Il2Cpp.Object>("get_gameObject").invoke().method<Il2Cpp.String>("get_name").invoke().content ?? "";
    return { distance: hit.method<number>("get_distance").invoke(), terrain: PASS_THROUGH.some(prefix => name.startsWith(prefix)) };
}

/** Can a helper walk straight from ground point a to ground point b without going through a building? */
export function clearPath(a: Vec3, b: Vec3): boolean {
    if (dist(a, b) < 0.05) return true;
    // Station halls stand on raised floors: on terrain that dips under them, a knee-height ray passes
    // beneath the walls, so also refuse a path that runs under anything (the start may be covered:
    // a helper next to Aryan indoors has to be able to walk out).
    for (const t of [0.25, 0.5, 0.75, 1]) {
        if (covered(add(a, scale(sub(b, a), t)))) return false;
    }
    return clearWalls(a, b);
}

/**
 * Only the knee-height wall check, no roof check: for vehicles, which must drive in under the
 * garage roof to its unload pad (and which physically can't pass through walls anyway).
 */
export function clearWalls(a: Vec3, b: Vec3): boolean {
    const from = add(a, scale(norm(a), KNEE_M));
    const to = add(b, scale(norm(b), KNEE_M));
    const total = dist(from, to);
    if (total < 0.05) return true;
    const dir = norm(sub(to, from));
    let done = 0;
    for (let i = 0; i < 8 && done < total; i++) {
        const hit = rayHit(add(from, scale(dir, done)), dir, total - done);
        if (!hit) return true;
        if (!hit.terrain) return false;
        done += hit.distance + 0.05;
    }
    return true;
}

/**
 * Is there room around ground point p: nothing but terrain within `radius` at knee height, in six
 * directions? Vehicles need this: lanes through a machine yard (kilns, presses, belts) trapped one.
 */
export function openGround(p: Vec3, radius: number): boolean {
    const up = norm(p);
    const e1 = norm(tangent(p, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const e2 = cross(up, e1);
    const origin = add(p, scale(up, KNEE_M));
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 2 * Math.PI;
        const hit = rayHit(origin, norm(add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a)))), radius);
        if (hit && !hit.terrain) return false;
    }
    return true;
}

/** Is ground point p under a roof or inside a building (a non-terrain collider above it)? */
export function covered(p: Vec3): boolean {
    const up = norm(p);
    const hit = rayHit(add(p, scale(up, ROOF_M)), scale(up, -1), ROOF_M - 0.1);
    return hit !== null && !hit.terrain;
}

/**
 * Open ground next to `p` for a helper to stand on: p itself if it isn't under a roof, else the
 * nearest uncovered point within ~20 m that can be walked to from there. Stations and docks sit
 * inside halls, and depositing has no reach check, so helpers work from outside. Cached per spot.
 */
const approachCache = new Map<string, Vec3>();
export function approachPoint(world: Il2Cpp.Object, p: Vec3): Vec3 {
    const key = p.map(v => Math.round(v)).join(",");
    const cached = approachCache.get(key);
    if (cached) return cached;
    let best = p;
    if (covered(p)) {
        const up = norm(p);
        const e1 = norm(tangent(p, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
        const e2 = cross(up, e1);
        search:
        for (const r of [3, 6, 9, 12, 16, 20]) {
            for (let i = 0; i < 12; i++) {
                const a = (i / 12) * 2 * Math.PI;
                const q = surfacePoint(world, add(p, add(scale(e1, r * Math.cos(a)), scale(e2, r * Math.sin(a)))));
                if (!covered(q)) { best = q; break search; }
            }
        }
    }
    approachCache.set(key, best);
    return best;
}

/** How fast Aryan's astronaut runs right now (m/s): MoonSettings.runSpeed x MoveSpeedMultiplier. */
export function playerPace(world: Il2Cpp.Object): number {
    const run = world.field<Il2Cpp.Object>("settings").value.field<number>("runSpeed").value as number;
    const mult = world.method<number>("MoveSpeedMultiplier", 1).invoke(Il2Cpp.string(LOCAL_PLAYER));
    return run * mult;
}

export function stations(): Il2Cpp.Object[] {
    const list = moon("MoonDustStation").field<Il2Cpp.Object>("stations").value;
    if (list.isNull()) return [];
    const out: Il2Cpp.Object[] = [];
    const n = list.method<number>("get_Count").invoke();
    for (let i = 0; i < n; i++) {
        const s = list.method<Il2Cpp.Object>("get_Item").invoke(i);
        if (!s.isNull()) out.push(s);
    }
    return out;
}

/** The nearest station, with the terrain point a helper walks to for it. */
export function nearestStation(world: Il2Cpp.Object, p: Vec3): { station: Il2Cpp.Object; pos: Vec3 } | null {
    let best: { station: Il2Cpp.Object; pos: Vec3 } | null = null, bestD = Infinity;
    for (const s of stations()) {
        const pos = approachPoint(world, surfacePoint(world, positionOf(s)));
        const d = dist(p, pos);
        if (d < bestD) { bestD = d; best = { station: s, pos }; }
    }
    return best;
}

/**
 * Empty the hopper into the station's tray with its proper value, credited to the local player.
 *
 * A sale pays the tray's recorded worth: MoonDustStation.Sell launches trayWorth * (kg sold / tray)
 * through MoonWorld.TryLaunchDustWorth. Replaying DepositVehicle for a helper's storage recorded
 * $0 (its AttributeDeposit doesn't apply to an unregistered vehicle), and BeginDeposit cleared the
 * world's pending worth. So the value is set directly with the game's own formula from
 * MoonWorld.WaitingWorth: kg * MoonSettings.dollarsPerKilogram * PayoutMultiplier(player).
 */
export function depositHopper(world: Il2Cpp.Object, id: string, station: Il2Cpp.Object): { kg: number; worth: number } {
    // Price first: if reading it throws, the dust is still in the hopper (taking first could lose it).
    const perKg = dustDollarsPerKg(world);
    if (!(perKg >= 0)) throw new Error(`bad dust price ${perKg}`);
    const kg = world.method<number>("TakeVehicleDust").invoke(Il2Cpp.string(id), hopperKg(world, id));
    if (kg <= 0) return { kg: 0, worth: 0 };
    const worth = kg * perKg;
    station.method("Take").invoke(kg, decimal(worth));
    return { kg, worth };
}

/** What a kilogram of deposited dust is worth to the local player (price x upgrade payout). */
export function dustDollarsPerKg(world: Il2Cpp.Object): number {
    const perKg = world.field<Il2Cpp.Object>("settings").value.field<number>("dollarsPerKilogram").value as number;
    const payout = callDecimal(world.class.method("PayoutMultiplier"), world, Il2Cpp.string(LOCAL_PLAYER).handle);
    return perKg * payout;
}
