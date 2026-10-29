import { test } from "node:test";
import assert from "node:assert/strict";
import { nextJob, HAULER_CAP_KG, type HaulWorld } from "../src/crew/hauler-brain.ts";
import type { Vec3 } from "../src/crew/vec.ts";

const R = 2015;
const at = (x: number, y: number): Vec3 => [x, y, R];

function world(over: Partial<HaulWorld> = {}): HaulWorld {
    return { docks: [], vehicles: [], canisters: [], carriedKg: 0, capKg: HAULER_CAP_KG, stationPos: at(100, 0), sellable: [], ...over };
}

test("capacity is 200 kg", () => assert.equal(HAULER_CAP_KG, 200));

test("a full dock comes before a parked vehicle", () => {
    const j = nextJob(world({
        docks: [{ id: "d1", pos: at(50, 0), full: true, machine: false }],
        vehicles: [{ id: "v1", pos: at(5, 0), kg: 80, driven: false, machine: false }],
    }), at(0, 0));
    assert.deepEqual(j && { kind: j.kind, id: (j as { id: string }).id }, { kind: "dock", id: "d1" });
});

test("a dock that isn't full is ignored", () => {
    const j = nextJob(world({ docks: [{ id: "d1", pos: at(5, 0), full: false, machine: false }] }), at(0, 0));
    assert.equal(j, null);
});

test("machine storage is never touched, even when full", () => {
    const j = nextJob(world({
        docks: [{ id: "d1", pos: at(5, 0), full: true, machine: true }],
        vehicles: [{ id: "v1", pos: at(5, 0), kg: 80, driven: false, machine: true }],
    }), at(0, 0));
    assert.equal(j, null);
});

test("a vehicle someone is driving is ignored", () => {
    const j = nextJob(world({ vehicles: [{ id: "v1", pos: at(5, 0), kg: 80, driven: true, machine: false }] }), at(0, 0));
    assert.equal(j, null);
});

test("an empty parked vehicle is ignored", () => {
    const j = nextJob(world({ vehicles: [{ id: "v1", pos: at(5, 0), kg: 0, driven: false, machine: false }] }), at(0, 0));
    assert.equal(j, null);
});

test("loose canisters come after docks and vehicles, nearest first", () => {
    const j = nextJob(world({ canisters: [{ id: 7, pos: at(30, 0), kg: 4 }, { id: 3, pos: at(10, 0), kg: 4 }] }), at(0, 0));
    assert.deepEqual(j && { kind: j.kind, id: (j as { id: number }).id }, { kind: "canister", id: 3 });
});

test("carrying a full load: deposit, whatever else is waiting", () => {
    const j = nextJob(world({
        carriedKg: HAULER_CAP_KG, docks: [{ id: "d1", pos: at(5, 0), full: true, machine: false }],
    }), at(0, 0));
    assert.deepEqual(j, { kind: "deposit", pos: at(100, 0) });
});

test("nothing to haul but holding dust: deposit", () => {
    assert.deepEqual(nextJob(world({ carriedKg: 12 }), at(0, 0)), { kind: "deposit", pos: at(100, 0) });
});

test("nothing to haul or deposit, a tray to sell: sell", () => {
    const j = nextJob(world({ sellable: [{ intakeId: "station-0", pos: at(100, 0) }] }), at(0, 0));
    assert.deepEqual(j, { kind: "sell", intakeId: "station-0", pos: at(100, 0) });
});

test("nothing at all: null", () => {
    assert.equal(nextJob(world(), at(0, 0)), null);
});
