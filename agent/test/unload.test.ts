import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseUnload } from "../src/crew/unload.ts";
import type { Vec3 } from "../src/crew/vec.ts";

const R = 2015;
const at = (x: number, y: number): Vec3 => [x, y, R];
const station = at(50, 0);

test("a packager with room is used instead of the station, even if the station is nearer", () => {
    const t = chooseUnload(at(0, 0), [{ id: 16, pos: at(80, 0), roomKg: 40 }], station);
    assert.deepEqual(t, { kind: "packager", id: 16, pos: at(80, 0) });
});

test("the nearest packager with room wins; full ones are skipped", () => {
    const t = chooseUnload(at(0, 0), [
        { id: 1, pos: at(10, 0), roomKg: 0.2 },
        { id: 2, pos: at(30, 0), roomKg: 60 },
        { id: 3, pos: at(90, 0), roomKg: 100 },
    ], station);
    assert.deepEqual(t, { kind: "packager", id: 2, pos: at(30, 0) });
});

test("every packager full: go to the nearest one and wait for room (never sell instead)", () => {
    const t = chooseUnload(at(0, 0), [{ id: 1, pos: at(70, 0), roomKg: 0 }, { id: 2, pos: at(20, 0), roomKg: 0.5 }], station);
    assert.deepEqual(t, { kind: "packager", id: 2, pos: at(20, 0) });
});

test("no packager built: deposit at the station as before", () => {
    assert.deepEqual(chooseUnload(at(0, 0), [], station), { kind: "station", pos: station });
});

test("nothing to unload into at all", () => {
    assert.equal(chooseUnload(at(0, 0), [], null), null);
});
