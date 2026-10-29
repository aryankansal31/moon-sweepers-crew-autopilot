import { test } from "node:test";
import assert from "node:assert/strict";
import { Seller, type Intake } from "../src/crew/seller.ts";

function fakeIntake(over: Partial<{ selling: boolean; canSell: boolean; tray: number }> = {}) {
    const state = { selling: false, canSell: true, tray: 40, presses: 0, ...over };
    const intake: Intake = {
        id: "station-0",
        selling: () => state.selling,
        canSell: () => state.canSell,
        trayKg: () => state.tray,
        press: () => { state.presses++; state.tray = 0; return true; },
    };
    return { intake, state };
}

test("Sweeper, Hauler and auto-sell in the same frame press once", () => {
    const seller = new Seller();
    const { intake, state } = fakeIntake();
    const results = [seller.trySell(intake, 1000), seller.trySell(intake, 1000), seller.trySell(intake, 1000)];
    assert.equal(state.presses, 1);
    assert.deepEqual(results, [true, false, false]);
});

test("no press while the intake is already selling", () => {
    const { intake, state } = fakeIntake({ selling: true });
    assert.equal(new Seller().trySell(intake, 1000), false);
    assert.equal(state.presses, 0);
});

test("no press with an empty tray", () => {
    const { intake, state } = fakeIntake({ tray: 0 });
    assert.equal(new Seller().trySell(intake, 1000), false);
    assert.equal(state.presses, 0);
});

test("no press when the intake can't sell", () => {
    const { intake, state } = fakeIntake({ canSell: false });
    assert.equal(new Seller().trySell(intake, 1000), false);
    assert.equal(state.presses, 0);
});

test("the same intake can be pressed again after 3000 ms", () => {
    const seller = new Seller();
    const { intake, state } = fakeIntake();
    seller.trySell(intake, 1000);
    state.tray = 25;
    assert.equal(seller.trySell(intake, 3999), false, "still inside the 3000 ms window");
    assert.equal(seller.trySell(intake, 4001), true);
    assert.equal(state.presses, 2);
});
