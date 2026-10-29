import { test } from "node:test";
import assert from "node:assert/strict";
import { LanePlanner, REANCHOR_M, LANE_REFRESH_MS, LANE_SEGMENT_M } from "../src/crew/lanes.ts";
import { dist, type Vec3 } from "../src/crew/vec.ts";

const R = 2015;
const at = (x: number, y: number): Vec3 => [x, y, R];
const flat = (p: Vec3) => Math.hypot(p[0], p[1]);  // distance from the anchor at (0,0) along the surface

test("lanes are spaced one width apart and stay inside the radius", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const lanes = p.lanes();
    assert.ok(lanes.length >= 18 && lanes.length <= 21, `lane count ${lanes.length}`);
    for (const l of lanes) {
        assert.ok(flat(l.a) <= 10.01 && flat(l.b) <= 10.01, "inside the work radius");
    }
});

test("first target is the start of the nearest lane, at its nearer end", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const t = p.target(at(0, 0), false)!;
    assert.ok(t);
    assert.ok(flat(t) <= 10.01);
    const nearestEnd = Math.min(...p.lanes().flatMap(l => [dist(l.a, at(0, 0)), dist(l.b, at(0, 0))]));
    assert.ok(Math.abs(dist(t, at(0, 0)) - nearestEnd) < 1e-6);
});

test("while cleaning, the target is about 1 m ahead on the lane", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const ahead = p.target(start, true)!;
    assert.ok(Math.abs(dist(ahead, start) - 1) < 0.05, `ahead by ${dist(ahead, start)}`);
});

test("reaching the lane end completes it and moves on to another lane", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const end = p.currentEnd()!;
    const before = p.remaining();
    p.progress(end, 0.4);
    assert.equal(p.remaining(), before - 1);
    const next = p.target(end, false)!;
    assert.ok(dist(next, end) < 3, "next lane starts next to the finished one");
});

test("a lane that yields almost nothing is recorded as clean", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 5);
    p.progress(p.currentEnd()!, 5.001);
    assert.equal(p.cleanLanes(), 1);
});

test("all lanes done: no target until the refresh time", () => {
    const p = new LanePlanner(4, 6);
    p.ensure(at(0, 0), 0);
    let pos = at(0, 0);
    for (let i = 0; i < 50 && p.remaining() > 0; i++) {
        const s = p.target(pos, false)!;
        p.begin(s, 0);
        pos = p.currentEnd()!;
        p.progress(pos, 0);
    }
    assert.equal(p.target(pos, false), null);
    p.ensure(at(0, 0), LANE_REFRESH_MS + 1);
    assert.ok(p.target(pos, false));
});

// Lanes are planned on a flat plane, but the body walks on real terrain (hills, craters): a lane
// end can be metres above or below where the body actually stands.
test("a lane completes by ground distance even when the terrain there is 3 m higher", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const end = p.currentEnd()!;
    const before = p.remaining();
    const onHill: Vec3 = [end[0], end[1], end[2] + 3];
    p.progress(onHill, 1);
    assert.equal(p.remaining(), before - 1);
});

test("the ahead point follows ground position along the lane, ignoring height", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const end = p.currentEnd()!;
    const mid: Vec3 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, R - 2];  // in a 2 m dip
    const ahead = p.target(mid, true)!;
    const flatMid: Vec3 = [mid[0], mid[1], R];
    assert.ok(Math.abs(dist(ahead, flatMid) - 1) < 0.05, `ahead of the ground position by ${dist(ahead, flatMid)}`);
});

// The dirt sensor (a tiny-dose CleanToolStroke) says whether a point is dusty; lanes it finds
// clean at their start, middle and end are skipped without being walked.
test("nextDirtyStart skips clean lanes and returns the nearest dirty lane's start", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const isDirty = (q: Vec3) => q[1] > 4;  // only lanes well to one side are dusty
    const s = p.nextDirtyStart(at(0, 0), isDirty, 100)!;
    assert.ok(s, "found a dirty lane");
    assert.ok(s[1] > 4, `start is on the dusty side (y ${s[1].toFixed(2)})`);
    assert.ok(p.cleanLanes() > 0, "lanes found clean were marked done");
});

test("nextDirtyStart probes at most `budget` lanes per call and resumes next call", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    let probes = 0;
    const isDirty = (q: Vec3) => { probes++; return q[1] > 8; };
    const first = p.nextDirtyStart(at(0, 0), isDirty, 2);
    assert.equal(first, null, "budget ran out before reaching dirt");
    assert.ok(probes <= 2 * 3, `probed ${probes} points for 2 lanes`);
    let found: Vec3 | null = null;
    for (let i = 0; i < 20 && !found; i++) found = p.nextDirtyStart(at(0, 0), isDirty, 2);
    assert.ok(found && found[1] > 8);
});

test("begin() starts the lane nextDirtyStart chose", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const s = p.nextDirtyStart(at(0, 0), q => q[1] > 4, 100)!;
    p.begin(s, 0);
    const end = p.currentEnd()!;
    assert.ok(Math.abs(end[1] - s[1]) < 1e-6, "same lane (same y)");
});

test("all lanes clean: nextDirtyStart returns null", () => {
    const p = new LanePlanner(2, 6);
    p.ensure(at(0, 0), 0);
    let r: Vec3 | null = at(0, 0);
    for (let i = 0; i < 20 && p.remaining() > 0; i++) r = p.nextDirtyStart(at(0, 0), () => false, 3);
    assert.equal(p.remaining(), 0);
    assert.equal(p.nextDirtyStart(at(0, 0), () => false, 3), null);
});

// The area right around a standing player runs out; rather than idle, widen the search ring.
test("an exhausted plan widens to the next radius right away, then resets when the player moves", () => {
    const p = new LanePlanner(2, [10, 20]);
    p.ensure(at(0, 0), 0);
    for (const l of p.lanes()) { l.done = true; }
    p.ensure(at(0, 0), 1000);  // well before LANE_REFRESH_MS
    assert.ok(p.remaining() > 0, "new lanes planned immediately");
    assert.ok(p.lanes().some(l => flat(l.a) > 10.5), "lanes now reach past the first radius");
    p.ensure(at(REANCHOR_M + 1, 0), 2000);
    for (const l of p.lanes()) assert.ok(dist(l.a, at(REANCHOR_M + 1, 0)) <= 10.01, "back to the first radius");
});

test("the widest radius exhausted: wait for the refresh time", () => {
    const p = new LanePlanner(2, [6, 8]);
    p.ensure(at(0, 0), 0);
    for (const l of p.lanes()) l.done = true;
    p.ensure(at(0, 0), 10);
    for (const l of p.lanes()) l.done = true;
    p.ensure(at(0, 0), 20);
    assert.equal(p.remaining(), 0, "nothing left at the widest radius yet");
    p.ensure(at(0, 0), 20 + LANE_REFRESH_MS + 1);
    assert.ok(p.remaining() > 0);
});

test("re-plans around the player after they move more than REANCHOR_M", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    p.ensure(at(REANCHOR_M + 1, 0), 10);
    for (const l of p.lanes()) {
        assert.ok(dist(l.a, at(REANCHOR_M + 1, 0)) <= 10.01, "lanes now centred on the player");
    }
});

test("lanes are built on the ground: ends pass through the given projection", () => {
    // Regression: lanes stayed on a flat plane through the player, 22 m above a dip in the terrain,
    // so lane targets floated in the air and the Sweeper crawled and looped.
    const dip = (p: Vec3): Vec3 => [p[0], p[1], p[2] - 22];
    const p = new LanePlanner(1, 10, dip);
    p.ensure(at(0, 0), 0);
    for (const l of p.lanes()) {
        assert.equal(l.a[2], R - 22);
        assert.equal(l.b[2], R - 22);
    }
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    assert.equal(p.target(start, true, 3)![2], R - 22, "targets on the ground too");
});

test("a fast sweeper aims further ahead on its lane (target is re-aimed only every brain step)", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const near = p.target(start, true, 1)!;
    const far = p.target(start, true, 4)!;
    assert.ok(Math.abs(dist(start, near) - 1) < 0.05);
    assert.ok(Math.abs(dist(start, far) - 4) < 0.05);
});

test("a lane start the vehicle can't reach is skipped: done, and the next dusty one is offered", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const first = p.nextDirtyStart(at(0, 0), () => true, 3)!;
    const before = p.remaining();
    p.skipChosen();
    assert.equal(p.remaining(), before - 1);
    const next = p.nextDirtyStart(at(0, 0), () => true, 3)!;
    assert.notDeepEqual(next, first);
});

test("a vehicle's lanes finish within a looser distance of the end (it can't hit a point exactly)", () => {
    const p = new LanePlanner(3, 30, q => q, 3);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const end = p.currentEnd()!;
    const near: Vec3 = [end[0] + 2, end[1], end[2]];
    p.progress(near, 1);
    assert.equal(p.cleaning, false, "2 m from the end counts as done");
});

test("wide rings are cut into short lanes (the moon curves under a long straight one)", () => {
    // Regression: at the 250 m ring a 500 m lane's straight chord ran ~30 m under the ground, the
    // Sweeper's progress along it never advanced and it walked on the spot.
    const p = new LanePlanner(3, 250);
    p.ensure(at(0, 0), 0);
    for (const l of p.lanes()) assert.ok(dist(l.a, l.b) <= LANE_SEGMENT_M + 1e-6, `lane ${dist(l.a, l.b).toFixed(1)} m`);
    const total = p.lanes().reduce((s, l) => s + dist(l.a, l.b), 0);
    assert.ok(total > Math.PI * 250 * 250 / 3 * 0.95, "still covers the whole disc");
});

test("consecutive segments of a row chain: the next start is where the last one ended", () => {
    const p = new LanePlanner(3, 100);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const end = p.currentEnd()!;
    p.progress(end, 1);
    assert.ok(dist(p.target(end, false)!, end) < 0.01, "carries on from the same point");
});

test("a paused lane resumes where it was left, not from its start", () => {
    // Regression: on rough ground the Sweeper lost its lane target, paused, and Seek sent it back to
    // the same lane's start every time, so a long lane was never finished.
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const end = p.currentEnd()!;
    const along = (t: number): Vec3 => [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, R];
    const halfway = along(0.5);
    p.pause(halfway);
    const resume = p.target(halfway, false)!;
    assert.ok(dist(resume, halfway) < 0.5, `resumes at ${resume}, left at ${halfway}`);
    assert.ok(dist(resume, start) > 1, "not back at the start");
});

test("a lane blocked by a building is dropped: done, not cleaning, and not picked again", () => {
    const p = new LanePlanner(1, 10);
    p.ensure(at(0, 0), 0);
    const start = p.target(at(0, 0), false)!;
    p.begin(start, 0);
    const before = p.remaining();
    p.dropCurrent();
    assert.equal(p.cleaning, false);
    assert.equal(p.remaining(), before - 1);
    assert.notDeepEqual(p.target(start, false), start);
});
