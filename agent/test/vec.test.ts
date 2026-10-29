import { test } from "node:test";
import assert from "node:assert/strict";
import { add, arcDistance, dist, norm, pointAlong, scale, sub } from "../src/crew/vec.ts";

test("dist of a 3-4-5 triangle is 5", () => {
    assert.equal(dist([0, 0, 0], [3, 4, 0]), 5);
});

test("add, sub, scale and norm", () => {
    assert.deepEqual(add([1, 2, 3], [1, 1, 1]), [2, 3, 4]);
    assert.deepEqual(sub([1, 2, 3], [1, 1, 1]), [0, 1, 2]);
    assert.deepEqual(scale([1, 2, 3], 2), [2, 4, 6]);
    assert.deepEqual(norm([0, 0, 5]), [0, 0, 1]);
    assert.deepEqual(norm([0, 0, 0]), [0, 0, 0]);
});

test("arcDistance of orthogonal directions on a 2015 m moon is a quarter circumference", () => {
    assert.ok(Math.abs(arcDistance([1, 0, 0], [0, 2015, 0], 2015) - 2015 * Math.PI / 2) < 0.01);
});

// MoonDemoCrew.Step draws a member at position + (to - position) * t, t = travelled / length.
test("pointAlong walks the segment and stops at the end", () => {
    assert.deepEqual(pointAlong([0, 0, 0], [10, 0, 0], 4), [4, 0, 0]);
    assert.deepEqual(pointAlong([0, 0, 0], [10, 0, 0], 25), [10, 0, 0]);
    assert.deepEqual(pointAlong([2, 2, 2], [2, 2, 2], 3), [2, 2, 2]);
});
