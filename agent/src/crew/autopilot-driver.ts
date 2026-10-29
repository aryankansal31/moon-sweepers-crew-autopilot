import "frida-il2cpp-bridge";
import { AutopilotBrain, StuckWatch, type AutopilotAction, type AutopilotStore } from "./autopilot.ts";
import { LanePlanner } from "./lanes.ts";
import { Navigator } from "./nav.ts";
import { add, dist, norm, scale, sub, tangent, type Vec3 } from "./vec.ts";
import { moon, positionOf, surfacePoint, toVec3, vector3 } from "./unity.ts";
import {
    LOCAL_PLAYER, approachPoint, cleanStroke, clearPath, covered, dictionaryEntries, ensureHopper, openGround, sceneObjects, senseDirt,
} from "./world.ts";

// Game adapter for the vehicle autopilot (see autopilot.ts for the behaviour).
//
// Driving: MoonPrototypeVehicle is a Rigidbody car. Its Update writes throttle (0x118) / steer
// (0x11c) only for a driver, and its own "Autopilot" flag (0x2d) is a driver's hold-throttle toggle,
// so a parked vehicle is driven by setting throttle/steer/brake in a FixedUpdate hook before the
// original runs (sandbox: a parked Ride-on sweeper drove at 6.5 m/s, grounded and upright).
// Cleaning: the game strokes only for a driver, so autopilot strokes CleanToolStroke itself with the
// vehicle's cleaning width and depth into the vehicle's own storage (its StorageId).
// Unloading: MoonWorld.UnloadIntoGarage(storage, player, garage, max, out reason) moves the hopper
// into that garage's silo (garagesilo/<id>/, sandbox: 5 kg in, 5 kg out) with no reach check. The
// unload pad (MoonGarage.Spot) sits deep inside the hall behind walls, so the vehicle stops on open
// ground beside it (approachPoint) and unloads there.
// Work area: lanes around where autopilot took the vehicle over (Aryan leaves it there). Garage (for
// unloading only): the nearest MoonGarage in the scene, not the vehicle's purchase garage
// (MoonOwnedVehicle.garage was 2.9 km away in the sandbox).

const UNIT_MS = 100;                       // decide this often per vehicle
const STROKE_MS = 200;
const UNLOAD_KG_PER_TICK = 60;             // the game's own rate is 600 kg/s
const PLAN_RADII = [25, 50, 100, 175, 250];
const LANE_END_M = 3;                      // vehicles can't hit a lane end exactly
const LANE_START_M = 5;                    // this close to a lane start: start cleaning it
const ORBIT_M = 20;                        // near a lane start this long without starting it: skip it
const ORBIT_MS = 8000;
const VEHICLE_AHEAD_M = 6;                 // aim this far ahead on a lane
const SENSOR_ID = "crew/sensor";           // shared with the Sweeper's dirt sensor
const SENSE_LANES = 3;
const TRAIL_MS = 3000;
const BRING_OUT_MS = 10_000;               // check for stored autopilot vehicles this often
const HELD_CLEARANCE_M = 0.4;              // a held vehicle's body this far above the ground
const core = () => Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;

export interface AutopilotDeps {
    store(): AutopilotStore;
    gameKey(): string;
    walker(): Il2Cpp.Object;
    notify(text: string): void;
}

interface Input { throttle: number; steer: number; brake: boolean }
const inputs = new Map<string, Input>();   // vehicle handle → what FixedUpdate should apply
let hooked = false;

function installHook() {
    if (hooked) return;
    hooked = true;
    const Vehicle = moon("MoonPrototypeVehicle");
    Vehicle.method("FixedUpdate").implementation = function () {
        const self = this as Il2Cpp.Object;
        const input = inputs.get(self.handle.toString());
        if (input) {
            self.field<number>("throttle").value = input.throttle;
            self.field<number>("steer").value = input.steer;
            self.field<boolean>("brake").value = input.brake;
        }
        self.method("FixedUpdate").invoke();
    };
}

function vectorField(pose: Il2Cpp.ValueType, name: string): Vec3 {
    return toVec3(pose.field<Il2Cpp.ValueType>(name).value);  // copy at once: the returned struct is short-lived
}

/** The nearest garage in the scene: its id and the open ground beside its unload pad. */
function nearestGarage(world: Il2Cpp.Object, p: Vec3): { id: number; pad: Vec3 } | null {
    let best: { id: number; pad: Vec3 } | null = null, bestD = Infinity;
    for (const g of sceneObjects("MoonGarage")) {
        const spot = vectorField(g.method<Il2Cpp.ValueType>("Spot").invoke(), "position");
        const d = dist(spot, p);
        if (d < bestD) { bestD = d; best = { id: g.field<number>("<Id>k__BackingField").value as number, pad: spot }; }
    }
    if (!best) return null;
    return { id: best.id, pad: approachPoint(world, surfacePoint(world, best.pad)) };
}

class Unit {
    readonly brain = new AutopilotBrain();
    readonly nav = new Navigator();
    planner: LanePlanner | null = null;
    garage: { id: number; pad: Vec3 } | null = null;
    trail: { t: number; p: Vec3 }[] = [];
    lastStroke: Vec3 | null = null;
    nextStroke = 0;
    nextTick = 0;
    action: AutopilotAction = { kind: "stop" };
    kgUnloaded = 0;
    nearSince: number | null = null;      // when it came within ORBIT_M of the current lane start
    remote = false;                       // held still by the game (far from Aryan): moved by us
    anchor: Vec3 | null = null;          // work centre: where autopilot took the vehicle over
    readonly stuck = new StuckWatch();
    recalls = 0;
    handle = "";                           // the vehicle's object handle (key into `inputs`)
    constructor(readonly id: string, readonly name: string) {}
}

export class AutopilotManager {
    private units = new Map<string, Unit>();
    private padUser = new Map<number, string>();   // garage id → storage id unloading there
    private nextBringOut = 0;

    constructor(private deps: AutopilotDeps) {}

    tick(nowMs: number): void {
        installHook();
        const walker = this.deps.walker();
        if (walker.isNull()) { this.stop(); return; }
        const world = walker.field<Il2Cpp.Object>("world").value;
        const game = this.deps.gameKey();
        const wanted = new Set(game ? this.deps.store().active(game) : []);
        this.bringOutStored(world, walker, wanted, nowMs);
        const seen = new Set<string>();
        for (const { key, value: v } of dictionaryEntries(world.field<Il2Cpp.Object>("garageVehicles").value)) {
            const id = (key as unknown as Il2Cpp.String).content ?? "";
            if (!wanted.has(id) || v.isNull()) continue;
            if (v.method<boolean>("get_IsDriven").invoke()) continue;   // Aryan is driving: hands off
            seen.add(id);
            let unit = this.units.get(id);
            if (!unit) {
                const spec = v.field<Il2Cpp.Object>("<Spec>k__BackingField").value;
                unit = new Unit(id, spec.isNull() ? id : spec.field<Il2Cpp.String>("name").value.content ?? id);
                this.units.set(id, unit);
            }
            if (nowMs >= unit.nextTick) {
                unit.nextTick = nowMs + UNIT_MS;
                this.step(world, v, unit, nowMs);
            }
        }
        for (const [id, unit] of this.units) if (!seen.has(id)) this.release(unit);
    }

    private step(world: Il2Cpp.Object, v: Il2Cpp.Object, u: Unit, nowMs: number) {
        u.handle = v.handle.toString();
        const pos = surfacePoint(world, positionOf(v));
        u.garage ??= nearestGarage(world, pos);
        if (!u.garage) { this.drive(v, { kind: "stop" }); return; }
        const width = v.method<number>("get_CleaningWidth").invoke();
        if (!u.planner) {
            const ground = (p: Vec3) => surfacePoint(world, p);
            u.planner = new LanePlanner(Math.max(1, width), PLAN_RADII, ground, LANE_END_M);
            ensureHopper(world, SENSOR_ID, 100_000);
        }
        // Work where Aryan left it (he drove the rover to dusty ground and it went back to the swept,
        // belt-filled base). The garage is only where it unloads.
        u.anchor ??= pos;
        u.planner.ensure(u.anchor, nowMs);
        u.trail.push({ t: nowMs, p: pos });
        while (u.trail.length > 1 && nowMs - u.trail[0].t > TRAIL_MS) u.trail.shift();
        const kg = v.method<number>("get_DustKilograms").invoke();
        const capKg = v.method<number>("get_DustCapacityKg").invoke();

        // Lanes: the next dusty lane start, or a point ahead on the lane being cleaned.
        let laneTarget: Vec3 | null = null;
        if (u.brain.state === "Work") {
            if (u.planner.cleaning) {
                const ahead = u.planner.target(pos, true, VEHICLE_AHEAD_M);
                if (ahead && !clearPath(pos, ahead)) u.planner.dropCurrent();
                else laneTarget = ahead;
            }
            if (!laneTarget) {
                laneTarget = u.planner.nextDirtyStart(pos, q => {
                    const g = surfacePoint(world, q);
                    return !covered(g) && openGround(g, Math.max(2, width)) && senseDirt(world, g, SENSOR_ID) > 0;
                }, SENSE_LANES);
                if (laneTarget && dist(pos, laneTarget) <= LANE_START_M) {
                    u.planner.begin(pos, kg);
                    laneTarget = u.planner.target(pos, true, VEHICLE_AHEAD_M);
                    u.nearSince = null;
                } else if (laneTarget && dist(pos, laneTarget) <= ORBIT_M) {
                    // Circling a lane start it can't turn onto (sandbox: minutes at 10.8 m/s): skip it.
                    u.nearSince ??= nowMs;
                    if (nowMs - u.nearSince > ORBIT_MS) {
                        u.planner.skipChosen();
                        u.nearSince = null;
                        laneTarget = null;
                    }
                } else {
                    u.nearSince = null;
                }
            }
        } else if (u.planner.cleaning) {
            u.planner.pause(pos);
        }

        const busyBy = this.padUser.get(u.garage.id);
        u.action = u.brain.step({
            pos, forward: toVec3(v.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_forward").invoke()),
            kg, capKg, laneTarget, cleaningLane: u.planner.cleaning, unloadSpot: u.garage.pad,
            padBusy: busyBy !== undefined && busyBy !== u.id, flipped: v.field<boolean>("<Flipped>k__BackingField").value as boolean,
            movedLast3s: dist(u.trail[0]?.p ?? pos, pos), nowMs, route: to => u.nav.next(pos, to, clearPath),
        });
        if (u.brain.state !== "Unload" && busyBy === u.id) this.padUser.delete(u.garage.id);

        // Far from Aryan the ground has no collider: the game holds an undriven vehicle still there
        // (FixedUpdate: !GroundSolid → heldStill, isKinematic; solid within ~450-550 m of him). Out
        // there autopilot moves the held body itself, along the ground, at the vehicle's top speed.
        const remote = !world.method<boolean>("GroundSolid").invoke(vector3(add(pos, scale(norm(pos), 0.5))));
        u.remote = remote;

        // Boxed in for good (reversing didn't free it): put it beside its garage and drop that lane.
        if (u.stuck.feed(dist(u.trail[0]?.p ?? pos, pos), u.action.kind === "drive" && !remote, nowMs)) {
            if (u.planner.cleaning) u.planner.dropCurrent(); else u.planner.skipChosen();
            u.nav.reset();
            u.recalls++;
            this.placeAt(world, v, u.garage.pad, pos);
            this.drive(v, { kind: "stop" });
            this.deps.notify(`${u.name} got stuck and was brought back to the garage`);
            return;
        }

        switch (u.action.kind) {
            case "drive":
                if (remote) {
                    this.drive(v, { kind: "stop" });
                    if (u.action.throttle > 0) this.moveHeld(world, v, pos, u.action.to, u.action.throttle);
                } else {
                    this.drive(v, u.action);
                }
                if (u.action.clean && nowMs >= u.nextStroke) {
                    u.nextStroke = nowMs + STROKE_MS;
                    if (u.lastStroke && dist(u.lastStroke, pos) > 0.05) {
                        const depth = v.field<Il2Cpp.Object>("<Spec>k__BackingField").value.field<number>("depth").value as number;
                        cleanStroke(world, u.lastStroke, pos, width, depth, 1, 0.05, u.id);
                    }
                    u.lastStroke = pos;
                    u.planner.progress(pos, kg);
                } else if (!u.action.clean) {
                    u.lastStroke = null;
                }
                break;
            case "unload": {
                this.drive(v, { kind: "stop" });
                this.padUser.set(u.garage.id, u.id);
                const reason = Memory.alloc(Process.pointerSize);
                reason.writePointer(NULL);
                const moved = world.method<number>("UnloadIntoGarage").invoke(
                    Il2Cpp.string(u.id), Il2Cpp.string(LOCAL_PLAYER), u.garage.id, UNLOAD_KG_PER_TICK, reason);
                if (moved > 0) {
                    u.kgUnloaded += moved;
                    if (kg - moved <= 1) this.deps.notify(`${u.name} unloaded at the garage`);
                }
                break;
            }
            case "flip":
                this.drive(v, { kind: "stop" });
                v.method("FlipUpright").invoke();
                break;
            default:
                this.drive(v, { kind: "stop" });
        }
    }

    /**
     * A vehicle with autopilot on that is stored in a garage (MoonOwnedVehicle.inWorld false) is
     * brought out at the garage nearest Aryan with MoonWorld.BringOut, as the garage's "take out"
     * does (Aryan bought autopilot for a stored Push sweeper and it never moved; sandbox: BringOut
     * spawned it at garage 11). Its own purchase garage may not exist in the scene at all.
     */
    private bringOutStored(world: Il2Cpp.Object, walker: Il2Cpp.Object, wanted: Set<string>, nowMs: number) {
        if (nowMs < this.nextBringOut || wanted.size === 0) return;
        this.nextBringOut = nowMs + BRING_OUT_MS;
        for (const { key, value: owned } of dictionaryEntries(world.field<Il2Cpp.Object>("ownedVehicles").value)) {
            const id = (key as unknown as Il2Cpp.String).content ?? "";
            if (!wanted.has(id) || owned.field<boolean>("inWorld").value) continue;
            const player = positionOf(walker);
            const garage = sceneObjects("MoonGarage").sort((a, b) => dist(positionOf(a), player) - dist(positionOf(b), player))[0];
            if (!garage) return;
            const v = world.method<Il2Cpp.Object>("BringOut").invoke(garage, owned.field<number>("vehicle").value as number, Il2Cpp.string(id));
            if (!v.isNull()) {
                const spec = v.field<Il2Cpp.Object>("<Spec>k__BackingField").value;
                this.deps.notify(`${spec.isNull() ? "Vehicle" : spec.field<Il2Cpp.String>("name").value.content} taken out of the garage: autopilot is on`);
            }
            return;   // one per call
        }
    }

    /** One tick of travel for a vehicle the game holds still: placed on the ground, facing its way. */
    private moveHeld(world: Il2Cpp.Object, v: Il2Cpp.Object, pos: Vec3, to: Vec3, throttle: number) {
        const gameSeconds = (UNIT_MS / 1000) * (core().class("UnityEngine.Time").method<number>("get_timeScale").invoke() as number);
        const speed = v.method<number>("get_MaximumSpeed").invoke() * Math.min(1, throttle);
        const d = dist(pos, to);
        if (d < 0.05) return;
        const heading = norm(tangent(pos, sub(to, pos)));
        this.placeAt(world, v, add(pos, scale(heading, Math.min(d, speed * gameSeconds))), pos);
    }

    /** Put the vehicle on the ground at `p`, upright, facing away from `from`, at rest. */
    private placeAt(world: Il2Cpp.Object, v: Il2Cpp.Object, p: Vec3, from: Vec3) {
        const at = surfacePoint(world, p);
        const up = norm(at);
        const away = sub(at, from);
        const heading = norm(tangent(at, Math.hypot(...away) > 0.01 ? away : [1, 0, 0]));
        const body = v.field<Il2Cpp.Object>("body").value;
        body.method("set_position").invoke(vector3(add(at, scale(up, HELD_CLEARANCE_M))));
        const Quat = core().class("UnityEngine.Quaternion");
        body.method("set_rotation").invoke(Quat.method<Il2Cpp.ValueType>("LookRotation", 2).invoke(vector3(heading), vector3(up)));
        if (!body.method<boolean>("get_isKinematic").invoke()) {
            body.method("set_linearVelocity").invoke(vector3([0, 0, 0]));
            body.method("set_angularVelocity").invoke(vector3([0, 0, 0]));
        }
    }

    private drive(v: Il2Cpp.Object, a: AutopilotAction | { kind: "stop" }) {
        inputs.set(v.handle.toString(), a.kind === "drive"
            ? { throttle: a.throttle, steer: a.steer, brake: false }
            : { throttle: 0, steer: 0, brake: true });
    }

    /** Hand a vehicle back (driver got in, autopilot switched off, vehicle stored): no more inputs. */
    private release(u: Unit) {
        if (u.handle) inputs.delete(u.handle);
        this.units.delete(u.id);
        for (const [g, id] of this.padUser) if (id === u.id) this.padUser.delete(g);
    }

    /** Let go of every vehicle (trainer off, shift over, crew session). */
    stop(): void {
        inputs.clear();
        this.units.clear();
        this.padUser.clear();
    }

    statusLines(): string[] {
        return [...this.units.values()].map(u => {
            const a = u.action.kind === "drive" ? ` throttle ${u.action.throttle.toFixed(2)} steer ${u.action.steer.toFixed(2)}` : "";
            return `${u.name} (autopilot${u.remote ? ", far from you" : ""}): ${u.brain.state} (${u.action.kind}${a}), garage ${u.garage?.id ?? "-"}, ` +
                `lanes ${u.planner?.remaining() ?? 0} left, ${u.kgUnloaded.toFixed(0)} kg unloaded, ${u.recalls} recalls`;
        });
    }
}
