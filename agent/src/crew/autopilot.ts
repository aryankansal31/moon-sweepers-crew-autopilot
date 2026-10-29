// Vehicle autopilot (Aryan, 2026-10-28): a vehicle with the Autopilot upgrade drives itself when
// nobody is driving it, cleans dust in lanes around its own garage, and when its hopper is full
// drives back to the garage's unload pad and empties into the garage collector. Pure: the game
// adapter (autopilot-driver.ts) feeds the vehicle's throttle/steer in its FixedUpdate (the game's
// own physics drive it; sandbox: 6.5 m/s, grounded and upright), strokes the cleaning itself into
// the vehicle's hopper, and unloads with MoonWorld.UnloadIntoGarage.

import { cross, dist, dot, norm, sub, tangent, type Vec3 } from "./vec.ts";

const MAX_STEER_DEG = 35;      // full lock at this angle off the target
const SLOW_TURN_DEG = 60;      // sharper than this: half throttle
const NEAR_M = 15;             // closer than this to the target: ease off to turn onto it (no orbiting)
const NEAR_THROTTLE = 0.35;
// The game's steer is the opposite of the usual "+ = right": with +1 here the sandbox Ride-on
// sweeper settled on heading straight away from its target (inverted steering makes that stable).
export const STEER_SIGN = -1;

/** Steering and throttle (-1..1) to head from `pos` (facing `forward`) toward `target`. */
export function steerToward(pos: Vec3, forward: Vec3, target: Vec3, slowNear = true): { steer: number; throttle: number } {
    const up = norm(pos);
    const f = norm(tangent(pos, forward));
    const d = norm(tangent(pos, sub(target, pos)));
    const left = Math.atan2(dot(cross(f, d), up), dot(f, d));          // + = target to the left
    const deg = (left * 180) / Math.PI;
    const raw = Math.max(-1, Math.min(1, -deg / MAX_STEER_DEG)) * STEER_SIGN;
    const steer = Math.abs(raw) < 1e-9 ? 0 : raw;
    let throttle = Math.abs(deg) > SLOW_TURN_DEG ? 0.5 : 1;
    if (slowNear && dist(pos, target) < NEAR_M) throttle = Math.min(throttle, NEAR_THROTTLE);
    return { steer, throttle };
}

// --- brain ----------------------------------------------------------------------------------------

export const UNLOAD_REACH_M = 4;   // this close to the unload pad: stop and unload
const WAIT_NEAR_M = 12;            // pad busy: wait this close
const FULL_SHARE = 0.98;           // hopper this full: go and unload
const EMPTY_KG = 1;                // unloaded down to this: back to work
const STUCK_MS = 3000;             // barely moved this long while driving: stuck
const STUCK_MOVED_M = 1;
const REVERSE_MS = 2000;           // then back out this long

export type AutopilotState = "Work" | "Return" | "Unload";

export interface AutopilotInput {
    pos: Vec3;
    forward: Vec3;
    kg: number;
    capKg: number;
    laneTarget: Vec3 | null;       // lane start, or a point ahead on the lane being cleaned
    cleaningLane: boolean;         // the target is on a lane being cleaned (stroke while driving)
    unloadSpot: Vec3 | null;       // the garage's unload pad
    padBusy: boolean;              // another vehicle is unloading there
    flipped: boolean;
    movedLast3s: number;
    nowMs: number;
    /** Where to steer on the way to a target (e.g. round a building); the target itself if absent. */
    route?: (to: Vec3) => Vec3;
}

export type AutopilotAction =
    | { kind: "drive"; throttle: number; steer: number; clean: boolean; to: Vec3 }  // to: where it is heading
    | { kind: "unload" }
    | { kind: "wait" }
    | { kind: "stop" }
    | { kind: "flip" };

export class AutopilotBrain {
    state: AutopilotState = "Work";
    private stuckSince: number | null = null;
    private reverseUntil = 0;
    private reverseSteer = 1;

    step(i: AutopilotInput): AutopilotAction {
        if (i.flipped) { this.stuckSince = null; return { kind: "flip" }; }
        const a = this.decide(i);
        return this.watchForStuck(i, a);
    }

    private decide(i: AutopilotInput): AutopilotAction {
        if (this.state === "Work" && i.kg >= i.capKg * FULL_SHARE && i.unloadSpot) this.state = "Return";
        if (this.state === "Unload" && i.kg <= EMPTY_KG) this.state = "Work";

        if (this.state === "Return" || this.state === "Unload") {
            if (!i.unloadSpot) { this.state = "Work"; return this.decide(i); }
            const d = dist(i.pos, i.unloadSpot);
            if (i.padBusy && d <= WAIT_NEAR_M) return { kind: "wait" };
            if (d <= UNLOAD_REACH_M) { this.state = "Unload"; return { kind: "unload" }; }
            this.state = "Return";
            const to = i.route ? i.route(i.unloadSpot) : i.unloadSpot;
            return { kind: "drive", ...steerToward(i.pos, i.forward, to), clean: false, to };
        }

        if (!i.laneTarget) return { kind: "stop" };
        // Along a lane the target is always a few metres ahead: no easing off there.
        const to = i.route ? i.route(i.laneTarget) : i.laneTarget;
        return { kind: "drive", ...steerToward(i.pos, i.forward, to, !i.cleaningLane), clean: i.cleaningLane, to };
    }

    private watchForStuck(i: AutopilotInput, a: AutopilotAction): AutopilotAction {
        if (i.nowMs < this.reverseUntil) return { kind: "drive", throttle: -0.6, steer: this.reverseSteer, clean: false, to: i.pos };
        if (a.kind !== "drive" || a.throttle <= 0 || i.movedLast3s >= STUCK_MOVED_M) {
            this.stuckSince = null;
            return a;
        }
        this.stuckSince ??= i.nowMs;
        if (i.nowMs - this.stuckSince < STUCK_MS) return a;
        this.stuckSince = null;
        this.reverseUntil = i.nowMs + REVERSE_MS;
        this.reverseSteer = a.steer >= 0 ? -1 : 1;   // back out turning the other way
        return { kind: "drive", throttle: -0.6, steer: this.reverseSteer, clean: false, to: i.pos };
    }
}

// --- recall when stuck for good -----------------------------------------------------------------------
// Reversing out (in the brain) frees most stuck vehicles; one boxed in by machines doesn't (sandbox:
// the Ride-on sweeper wedged between a kiln, press, dust tower and belts). After RECALL_MS without
// progress while trying to move, the adapter puts it on open ground beside its garage.

const RECALL_MS = 25_000;
const PROGRESS_M = 1;          // moved at least this far in the last 3 s: making progress

export class StuckWatch {
    private lastProgress: number | null = null;

    /** True once it has been trying to move for RECALL_MS since it last made progress (then resets). */
    feed(movedLast3s: number, tryingToMove: boolean, nowMs: number): boolean {
        if (!tryingToMove || movedLast3s >= PROGRESS_M || this.lastProgress === null) {
            this.lastProgress = nowMs;
            return false;
        }
        if (nowMs - this.lastProgress < RECALL_MS) return false;
        this.lastProgress = nowMs;
        return true;
    }
}

// --- garage row -----------------------------------------------------------------------------------
// What the Autopilot row and the details panel of the garage's Upgrades page say for one model.

export const AUTOPILOT_BASE_PRICE = 1000;    // x MoonVehicleUpgrades.PriceScale(vehicle), like the game's own

export interface AutopilotOffer {
    price: number;
    tag: string;                 // the row's price tag: "$1,000", "ON", "OFF"
    button: string;              // the details panel's action button
    enabled: boolean;
    action: "buy" | "toggle" | "none";
    status: string;              // a line under the button ("" when nothing to say)
}

const dollars = (n: number) => `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

export function autopilotOffer(s: { ownsVehicle: boolean; bought: boolean; on: boolean; priceScale: number; money: number; inCrewSession: boolean }): AutopilotOffer {
    const price = Math.round(AUTOPILOT_BASE_PRICE * (Number.isFinite(s.priceScale) && s.priceScale > 0 ? s.priceScale : 1));
    if (s.bought) {
        return { price, tag: s.on ? "ON" : "OFF", button: s.on ? "TURN OFF" : "TURN ON",
                 enabled: true, action: "toggle", status: s.on ? "Drives itself whenever nobody is driving it." : "Switched off: stays parked." };
    }
    const tag = dollars(price);
    if (!s.ownsVehicle) return { price, tag, button: "INSTALL", enabled: false, action: "none", status: "Buy this vehicle first." };
    if (s.inCrewSession) return { price, tag, button: "INSTALL", enabled: false, action: "none", status: "Autopilot works in solo shifts only." };
    if (s.money + 0.005 < price) return { price, tag, button: "INSTALL", enabled: false, action: "none", status: `Not enough money: ${tag} needed.` };
    return { price, tag, button: "INSTALL", enabled: true, action: "buy", status: "" };
}

// --- store ----------------------------------------------------------------------------------------
// autopilot.json next to crew.json: {"games": {gameKey: {storageId: {"on": bool, "boughtAt": iso}}}}.
// The agent owns it (the garage menu buys and switches); nothing else writes it.

interface Entry { on: boolean; boughtAt: string }
type Data = { games: Record<string, Record<string, Entry>> };

function parseStrict(json: string | null): Data | null {
    if (!json) return { games: {} };
    try {
        const d = JSON.parse(json);
        if (!d || typeof d !== "object" || Array.isArray(d)) return null;
        return { games: d.games && typeof d.games === "object" ? d.games : {} };
    } catch {
        return null;
    }
}

export class AutopilotStore {
    private data: Data;

    constructor(json: string | null) {
        this.data = parseStrict(json) ?? { games: {} };
    }

    static parse(json: string | null): AutopilotStore | null {
        return parseStrict(json) ? new AutopilotStore(json) : null;
    }

    owned(game: string, storage: string): boolean { return !!this.data.games[game]?.[storage]; }
    on(game: string, storage: string): boolean { return this.data.games[game]?.[storage]?.on === true; }

    buy(game: string, storage: string): void {
        const g = this.data.games[game] ??= {};
        g[storage] ??= { on: true, boughtAt: new Date().toISOString() };
    }

    setOn(game: string, storage: string, on: boolean): void {
        const e = this.data.games[game]?.[storage];
        if (e) e.on = on;
    }

    /** Storage ids of this game's vehicles with autopilot bought and switched on. */
    active(game: string): string[] {
        return Object.entries(this.data.games[game] ?? {}).filter(([, e]) => e.on).map(([id]) => id);
    }

    toJSON(): string { return JSON.stringify(this.data, null, 2); }
}
