// Walking around buildings. Pure: the game adapter supplies clear(a, b), a knee-height raycast
// between two ground points that ignores terrain (world.ts clearPath). Helpers have no collider of
// their own, so without this they walk straight through walls.
//
// Each call looks LOOK_M ahead toward the target. If that stretch is blocked it picks the
// shortest sidestep that is reachable and from which the way on is open, keeps turning the same
// way round the same obstacle (no zig-zag), and drops the waypoint once the direct way is clear.

import { add, cross, dist, norm, scale, sub, tangent, type Vec3 } from "./vec.ts";

const LOOK_M = 12;                       // check this far ahead on the direct way
const ROUND_LOOK_M = 40;                 // ...and this far while going round an obstacle
const REACHED_M = 0.8;                   // a waypoint this close counts as reached
const ANGLES = [30, 60, 90, 120, 150];   // degrees off the direct heading, tried in order
const RANGES = [3, 6, 10, 16];           // metres to the sidestep point
const FOLLOW_MIN_M = 6;                  // a wall-following step at least this long (shorter ones dither)

export type Clear = (a: Vec3, b: Vec3) => boolean;

export class Navigator {
    private waypoint: Vec3 | null = null;
    private side = 0;                    // +1 / -1: which way we're going round; 0 = undecided

    /** Where to walk now on the way from `pos` to `to`. */
    next(pos: Vec3, to: Vec3, clear: Clear): Vec3 {
        if (clear(pos, this.along(pos, to, this.look))) {
            this.waypoint = null;
            this.side = 0;
            return to;
        }
        if (this.waypoint && dist(pos, this.waypoint) > REACHED_M && clear(pos, this.waypoint)) return this.waypoint;
        this.waypoint = this.sidestep(pos, to, clear);
        return this.waypoint ?? to;
    }

    /**
     * How far ahead the way must be open. Normally LOOK_M (re-checked as the helper walks). While
     * going round an obstacle, much further: a short look-ahead reads "open" again just short of the
     * wall, and the helper would turn back into it.
     */
    private get look(): number { return this.side ? ROUND_LOOK_M : LOOK_M; }

    reset(): void {
        this.waypoint = null;
        this.side = 0;
    }

    private along(pos: Vec3, to: Vec3, m: number): Vec3 {
        const d = dist(pos, to);
        return d <= m ? to : add(pos, scale(norm(sub(to, pos)), m));
    }

    private sidestep(pos: Vec3, to: Vec3, clear: Clear): Vec3 | null {
        const up = norm(pos);
        const heading = norm(tangent(pos, sub(to, pos)));
        const left = norm(cross(up, heading));
        const sides = this.side ? [this.side, -this.side] : [1, -1];
        let best: { p: Vec3; cost: number; side: number } | null = null;
        for (const side of sides) {
            for (const deg of ANGLES) {
                const a = (deg * Math.PI) / 180;
                const dir = add(scale(heading, Math.cos(a)), scale(left, side * Math.sin(a)));
                for (const r of RANGES) {
                    const p = add(pos, scale(dir, r));
                    if (!clear(pos, p)) break;            // further out on this ray is blocked too
                    // Only sidesteps that get closer count: backing off makes a short look-ahead read
                    // "open" again just short of the wall, and the helper would turn back into it.
                    if (dist(p, to) >= dist(pos, to) - 0.5) continue;
                    if (!clear(p, this.along(p, to, ROUND_LOOK_M))) continue;
                    const cost = r + dist(p, to);
                    if (!best || cost < best.cost) best = { p, cost, side };
                    break;                                  // nearest open point on this ray is enough
                }
            }
            if (best && side === sides[0] && this.side) break;  // stay on the side we chose
        }
        if (!best) best = this.followWall(pos, heading, left, sides, clear, to);
        if (!best) return null;
        this.side = best.side;
        return best.p;
    }

    /**
     * No sidestep opens the way: the obstacle is wider than one step (a station hall is ~40 m).
     * Follow its wall: the reachable point closest to the target's heading, at least FOLLOW_MIN_M
     * away, on the side we're going round. Repeated calls walk round any roughly convex building.
     */
    private followWall(pos: Vec3, heading: Vec3, left: Vec3, sides: number[], clear: Clear, to: Vec3) {
        for (const side of sides) {
            for (const deg of ANGLES) {
                const a = (deg * Math.PI) / 180;
                const dir = add(scale(heading, Math.cos(a)), scale(left, side * Math.sin(a)));
                let reach: Vec3 | null = null;
                for (const r of RANGES) {
                    const p = add(pos, scale(dir, r));
                    if (!clear(pos, p)) break;
                    reach = p;
                }
                if (reach && dist(pos, reach) >= FOLLOW_MIN_M) return { p: reach, cost: dist(reach, to), side };
            }
            if (this.side) break;  // stay on the side we chose
        }
        return null;
    }
}
