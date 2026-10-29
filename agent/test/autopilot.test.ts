import { test } from "node:test";
import assert from "node:assert/strict";
import { AutopilotBrain, AutopilotStore, StuckWatch, autopilotOffer, steerToward, UNLOAD_REACH_M, type AutopilotInput } from "../src/crew/autopilot.ts";
import type { Vec3 } from "../src/crew/vec.ts";

// Flat patch on the moon's top: up = +z, x/y in metres along the ground.
const R = 2015;
const at = (x: number, y: number): Vec3 => [x, y, R];
const EAST: Vec3 = [1, 0, 0];

// --- steering ---------------------------------------------------------------------------------

test("target dead ahead: full throttle, no steering", () => {
    const s = steerToward(at(0, 0), EAST, at(30, 0));
    assert.equal(s.steer, 0);
    assert.equal(s.throttle, 1);
});

test("target to the left and to the right steer opposite ways, in proportion", () => {
    const left = steerToward(at(0, 0), EAST, at(30, 10)).steer;
    const right = steerToward(at(0, 0), EAST, at(30, -10)).steer;
    const sharpLeft = steerToward(at(0, 0), EAST, at(5, 20)).steer;
    assert.ok(left !== 0 && Math.sign(left) === -Math.sign(right));
    assert.ok(Math.abs(sharpLeft) > Math.abs(left));
    assert.ok(Math.abs(sharpLeft) <= 1);
});

test("approaching within 15 m it eases right off, so it can turn onto a lane instead of orbiting it", () => {
    // Regression: at 10.8 m/s the Ride-on sweeper circled a lane start for minutes without reaching it.
    assert.ok(steerToward(at(0, 0), EAST, at(12, 0)).throttle <= 0.4);
    assert.equal(steerToward(at(0, 0), EAST, at(40, 0)).throttle, 1);
});

test("a sharp turn or a nearby target slows the vehicle down", () => {
    assert.ok(steerToward(at(0, 0), EAST, at(-20, 5)).throttle < 1);
    assert.ok(steerToward(at(0, 0), EAST, at(3, 0)).throttle < 1);
});

// --- brain ------------------------------------------------------------------------------------

function input(over: Partial<AutopilotInput> = {}): AutopilotInput {
    return {
        pos: at(0, 0), forward: EAST, kg: 0, capKg: 650, laneTarget: at(30, 0), cleaningLane: false,
        unloadSpot: at(-50, 0), padBusy: false, flipped: false, movedLast3s: 5, nowMs: 0, ...over,
    };
}

test("working: drives to the lane target; cleans only while on a lane", () => {
    const b = new AutopilotBrain();
    const a = b.step(input());
    assert.equal(b.state, "Work");
    assert.equal(a.kind, "drive");
    assert.ok(a.kind === "drive" && !a.clean && a.throttle > 0);
    const c = b.step(input({ cleaningLane: true, nowMs: 100 }));
    assert.ok(c.kind === "drive" && c.clean);
});

test("full hopper: drives back to the garage's unload pad, not cleaning", () => {
    const b = new AutopilotBrain();
    const a = b.step(input({ kg: 650 }));
    assert.equal(b.state, "Return");
    assert.ok(a.kind === "drive" && !a.clean);
    const s = steerToward(at(0, 0), EAST, at(-50, 0));
    assert.ok(a.kind === "drive" && a.steer === s.steer, "heading for the pad");
});

test("on the pad: stops and unloads until empty, then goes back to work", () => {
    const b = new AutopilotBrain();
    b.step(input({ kg: 650 }));
    const pad = at(-50, 0);
    const u = b.step(input({ kg: 650, pos: at(-50 + UNLOAD_REACH_M / 2, 0), nowMs: 100 }));
    assert.equal(u.kind, "unload");
    assert.equal(b.state, "Unload");
    b.step(input({ kg: 200, pos: pad, nowMs: 200 }));
    assert.equal(b.state, "Unload", "still emptying");
    const w = b.step(input({ kg: 0, pos: pad, nowMs: 300 }));
    assert.equal(b.state, "Work");
    assert.equal(w.kind, "drive");
});

test("pad taken by another vehicle: waits nearby instead of unloading", () => {
    const b = new AutopilotBrain();
    b.step(input({ kg: 650 }));
    const a = b.step(input({ kg: 650, pos: at(-45, 0), padBusy: true, nowMs: 100 }));
    assert.equal(a.kind, "wait");
});

test("flipped over: asks to be set upright", () => {
    const b = new AutopilotBrain();
    assert.equal(b.step(input({ flipped: true })).kind, "flip");
});

test("stuck against something while driving: reverses with the wheel turned, then carries on", () => {
    const b = new AutopilotBrain();
    b.step(input({ nowMs: 0 }));
    b.step(input({ movedLast3s: 0.2, nowMs: 1000 }));
    const r = b.step(input({ movedLast3s: 0.2, nowMs: 4500 }));
    assert.ok(r.kind === "drive" && r.throttle < 0 && r.steer !== 0, "backing out");
    const later = b.step(input({ movedLast3s: 5, nowMs: 9000 }));
    assert.ok(later.kind === "drive" && later.throttle > 0, "forward again");
});

test("steers by the route (round a building) but measures arrival against the real target", () => {
    const b = new AutopilotBrain();
    const detour = at(0, 20);
    const a = b.step(input({ kg: 650, route: () => detour }));
    assert.ok(a.kind === "drive" && a.steer === steerToward(at(0, 0), EAST, detour).steer, "steering for the detour");
    const u = b.step(input({ kg: 650, pos: at(-49, 0), route: () => detour, nowMs: 100 }));
    assert.equal(u.kind, "unload", "arrival is judged at the pad, not the detour");
});

test("a drive action says where it is heading (used to move a far-away vehicle the game holds still)", () => {
    const b = new AutopilotBrain();
    const work = b.step(input({ route: () => at(5, 5) }));
    assert.ok(work.kind === "drive" && work.to[0] === 5 && work.to[1] === 5, "the routed point");
    const home = b.step(input({ kg: 650, nowMs: 100 }));
    assert.ok(home.kind === "drive" && home.to[0] === -50, "the unload pad");
});

test("nothing to clean: parks (stops) instead of wandering", () => {
    const b = new AutopilotBrain();
    assert.equal(b.step(input({ laneTarget: null })).kind, "stop");
});

// --- recall when stuck for good --------------------------------------------------------------------

test("no progress for 25 s while trying to move: recall it to the garage; any progress resets the clock", () => {
    const w = new StuckWatch();
    assert.equal(w.feed(0.1, true, 0), false);
    assert.equal(w.feed(0.1, true, 20_000), false);
    assert.equal(w.feed(3, true, 22_000), false, "moved: clock reset");
    assert.equal(w.feed(0.1, true, 30_000), false);
    assert.equal(w.feed(0.1, true, 47_500), true, "25 s without progress since 22 s");
    assert.equal(w.feed(0.1, true, 48_000), false, "reset after recalling");
});

test("standing still on purpose (unloading, waiting, nothing to clean) never counts as stuck", () => {
    const w = new StuckWatch();
    w.feed(0, false, 0);
    assert.equal(w.feed(0, false, 120_000), false);
});

// --- garage row ---------------------------------------------------------------------------------

test("garage offer: priced at $1,000 x the game's price scale for that vehicle, buyable when affordable", () => {
    const o = autopilotOffer({ ownsVehicle: true, bought: false, on: false, priceScale: 2.5, money: 5000, inCrewSession: false });
    assert.equal(o.price, 2500);
    assert.equal(o.tag, "$2,500");
    assert.equal(o.button, "INSTALL");
    assert.equal(o.enabled, true);
    assert.equal(o.action, "buy");
});

test("garage offer: not enough money or a crew session disables the button and says why", () => {
    const poor = autopilotOffer({ ownsVehicle: true, bought: false, on: false, priceScale: 1, money: 999.99, inCrewSession: false });
    assert.equal(poor.enabled, false);
    assert.match(poor.status, /\$1,000 needed/);
    const crew = autopilotOffer({ ownsVehicle: true, bought: false, on: false, priceScale: 1, money: 1e6, inCrewSession: true });
    assert.equal(crew.enabled, false);
    assert.match(crew.status, /solo/);
});

test("garage offer: once bought, the button switches it off and on", () => {
    const on = autopilotOffer({ ownsVehicle: true, bought: true, on: true, priceScale: 1, money: 0, inCrewSession: false });
    assert.equal(on.tag, "ON");
    assert.equal(on.button, "TURN OFF");
    assert.equal(on.action, "toggle");
    const off = autopilotOffer({ ownsVehicle: true, bought: true, on: false, priceScale: 1, money: 0, inCrewSession: false });
    assert.equal(off.tag, "OFF");
    assert.equal(off.button, "TURN ON");
});

test("garage offer: a model you don't own can't get autopilot", () => {
    const o = autopilotOffer({ ownsVehicle: false, bought: false, on: false, priceScale: 1, money: 1e6, inCrewSession: false });
    assert.equal(o.enabled, false);
    assert.equal(o.action, "none");
    assert.match(o.status, /Buy this vehicle first/);
});

// --- store ------------------------------------------------------------------------------------

test("autopilot is bought per vehicle per game, starts switched on, and can be switched off", () => {
    const s = new AutopilotStore(null);
    assert.equal(s.owned("slot1/a", "garage/11/1/local"), false);
    s.buy("slot1/a", "garage/11/1/local");
    assert.equal(s.owned("slot1/a", "garage/11/1/local"), true);
    assert.equal(s.on("slot1/a", "garage/11/1/local"), true);
    assert.equal(s.owned("slot1/b", "garage/11/1/local"), false, "another game");
    s.setOn("slot1/a", "garage/11/1/local", false);
    assert.equal(s.on("slot1/a", "garage/11/1/local"), false);
    const back = new AutopilotStore(s.toJSON());
    assert.equal(back.owned("slot1/a", "garage/11/1/local"), true);
    assert.equal(back.on("slot1/a", "garage/11/1/local"), false);
    assert.deepEqual(back.active("slot1/a"), []);
});

test("unreadable autopilot file is refused, never treated as nothing bought", () => {
    assert.equal(AutopilotStore.parse("{half"), null);
    assert.ok(AutopilotStore.parse(null));
});
