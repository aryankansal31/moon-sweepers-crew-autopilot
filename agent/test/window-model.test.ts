import { test } from "node:test";
import assert from "node:assert/strict";
import { crewWindowModel } from "../src/crew/window-model.ts";

test("both helpers for hire: price tags, keys 1 and 2, affordability", () => {
    const m = crewWindowModel({ hired: [], money: 400, inCrewSession: false, message: "" });
    assert.equal(m.title, "CREW");
    assert.deepEqual(m.cards.map(c => [c.key, c.name, c.tag, c.canHire]), [
        ["1", "Dusty the Sweeper", "$450", false],
        ["2", "Hank the Hauler", "$350", true],
    ]);
    assert.equal(m.balance, "$400");
});

test("a hired helper shows HIRED and can't be hired again", () => {
    const m = crewWindowModel({ hired: ["sweeper"], money: 10_000, inCrewSession: false, message: "" });
    assert.equal(m.cards[0].tag, "HIRED");
    assert.equal(m.cards[0].canHire, false);
    assert.equal(m.cards[1].canHire, true);
});

test("in a crew session nobody can be hired and the window says why", () => {
    const m = crewWindowModel({ hired: [], money: 10_000, inCrewSession: true, message: "" });
    assert.ok(m.cards.every(c => !c.canHire));
    assert.equal(m.note, "Crew helpers work in solo shifts only");
});

test("the last hire result is shown; otherwise a hint", () => {
    assert.equal(crewWindowModel({ hired: [], money: 0, inCrewSession: false, message: "Not enough money: $450 needed" }).note,
        "Not enough money: $450 needed");
    assert.equal(crewWindowModel({ hired: [], money: 0, inCrewSession: false, message: "" }).note,
        "Press a number to hire. Paid once, from your in-game money.");
});

test("Decimal->double noise doesn't knock a dollar off the balance", () => {
    assert.equal(crewWindowModel({ hired: [], money: 499.9999998629085, inCrewSession: false, message: "" }).balance, "$500");
    assert.equal(crewWindowModel({ hired: [], money: 499.99, inCrewSession: false, message: "" }).balance, "$499");
});

test("money is shown in whole dollars with thousands separators", () => {
    assert.equal(crewWindowModel({ hired: [], money: 12345.67, inCrewSession: false, message: "" }).balance, "$12,345");
});
