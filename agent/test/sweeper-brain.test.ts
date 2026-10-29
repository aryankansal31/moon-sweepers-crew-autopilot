import { test } from "node:test";
import assert from "node:assert/strict";
import {
    SweeperBrain, STUCK_AFTER_MS, WORK_RADIUS_M, LEASH_M, LOSE_DIRT_M, HOPPER_KG, WALK_SPEED, helperPace, laneAhead, needsCatchUp,
    type SweeperInput,
} from "../src/crew/sweeper-brain.ts";
import { dist, dot, norm, sub, type Vec3 } from "../src/crew/vec.ts";

// Points on the moon's top (up = +z); x/y offsets are metres along the surface.
const R = 2015;
const at = (x: number, y: number): Vec3 => [x, y, R];

function input(over: Partial<SweeperInput> = {}): SweeperInput {
    return {
        pos: at(0, 0), playerPos: at(0, 0), hopperKg: 0, hopperCapKg: HOPPER_KG,
        nearestStation: at(50, 0), dirtyTarget: null, movedLast2s: 1, nowMs: 0, ...over,
    };
}

test("hopper empty, dirt 10 m away: walk to it, then clean once within 1.5 m", () => {
    const b = new SweeperBrain();
    const dirt = at(10, 0);
    const a = b.step(input({ dirtyTarget: dirt }));
    assert.equal(a.kind, "walk");
    assert.deepEqual(a.kind === "walk" && a.to, dirt);
    const c = b.step(input({ pos: at(9, 0), dirtyTarget: dirt, nowMs: 100 }));
    assert.equal(c.kind, "clean");
    assert.equal(b.state, "Clean");
});

test("full hopper: ToStation, walking to the nearest station", () => {
    const b = new SweeperBrain();
    const a = b.step(input({ hopperKg: HOPPER_KG, nearestStation: at(30, 5) }));
    assert.equal(b.state, "ToStation");
    assert.equal(a.kind, "walk");
    assert.deepEqual(a.kind === "walk" && a.to, at(30, 5));
});

test("ToStation keeps its station even if another becomes nearer", () => {
    const b = new SweeperBrain();
    b.step(input({ hopperKg: HOPPER_KG, nearestStation: at(30, 0) }));
    const a = b.step(input({ pos: at(5, 0), hopperKg: HOPPER_KG, nearestStation: at(-10, 0), nowMs: 100 }));
    assert.equal(a.kind, "walk");
    assert.deepEqual(a.kind === "walk" && a.to, at(30, 0));
});

test("within 2 m of the station: deposit, then Return (station beyond the leash)", () => {
    const b = new SweeperBrain();
    const s = at(LEASH_M + 10, 0);
    b.step(input({ hopperKg: HOPPER_KG, nearestStation: s }));
    const near = at(LEASH_M + 8.5, 0);
    const a = b.step(input({ pos: near, hopperKg: HOPPER_KG, nearestStation: s, nowMs: 100 }));
    assert.equal(a.kind, "deposit");
    b.step(input({ pos: near, hopperKg: 0, nearestStation: s, nowMs: 200 }));
    assert.equal(b.state, "Return");
});

// Lanes widen from WORK_RADIUS_M out to the leash when the area near the player is used up.
test("beyond the leash: walk back toward the player; inside it: carry on", () => {
    const b = new SweeperBrain();
    const far = LEASH_M + 15;
    const a = b.step(input({ pos: at(0, 0), playerPos: at(far, 0) }));
    assert.equal(a.kind, "walk");
    assert.ok(a.kind === "walk" && dist(a.to, at(far, 0)) < WORK_RADIUS_M);
    const c = b.step(input({ pos: at(far - LEASH_M + 5, 0), playerPos: at(far, 0), nowMs: 100 }));
    assert.equal(c.kind, "idle");
    assert.ok(LEASH_M > WORK_RADIUS_M);
});

test("stuck while walking for STUCK_AFTER_MS: unstick 2-4 m sideways", () => {
    const b = new SweeperBrain();
    const dirt = at(10, 0);
    b.step(input({ dirtyTarget: dirt, movedLast2s: 0.1, nowMs: 0 }));
    const a = b.step(input({ dirtyTarget: dirt, movedLast2s: 0.1, nowMs: STUCK_AFTER_MS }));
    assert.equal(a.kind, "unstick");
    if (a.kind !== "unstick") return;
    const off = sub(a.to, at(0, 0));
    const d = dist(a.to, at(0, 0));
    assert.ok(d >= 2 && d <= 4, `sideways distance ${d}`);
    assert.ok(Math.abs(dot(norm(off), [1, 0, 0])) < 0.2, "perpendicular to the walking direction");
});

test("three failed unsticks in a row: reposition", () => {
    const b = new SweeperBrain();
    const dirt = at(10, 0);
    const kinds: string[] = [];
    for (let i = 0; i <= 4; i++) {
        kinds.push(b.step(input({ dirtyTarget: dirt, movedLast2s: 0.1, nowMs: i * STUCK_AFTER_MS })).kind);
    }
    assert.deepEqual(kinds.filter(k => k === "unstick").length, 3);
    assert.equal(kinds[kinds.length - 1], "reposition");
});

test("no dirt, hopper not full, near the player: idle", () => {
    const b = new SweeperBrain();
    assert.equal(b.step(input({ pos: at(3, 0), playerPos: at(0, 0) })).kind, "idle");
});

// The lane planner keeps lanes inside the work radius and feeds a point ~1 m ahead while cleaning,
// so a clean action simply heads for that point (it turns with the lane at the lane's end).
test("cleaning heads toward the planner's point, turning when the point turns", () => {
    const b = new SweeperBrain();
    b.step(input({ dirtyTarget: at(1, 0) }));
    const first = b.step(input({ pos: at(0.5, 0), dirtyTarget: at(1.5, 0), nowMs: 100 }));
    assert.equal(first.kind, "clean");
    assert.ok(first.kind === "clean" && dot(first.along, [1, 0, 0]) > 0.99);
    const turned = b.step(input({ pos: at(5, 0), dirtyTarget: at(4, 1), nowMs: 200 }));
    assert.equal(turned.kind, "clean");
    assert.ok(turned.kind === "clean" && dot(turned.along, norm([-1, 1, 0])) > 0.99, "follows the new lane");
});

test("working on the outer 75 m lane ring is not 'left behind'", () => {
    // Regression: the catch-up jump used 60 m, inside the leash, so a sweeper heading for the 75 m
    // ring was put back beside the player every ~60 m and never reached a lane.
    assert.equal(needsCatchUp(at(75, 0), at(0, 0), "Seek"), false);
    assert.equal(needsCatchUp(at(LEASH_M, 0), at(0, 0), "Clean"), false);
});

test("a sweeper well past the leash (player drove off) catches up, except on a station trip", () => {
    assert.equal(needsCatchUp(at(300, 0), at(0, 0), "Seek"), true);
    assert.equal(needsCatchUp(at(300, 0), at(0, 0), "ToStation"), false);
});

test("helpers walk at the player's pace when it is given (Aryan runs ~11 m/s)", () => {
    const b = new SweeperBrain();
    const a = b.step(input({ dirtyTarget: at(30, 0), pace: 11.2 }));
    assert.ok(a.kind === "walk" && a.speed === 11.2);
    const full = new SweeperBrain();
    const t = full.step(input({ hopperKg: HOPPER_KG, pace: 11.2 }));
    assert.ok(t.kind === "walk" && t.speed === 11.2, "to the station too");
});

test("lane look-ahead at Aryan's pace stays inside the lose-dirt distance but covers a brain step", () => {
    // Regression: 4.5 m ahead at 11.2 m/s was beyond LOSE_DIRT_M (4 m), so every lane start flipped
    // straight back to Seek and the Sweeper never made a stroke.
    for (const pace of [1.4, 5, 11.2, 25]) {
        const ahead = laneAhead(pace, 200);
        assert.ok(ahead <= 3.5, `${pace} m/s: ${ahead} m`);
        assert.ok(ahead >= Math.min(pace * 0.2, 3.5), `${pace} m/s: covers a step`);
        assert.ok(ahead >= 1);
    }
});

test("terrain height between the sweeper and its lane target doesn't count as lost dirt", () => {
    // Regression: a 3.4 m look-ahead projected onto a bump 3 m higher measured 4.5 m and the brain
    // flipped to Seek mid-lane. The look-ahead plus a few metres of relief must stay inside the limit.
    assert.ok(LOSE_DIRT_M >= laneAhead(11.2, 200) + 4);
});

test("cleaning a lane whose target is the look-ahead point keeps cleaning (no Seek flip)", () => {
    const b = new SweeperBrain();
    b.step(input({ dirtyTarget: at(0.5, 0), pace: 11.2 }));
    const ahead = laneAhead(11.2, 200);
    const a = b.step(input({ pos: at(0.5, 0), dirtyTarget: at(0.5 + ahead, 0), pace: 11.2, nowMs: 200 }));
    assert.equal(a.kind, "clean");
    assert.equal(b.state, "Clean");
});

test("helpers move at half Aryan's pace, never slower than a walk, never absurdly fast", () => {
    assert.equal(helperPace(11.2), 5.6);
    assert.equal(helperPace(2), WALK_SPEED);
    assert.equal(helperPace(NaN), WALK_SPEED);
    assert.ok(helperPace(1000) <= 12.5);
});

test("a nearly full hopper (98%) counts as full: no hunting for the last kilo or two", () => {
    // Regression: Dusty sat at 148.7/150 kg seeking fresh dust instead of unloading.
    const b = new SweeperBrain();
    b.step(input({ hopperKg: 148.7, hopperCapKg: 150 }));
    assert.equal(b.state, "ToStation");
});

test("the search reaches well beyond a swept base (rings out to 250 m)", () => {
    assert.ok(LEASH_M >= 250);
    assert.equal(needsCatchUp(at(240, 0), at(0, 0), "Seek"), false);
});
