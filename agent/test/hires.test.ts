import { test } from "node:test";
import assert from "node:assert/strict";
import { HireStore, PRICES, parseHireRequest } from "../src/crew/hires.ts";

test("empty store has no hires", () => {
    assert.deepEqual(new HireStore(null).hired("k"), []);
});

test("hires belong to one game; a new game in the same slot has none", () => {
    const s = new HireStore(null);
    s.hire("slot1/aaa", "sweeper");
    assert.deepEqual(s.hired("slot1/aaa"), ["sweeper"]);
    assert.deepEqual(s.hired("slot1/bbb"), []);
});

test("hiring twice keeps one entry", () => {
    const s = new HireStore(null);
    s.hire("g", "hauler");
    s.hire("g", "hauler");
    assert.deepEqual(s.hired("g"), ["hauler"]);
});

test("identify with no readable summary keeps the slot's game and never mints a new one", () => {
    // Regression: a failed slot.json read counted as play time 0, minted a new id, and orphaned
    // every hire for that game.
    const s = new HireStore(null);
    const key = s.identify(1, 5000, () => "aaa");
    assert.equal(s.identify(1, null, () => "bbb"), key);
    assert.equal(s.identify(1, 5010, () => "ccc"), key);
    assert.equal(new HireStore(null).identify(2, null, () => "ddd"), "", "unknown slot: no key yet");
});

test("parse refuses unreadable crew.json instead of treating it as empty", () => {
    assert.equal(HireStore.parse("{bad"), null);
    assert.equal(HireStore.parse("[]"), null);
    assert.ok(HireStore.parse(null));
    assert.ok(HireStore.parse(new HireStore(null).toJSON()));
});

test("adoptPaused takes only the panel's pause flags; hires and slots stay the agent's", () => {
    const s = new HireStore(null);
    const key = s.identify(1, 100, () => "aaa");
    s.hire(key, "sweeper");
    s.adoptPaused(JSON.stringify({ paused: { sweeper: true } }));  // panel wrote a stripped file
    assert.equal(s.paused("sweeper"), true);
    assert.deepEqual(s.hired(key), ["sweeper"]);
    assert.equal(s.identify(1, 120, () => "zzz"), key);
    s.adoptPaused("{half-writ");
    assert.equal(s.paused("sweeper"), true, "unreadable text changes nothing");
});

test("bad JSON gives an empty store", () => {
    assert.deepEqual(new HireStore("{bad").hired("k"), []);
});

test("toJSON round trip keeps hires and pause flags", () => {
    const s = new HireStore(null);
    s.hire("g", "sweeper");
    s.hire("g", "hauler");
    s.setPaused("hauler", true);
    const t = new HireStore(s.toJSON());
    assert.deepEqual(t.hired("g").sort(), ["hauler", "sweeper"]);
    assert.equal(t.paused("hauler"), true);
    assert.equal(t.paused("sweeper"), false);
});

test("prices are $450 and $350", () => {
    assert.equal(PRICES.sweeper, 450);
    assert.equal(PRICES.hauler, 350);
});

// The game's save folder hash identifies the world definition, not the game
// (MoonWorld.InitializeProgress → MoonProgressStore.Hash(SavedWorldDefinition)), so the mod
// tracks games itself from the slot's play time.
let n = 0;
const ids = () => `id${++n}`;

test("identify keeps the same key while play time grows", () => {
    const s = new HireStore(null);
    const a = s.identify(1, 100, ids);
    assert.equal(s.identify(1, 500, ids), a);
    assert.match(a, /^slot1\//);
});

test("identify gives a new key when play time drops (new game in the slot)", () => {
    const s = new HireStore(null);
    const a = s.identify(1, 44188, ids);
    s.hire(a, "sweeper");
    const b = s.identify(1, 5, ids);
    assert.notEqual(b, a);
    assert.deepEqual(s.hired(b), []);
});

test("identify tolerates small play-time jitter (under 60 s)", () => {
    const s = new HireStore(null);
    const a = s.identify(2, 1000, ids);
    assert.equal(s.identify(2, 950, ids), a);
});

test("slots are independent and identity survives toJSON", () => {
    const s = new HireStore(null);
    const one = s.identify(1, 10, ids);
    const two = s.identify(2, 10, ids);
    assert.notEqual(one, two);
    assert.equal(new HireStore(s.toJSON()).identify(1, 20, ids), one);
});

test("a hire request from the panel is taken once, by its id", () => {
    const text = JSON.stringify({ id: "r1", hire: "sweeper" });
    assert.deepEqual(parseHireRequest(text, ""), { id: "r1", kind: "sweeper" });
    assert.equal(parseHireRequest(text, "r1"), null, "already handled");
    assert.deepEqual(parseHireRequest(JSON.stringify({ id: "r2", hire: "hauler" }), "r1"), { id: "r2", kind: "hauler" });
});

test("crew.json only changes when play time moves on by 30 s or more (not every half-second poll)", () => {
    // Regression: the agent rewrote crew.json twice a second as play time ticked, racing the panel's
    // reads (MoveFileExW "access denied" in Aryan's game).
    const s = new HireStore(null);
    s.identify(1, 1000, () => "a");
    const saved = s.toJSON();
    s.identify(1, 1000.5, () => "b");
    s.identify(1, 1029, () => "c");
    assert.equal(s.toJSON(), saved, "small growth: nothing to save");
    s.identify(1, 1031, () => "d");
    assert.notEqual(s.toJSON(), saved, "30 s on: recorded");
    assert.equal(s.identify(1, 1032, () => "e"), "slot1/a", "same game throughout");
});

test("malformed or unknown hire requests are ignored", () => {
    for (const t of [null, "", "{half", "[]", JSON.stringify({ id: "r3", hire: "architect" }), JSON.stringify({ hire: "sweeper" })]) {
        assert.equal(parseHireRequest(t, ""), null, String(t));
    }
});
