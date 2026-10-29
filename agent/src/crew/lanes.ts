// Where the Sweeper cleans: parallel lanes, one cleaning width apart, across a circle around the
// player. Pure. The game has no simple "is this spot dusty" query (MoonWorld.ProbeDust works on
// building footprints through delegates), so dirt is judged by what each lane actually yields:
// a lane that adds almost nothing to the hopper was already clean.

import { add, cross, dist, dot, norm, scale, sub, tangent, type Vec3 } from "./vec.ts";

export const REANCHOR_M = 8;            // player moved this far: plan new lanes around them
export const LANE_REFRESH_MS = 180_000; // all lanes swept: start over after this long
export const AHEAD_M = 1;               // while cleaning, aim this far ahead on the lane
export const LANE_SEGMENT_M = 20;       // rows are cut into lanes no longer than this
const LANE_END_M = 0.6;                 // this close to the end counts as finished
const CLEAN_LANE_KG = 0.05;             // a lane yielding less than this was already clean

export interface Lane { a: Vec3; b: Vec3; done: boolean; yieldKg: number }

export class LanePlanner {
    private anchor: Vec3 | null = null;
    private plannedAt = 0;
    private all: Lane[] = [];
    private current: { lane: Lane; from: Vec3; to: Vec3; kgAtStart: number } | null = null;
    private chosen: { lane: Lane; start: Vec3; end: Vec3 } | null = null;
    private width: number;
    private radii: number[];
    private level = 0;

    /**
     * `radius` may be a list: when the plan is used up, the next (wider) ring is planned.
     * `project` puts lane ends on the ground (in the game, MoonWorld.SurfaceAt): a flat plan through
     * the player floats metres above dips in the terrain, and lane targets up there made the Sweeper
     * crawl and loop.
     */
    constructor(width: number, radius: number | number[], project: (p: Vec3) => Vec3 = p => p, endM = LANE_END_M) {
        this.width = width;
        this.radii = Array.isArray(radius) ? radius : [radius];
        this.project = project;
        this.endM = endM;
    }
    private project: (p: Vec3) => Vec3;
    private endM: number;               // this close to a lane's end counts as finished (vehicles: looser)

    private get radius(): number { return this.radii[this.level]; }

    /**
     * Keep the plan centred on the player. A player who moved on gets a fresh plan at the first
     * radius; a used-up plan widens to the next radius at once, and after the widest one waits
     * LANE_REFRESH_MS before starting over.
     */
    ensure(player: Vec3, nowMs: number): void {
        if (!this.anchor || dist(this.anchor, player) > REANCHOR_M) {
            this.level = 0;
            this.rebuild(player, nowMs);
            return;
        }
        if (this.remaining() > 0) return;
        if (this.level < this.radii.length - 1) {
            this.level++;
            this.rebuild(this.anchor, nowMs);
        } else if (nowMs - this.plannedAt > LANE_REFRESH_MS) {
            this.level = 0;
            this.rebuild(this.anchor, nowMs);
        }
    }

    private rebuild(anchor: Vec3, nowMs: number) {
        this.anchor = anchor;
        this.plannedAt = nowMs;
        this.current = null;
        this.chosen = null;
        this.all = this.build(anchor);
    }

    private build(c: Vec3): Lane[] {
        const up = norm(c);
        const e1 = norm(tangent(c, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
        const e2 = norm(cross(up, e1));
        const lanes: Lane[] = [];
        for (let y = -this.radius + this.width / 2; y <= this.radius - this.width / 2 + 1e-9; y += this.width) {
            const half = Math.sqrt(Math.max(0, this.radius * this.radius - y * y));
            if (half < this.width) continue;
            const mid = add(c, scale(e2, y));
            // Each row in short segments: the moon curves away under a long straight lane (a 500 m one
            // at the 250 m ring runs ~30 m underground), and progress measured along it stalls.
            const a = add(mid, scale(e1, -half));
            const n = Math.ceil((2 * half) / LANE_SEGMENT_M - 1e-9);
            for (let k = 0; k < n; k++) {
                lanes.push({
                    a: this.project(add(a, scale(e1, (2 * half * k) / n))),
                    b: this.project(add(a, scale(e1, (2 * half * (k + 1)) / n))),
                    done: false, yieldKg: 0,
                });
            }
        }
        return lanes;
    }

    /** Distance along the ground: the lanes are flat, the terrain under them is not. */
    private ground(a: Vec3, b: Vec3): number {
        const d = sub(a, b);
        return this.anchor ? dist(tangent(this.anchor, d), [0, 0, 0]) : dist(a, b);
    }

    lanes(): Lane[] { return this.all; }
    remaining(): number { return this.all.filter(l => !l.done).length; }
    cleanLanes(): number { return this.all.filter(l => l.done && l.yieldKg < CLEAN_LANE_KG).length; }
    currentEnd(): Vec3 | null { return this.current?.to ?? null; }

    /**
     * Next place to go: a lane start, or (while cleaning) a point `ahead` metres on along the current
     * lane. The target is only re-aimed every brain step, so a fast sweeper needs a longer `ahead`
     * or it stops and waits at each target.
     */
    target(pos: Vec3, cleaning: boolean, ahead = AHEAD_M): Vec3 | null {
        if (cleaning && this.current) {
            const { from, to } = this.current;
            const along = norm(sub(to, from));
            const t = Math.min(dist(from, to), Math.max(0, dot(sub(pos, from), along)) + ahead);
            return add(from, scale(along, t));
        }
        const next = this.nearestStart(pos);
        return next ? next.start : null;
    }

    private nearestStart(pos: Vec3): { lane: Lane; start: Vec3; end: Vec3 } | null {
        let best: { lane: Lane; start: Vec3; end: Vec3 } | null = null, bestD = Infinity;
        for (const l of this.all) {
            if (l.done) continue;
            for (const [s, e] of [[l.a, l.b], [l.b, l.a]] as const) {
                const d = this.ground(pos, s);
                if (d < bestD) { bestD = d; best = { lane: l, start: s, end: e }; }
            }
        }
        return best;
    }

    /**
     * The start of the nearest unswept lane that has dust, using a dirt sensor (in the game, a
     * tiny-dose CleanToolStroke that reports dusty cells while removing ~nothing). Lanes clean at
     * their start, middle and end are marked done without being walked. At most `budget` lanes are
     * probed per call, so a long run of clean lanes is spread over several ticks (null until then).
     */
    nextDirtyStart(pos: Vec3, isDirty: (p: Vec3) => boolean, budget: number): Vec3 | null {
        if (this.chosen && !this.chosen.lane.done) return this.chosen.start;
        for (let n = 0; n < budget; n++) {
            const next = this.nearestStart(pos);
            if (!next) return null;
            const mid = scale(add(next.start, next.end), 0.5);
            if (isDirty(next.start) || isDirty(mid) || isDirty(next.end)) {
                this.chosen = next;
                return next.start;
            }
            next.lane.done = true;
            next.lane.yieldKg = 0;
        }
        return null;
    }

    /** The Sweeper has reached a lane start and begins cleaning it. */
    begin(pos: Vec3, hopperKg: number): void {
        const next = this.chosen && !this.chosen.lane.done ? this.chosen : this.nearestStart(pos);
        this.chosen = null;
        if (!next) return;
        this.current = { lane: next.lane, from: next.start, to: next.end, kgAtStart: hopperKg };
    }

    get cleaning(): boolean { return this.current !== null; }

    /** Call while cleaning: finishes the lane at its end and records its yield. */
    progress(pos: Vec3, hopperKg: number): void {
        if (!this.current || this.ground(pos, this.current.to) > this.endM) return;
        this.current.lane.done = true;
        this.current.lane.yieldKg = Math.max(0, hopperKg - this.current.kgAtStart);
        this.current = null;
    }

    /**
     * Abandon the current lane for now (e.g. the hopper filled up); it stays undone for later. With
     * `pos`, the lane's start moves up to how far it got, so it resumes there instead of starting over.
     */
    pause(pos?: Vec3): void {
        const c = this.current;
        this.current = null;
        if (!c || !pos) return;
        const along = norm(sub(c.to, c.from));
        const t = Math.min(dist(c.from, c.to), Math.max(0, dot(sub(pos, c.from), along)));
        const reached = add(c.from, scale(along, t));
        if (c.lane.a === c.from) c.lane.a = reached; else c.lane.b = reached;
    }

    /** Give up the lane start offered by nextDirtyStart (a vehicle couldn't reach it): done for now. */
    skipChosen(): void {
        if (!this.chosen) return;
        this.chosen.lane.done = true;
        this.chosen.lane.yieldKg = 0;
        this.chosen = null;
    }

    /** Give up the current lane for good (it runs into a building): done, never picked again. */
    dropCurrent(): void {
        if (!this.current) return;
        this.current.lane.done = true;
        this.current.lane.yieldKg = 0;
        this.current = null;
    }
}
