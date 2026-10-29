// The Sweeper's decisions. Pure: the crew manager feeds it what the world looks like each step
// and carries out the action it returns (walk the body, run a cleaning stroke, deposit).

import { add, cross, dist, norm, scale, sub, tangent, type Vec3 } from "./vec.ts";

export type SweeperState = "Seek" | "Clean" | "ToStation" | "Deposit" | "Return" | "Stuck";

export interface SweeperInput {
    pos: Vec3;
    playerPos: Vec3;
    hopperKg: number;
    hopperCapKg: number;
    nearestStation: Vec3 | null;
    dirtyTarget: Vec3 | null;
    movedLast2s: number;
    nowMs: number;
    /** Walking speed in m/s; the player's own pace in the game (WALK_SPEED when not given). */
    pace?: number;
}

export type SweeperAction =
    | { kind: "walk"; to: Vec3; speed: number }
    | { kind: "clean"; along: Vec3; width: number }
    | { kind: "deposit" }
    | { kind: "idle" }
    | { kind: "unstick"; to: Vec3 }
    | { kind: "reposition"; to: Vec3 };

export const WORK_RADIUS_M = 25;   // first ring of lanes around the player
// Lanes widen 20 → 45 → 75 → 150 → 250 m when the ground nearer the player is clean (a base swept
// by robots has no dust for a long way), so the leash sits just outside the widest ring.
export const LEASH_M = 265;
export const STUCK_AFTER_MS = 3000;
const STUCK_MOVED_M = 0.2;
const MAX_UNSTICKS = 3;
const UNSTICK_SIDEWAYS_M = 3;
const START_CLEAN_M = 1.5;     // close enough to dirt to start a lane
// Dirt this far away: stop the lane and walk to it. Room for the lane look-ahead (<= 3.5 m) plus
// terrain relief: the target is projected onto the ground and bumps add height to the distance.
export const LOSE_DIRT_M = 8;
const LANE_AHEAD_MAX_M = 3.5;
const AT_STATION_M = 2;

// Work rate. Tuned in Task 5 Step 6 for a 17-23 minute payback of the $450 price at 1x.
// Starting point: robot vacuums stroke with width/depth 0.92, dose 1, edge 0.05; the extra wide
// broom is 0.99 m wide.
// Payback target: $450 in ~20 min = $22.50/min = ~21 kg/min at $1.06/kg (dollarsPerKilogram 1 x
// payout 1.06 in the test save). Measured on fresh sandbox ground with 2 m strokes: dose makes no
// difference (one pass clears), width scales yield linearly, depth 2 adds ~37% over 0.92 → about
// 0.41 kg per metre at width 2, so ~30 kg/min while cleaning at 1.2 m/s, leaving room for lane
// changes and station trips. (Width 1.0 / 0.8 m/s / depth 0.92 managed 1.6 kg/min.)
// Run 2 (width 2, 1.2 m/s, 4x for 5 real min): 107 kg in ~10 game min, 150 kg deposited for
// $159.00 — about $11/min, a ~40 min payback; so width x1.5 and speed x1.33 below.
export const WALK_SPEED = 1.4;     // m/s, a player's walk
export const CLEAN_SPEED = 1.6;    // m/s along a lane while cleaning
export const CLEAN_WIDTH = 3.0;    // m, MoonWorld.CleanToolStroke width (also the lane spacing)
export const CLEAN_DEPTH = 2;      // CleanToolStroke depth
export const CLEAN_DOSE = 1;       // CleanToolStroke dose (no effect above 1 here)
export const CLEAN_EDGE = 0.05;    // CleanToolStroke edge width
export const HOPPER_KG = 150;
const FULL_SHARE = 0.98;           // this full counts as full (Dusty sat at 148.7/150 seeking dust)
// Past this the player has driven off and the sweeper rejoins them out of view. It must lie beyond
// LEASH_M: lanes go out to ~75 m, and inside the leash the brain walks back by itself.
export const CATCH_UP_M = LEASH_M + 15;

/** Has the player left the sweeper behind (drove off), so it should rejoin them? */
/**
 * How far ahead on its lane a cleaning sweeper aims, at `pace` m/s with a brain step every
 * `brainMs`. The target is re-aimed only once per step, so it should cover 1.5 steps of travel
 * (a fast sweeper otherwise stops at each target), but it must stay well inside LOSE_DIRT_M or the brain
 * reads the target as lost dirt and flips back to Seek every step.
 */
export function laneAhead(pace: number, brainMs: number): number {
    return Math.min(LANE_AHEAD_MAX_M, Math.max(1, pace * 1.5 * brainMs / 1000));
}

// Helpers move at half Aryan's running speed (his choice, 2026-10-28), never slower than a walk.
const HELPER_PACE_SHARE = 0.5;
const MAX_HELPER_PACE = 12.5;      // m/s; caps a runaway multiplier

/** A helper's walking/cleaning speed from the player's current running speed (m/s). */
export function helperPace(playerPace: number): number {
    if (!Number.isFinite(playerPace)) return WALK_SPEED;
    return Math.min(MAX_HELPER_PACE, Math.max(WALK_SPEED, playerPace * HELPER_PACE_SHARE));
}

export function needsCatchUp(pos: Vec3, playerPos: Vec3, state: SweeperState): boolean {
    return state !== "ToStation" && dist(pos, playerPos) > CATCH_UP_M;
}

export class SweeperBrain {
    state: SweeperState = "Seek";
    private station: Vec3 | null = null;
    private laneDir: Vec3 | null = null;
    private stuckSince: number | null = null;
    private unsticks = 0;

    step(i: SweeperInput): SweeperAction {
        const action = this.decide(i);
        return this.watchForStuck(i, action);
    }

    private decide(i: SweeperInput): SweeperAction {
        if (this.state === "Deposit") this.state = "Return";

        const full = i.hopperKg >= i.hopperCapKg * FULL_SHARE;   // 98%: no hunting for the last kilo
        if (full && this.state !== "ToStation" && i.nearestStation) {
            this.state = "ToStation";
            this.station = i.nearestStation;
            this.laneDir = null;
        }

        if (this.state === "ToStation") {
            const s = this.station ?? i.nearestStation;
            if (!s) return { kind: "idle" };
            this.station = s;
            if (dist(i.pos, s) <= AT_STATION_M) {
                this.state = "Deposit";
                this.station = null;
                return { kind: "deposit" };
            }
            return { kind: "walk", to: s, speed: i.pace ?? WALK_SPEED };
        }

        // Stay near Aryan: past the leash, head back toward him before doing anything else.
        if (dist(i.pos, i.playerPos) > LEASH_M) {
            this.state = this.state === "Return" ? "Return" : "Seek";
            this.laneDir = null;
            const toward = add(i.playerPos, scale(norm(sub(i.pos, i.playerPos)), WORK_RADIUS_M / 2));
            return { kind: "walk", to: toward, speed: i.pace ?? WALK_SPEED };
        }
        if (this.state === "Return" || this.state === "Stuck") this.state = "Seek";

        if (!i.dirtyTarget) {
            this.state = "Seek";
            this.laneDir = null;
            return { kind: "idle" };
        }

        if (this.state === "Clean") {
            if (dist(i.pos, i.dirtyTarget) > LOSE_DIRT_M) {
                this.state = "Seek";
                this.laneDir = null;
                return { kind: "walk", to: i.dirtyTarget, speed: i.pace ?? WALK_SPEED };
            }
            return { kind: "clean", along: this.toward(i), width: CLEAN_WIDTH };
        }

        if (dist(i.pos, i.dirtyTarget) <= START_CLEAN_M) {
            this.state = "Clean";
            return { kind: "clean", along: this.toward(i), width: CLEAN_WIDTH };
        }
        return { kind: "walk", to: i.dirtyTarget, speed: i.pace ?? WALK_SPEED };
    }

    /** Head for the planner's lane point (lanes.ts keeps lanes inside the work radius). */
    private toward(i: SweeperInput): Vec3 {
        const dir = norm(tangent(i.pos, sub(i.dirtyTarget!, i.pos)));
        if (!dir.every(v => v === 0)) this.laneDir = dir;
        return this.laneDir ?? norm(tangent(i.pos, [1, 0, 0]));
    }

    private watchForStuck(i: SweeperInput, action: SweeperAction): SweeperAction {
        if (action.kind !== "walk" && action.kind !== "clean") {
            this.stuckSince = null;
            return action;
        }
        if (i.movedLast2s >= STUCK_MOVED_M) {
            this.stuckSince = null;
            this.unsticks = 0;
            return action;
        }
        if (this.stuckSince === null) {
            this.stuckSince = i.nowMs;
            return action;
        }
        if (i.nowMs - this.stuckSince < STUCK_AFTER_MS) return action;

        this.stuckSince = i.nowMs;
        const goal = action.kind === "walk" ? action.to : add(i.pos, action.along);
        if (this.unsticks >= MAX_UNSTICKS) {
            this.unsticks = 0;
            return { kind: "reposition", to: goal };
        }
        this.unsticks++;
        const heading = norm(tangent(i.pos, sub(goal, i.pos)));
        const side = norm(cross(heading, norm(i.pos)));
        return { kind: "unstick", to: add(i.pos, scale(side, UNSTICK_SIDEWAYS_M)) };
    }
}
