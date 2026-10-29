import { test } from "node:test";
import assert from "node:assert/strict";
import { Navigator } from "../src/crew/nav.ts";
import { dist, type Vec3 } from "../src/crew/vec.ts";

// Flat patch on the moon's top: up = +z, x/y in metres along the ground.
const R = 2015;
const at = (x: number, y: number): Vec3 => [x, y, R];

// A wall from (5,-4) to (5,4): a straight path crossing x = 5 within |y| <= 4 is blocked.
function crosses(a: Vec3, b: Vec3, wx: number, y0: number, y1: number): boolean {
    if ((a[0] - wx) * (b[0] - wx) > 0 || a[0] === b[0]) return false;
    const t = (wx - a[0]) / (b[0] - a[0]);
    const y = a[1] + t * (b[1] - a[1]);
    return y >= y0 && y <= y1;
}
const wall = (a: Vec3, b: Vec3) => !crosses(a, b, 5, -4, 4);

test("clear path: go straight to the target", () => {
    const n = new Navigator();
    assert.deepEqual(n.next(at(0, 0), at(20, 0), () => true), at(20, 0));
});

test("wall in the way: a waypoint the helper can reach, from which the way on is clear", () => {
    const n = new Navigator();
    const w = n.next(at(0, 0), at(20, 0), wall);
    assert.notDeepEqual(w, at(20, 0));
    assert.ok(wall(at(0, 0), w), "waypoint reachable");
    assert.ok(Math.abs(w[1]) > 4, "around the end of the wall");
});

test("following waypoints gets past the wall without ever crossing it", () => {
    const n = new Navigator();
    let pos = at(0, 0);
    const goal = at(20, 0);
    for (let i = 0; i < 20 && dist(pos, goal) > 0.5; i++) {
        const w = n.next(pos, goal, wall);
        assert.ok(wall(pos, w), `step ${i} crosses the wall`);
        pos = w;
    }
    assert.ok(dist(pos, goal) <= 0.5, "reached the goal");
});

test("keeps turning the same way round an obstacle (no left/right zig-zag)", () => {
    const n = new Navigator();
    const first = n.next(at(0, 0), at(20, 0), wall);
    const again = n.next(at(0, 0.2), at(20, 0), wall);
    assert.equal(Math.sign(first[1]), Math.sign(again[1]));
});

test("a building far wider than one sidestep: follows the wall round it and gets there", () => {
    // Regression: a station hall ~40 m across. One 16 m sidestep can't see past it, so the old
    // navigator gave up after one step and walked straight through the hall.
    const big = (a: Vec3, b: Vec3) => !crosses(a, b, 5, -25, 25);
    const n = new Navigator();
    let pos = at(0, 0);
    const goal = at(20, 0);
    for (let i = 0; i < 60 && dist(pos, goal) > 0.5; i++) {
        const w = n.next(pos, goal, big);
        assert.ok(big(pos, w), `step ${i} goes through the building`);
        pos = w;
    }
    assert.ok(dist(pos, goal) <= 0.5, `reached the goal (ended at ${pos})`);
});

test("nowhere to go: falls back to the target (stuck handling takes over)", () => {
    const n = new Navigator();
    assert.deepEqual(n.next(at(0, 0), at(20, 0), () => false), at(20, 0));
});
