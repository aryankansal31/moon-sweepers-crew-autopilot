import { test } from "node:test";
import assert from "node:assert/strict";
import { canBuy } from "../src/crew/purchase.ts";

test("exactly the price is enough", () => {
    assert.equal(canBuy(450, 450).ok, true);
});

test("a cent short is refused with the price in the reason", () => {
    const r = canBuy(449.99, 450);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "Not enough money: $450 needed");
});

test("hiring is refused in a crew session (helpers only work solo), even with money", () => {
    const r = canBuy(10_000, 450, true);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "Crew helpers work in solo shifts only");
});

test("no money is refused", () => {
    assert.equal(canBuy(0, 350).ok, false);
});

test("floating-point dust doesn't refuse an exact amount (e.g. 449.9999999 from Decimal->double)", () => {
    assert.equal(canBuy(449.9999999, 450).ok, true);
});
