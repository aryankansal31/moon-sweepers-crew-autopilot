# Crew Helpers (Sweeper + Hauler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two hireable crew members, a Sweeper and a Hauler, bought in the in-game shop. They look and move like real astronauts and earn Aryan money on their own.

**Architecture:** Crew code lives in new modules under `agent/src/crew/`, bundled into the existing eternalized trainer agent and driven from its `MoonFramePacer.Update` tick.
- **Pure logic** (decision making, hire storage, seller de-duplication, tuning maths) has no Frida imports and is unit-tested with Node's test runner.
- **Game adapters** (spawning bodies, cleaning, storage, shop) are thin IL2CPP wrappers, verified in a **sandbox game instance**: a second copy of the game whose saves are redirected to a scratch folder, so development never touches Aryan's live game or save.

**Tech Stack:** TypeScript + frida-il2cpp-bridge 0.14 (agent), Frida 17.2.3 `frida.Compiler` (bundling), Node 22 `node --experimental-strip-types --test` (unit tests), Python 3.12 + tkinter (launcher/panel), unittest (Python tests).

**Spec:** `docs/specs/2026-10-27-crew-helpers-design.md`

## Global Constraints

- No game files are patched. Everything is runtime hooks in `agent/src/trainer.ts` and its imports.
- All game calls run on Unity's main thread, from the existing tick. The crew's share of the tick averages **under 1 ms per frame**; heavy searches are spread across frames.
- Every crew step is wrapped in try/catch. The `MoonFramePacer.Update` hook must never throw (the agent is eternalized and can't be reloaded without a game restart).
- Agent ↔ panel communication is files only: `config.json`, `status.json` and the new `crew.json`, all next to `moon_trainer.py`.
- Prices: **Sweeper $450, Hauler $350**, one-time, from in-game money. Refuse if he can't afford it. No wages, no firing, no refunds.
- **Sweeper payback: $450 earned in about 20 minutes of play at 1x** (accept 17–23 min), counting walks to the station and section bounties.
- Sweeper works within **25 m** of the player and follows him. Starting hopper is **150 kg**; it may be tuned for payback.
- Hauler carries **200 kg** per trip. Priority: full robot dock → parked vehicle hopper → loose canisters → deposit → sell. It never takes from machine storage (`MoonWorld.MachineStorage(id)`) or from a dock that isn't `get_Full`.
- Looks: Sweeper in an **orange** suit with a broom-class tool; Hauler in a **yellow** suit. Each has its own eye style and a name tag.
- One of each. Solo only: never spawn in crew (multiplayer) sessions.
- Hire state is keyed **per game, not per slot number**.
- Sold in the **in-game shop** under a "Crew" heading (or inside BaseEquipment). A bought card shows "Hired". The trainer panel alone is not an acceptable shop.
- All selling (Sweeper, Hauler, trainer auto-sell) goes through one shared seller. It never presses an intake that is already selling, and presses at most once per sale.
- No visible teleporting. A helper stuck for a few seconds must recover; if it can't, it may reposition out of the player's view.
- Never touch Aryan's live game or save during development. Use the sandbox (Task 1). Any check on the real save needs a `MoonSessions` backup first and a restore afterwards.

## Review Focus

1. **A full hopper with no reachable station** (all stations far, or behind a building). Expected: the helper walks toward the nearest one and doesn't spin or freeze. The Sweeper brain has a test pinning "ToStation picks the nearest and keeps it until arrival".
2. **Shift reload or returning to the menu while a helper holds dust.** Expected: no dust lost or duplicated. The hopper is the game's own vehicle storage, so it persists or reloads with the world. Task 5's sandbox check reloads mid-carry and compares kg.
3. **Buying with exactly the price, or $0.01 short.** Expected: exact price succeeds, a cent short refuses with a message, and money never goes negative. Task 7's shop test covers both.
4. **A new game in a slot that previously had crew.** Expected: no crew. Task 2's `HireStore` test covers the game-key change.
5. **Sweeper, Hauler and auto-sell all eligible to sell the same tray in the same frame.** Expected: one press. Task 3's seller test covers it.

---

### Task 0: Repository and test scaffolding

**Files:**
- Create: `.gitignore`, `agent/test/smoke.test.ts`, `scripts/build_agent.py`
- Modify: `agent/package.json` (add `"test"` script)

**Interfaces:**
- Produces: `npm test` (from `agent/`) runs `node --experimental-strip-types --test test/`. `python -I scripts/build_agent.py agent/src/trainer.ts` exits 0 and prints `errors: []` when the bundle compiles, and prints the errors and exits 1 otherwise.

- [ ] **Step 1:** `git init` in `moon-sweepers-mod/`. `.gitignore` excludes `game/`, `tools/venv/`, `agent/node_modules/`, `save-backup/`, `sandbox/`, `status.json`, `config.json`, `crew.json`, `*.tmp`, `analysis/dump.cs` (2.4 MB; regenerable).
- [ ] **Step 2:** Write `agent/test/smoke.test.ts` asserting `1 + 1 === 2` with `node:test`. Add `"test": "node --experimental-strip-types --test test/"` to `agent/package.json`.
- [ ] **Step 3:** Run `cd agent && npm test`. Expected: `# pass 1`, `# fail 0`.
- [ ] **Step 4:** Write `scripts/build_agent.py` (Frida `Compiler`, prints error diagnostics as `file:line: text`). Run it on `agent/src/trainer.ts`. Expected: `errors: []`.
- [ ] **Step 5:** Commit everything existing plus the scaffolding: `git add -A && git commit -m "chore: track trainer mod, add test scaffolding"`.

### Task 1: Sandbox game instance

A second game process for development, with saves redirected to `sandbox/MoonSessions` (a copy of Aryan's save), running the trainer **non-eternalized** so code can be reloaded by restarting only the sandbox.

**Files:**
- Create: `agent/src/sandbox.ts`, `scripts/sandbox.py`

**Interfaces:**
- Produces: `python -I scripts/sandbox.py start` copies `%USERPROFILE%/AppData/LocalLow/DragDropGames/MoonSweepers/MoonSessions` → `sandbox/MoonSessions` (only if `sandbox/` doesn't exist), `frida.spawn`s `game/MoonSweepers.exe`, loads `sandbox.ts` **before** resume, then loads `trainer.ts` with `init({config: sandbox/config.json, status: sandbox/status.json, crew: sandbox/crew.json})`, and stays attached.
  - `sandbox.py stop` quits the sandbox game (`MoonSession.QuitGame` with a 20 s timeout, then terminate).
  - `sandbox.py shift` starts the shift (`MoonSession.StartShift`).
  - The sandbox pid is written to `sandbox/pid`. `scripts/probe.py` accepts `--pid` and reads `sandbox/pid` when given `--sandbox`.
- `sandbox.ts` hooks `MoonCleaners.MoonSaveSlots.get_Folder()` to return the absolute `sandbox/MoonSessions` path.

- [ ] **Step 1:** Implement `sandbox.ts` and `sandbox.py start|stop|shift`. The trainer's duplicate-injection mutex is per-pid, so the sandbox doesn't clash with Aryan's game.
- [ ] **Step 2:** Verify: `sandbox.py start`, then `sandbox.py shift`, wait 60 s, then `sandbox.py stop`. Expected:
  - files under `sandbox/MoonSessions/slot-1/*/` have new modification times;
  - `diff -rq save-backup/MoonSessions-2026-10-27 "%USERPROFILE%/AppData/LocalLow/DragDropGames/MoonSweepers/MoonSessions"` is unchanged from before the run;
  - Aryan's game (pid in `status.json`) still reports fresh `status.json` ticks.
- [ ] **Step 3:** If `get_Folder` alone doesn't redirect (live files changed), also hook `MoonSaveSlots.Root(identity)` and `SlotFolder(slot)`, and repeat Step 2 until the live save is untouched. Record which hooks were needed at the top of `sandbox.ts`.
- [ ] **Step 4:** Commit: `feat: sandbox game instance with redirected saves`.

### Task 2: Hire storage, keyed per game

**Files:**
- Create: `agent/src/crew/hires.ts`, `agent/test/hires.test.ts`
- Modify: `agent/src/trainer.ts` (`init` accepts `crew` path; load/save through `HireStore`), `moon_trainer.py` (pass `CREW_PATH`)

**Interfaces:**
- Produces (pure, no Frida):
  - `type HelperKind = "sweeper" | "hauler"`
  - `const PRICES: Record<HelperKind, number> = { sweeper: 450, hauler: 350 }`
  - `class HireStore { constructor(json: string | null); hired(gameKey: string): HelperKind[]; hire(gameKey: string, kind: HelperKind): void; paused(kind: HelperKind): boolean; setPaused(kind: HelperKind, on: boolean): void; toJSON(): string }`
  - The file format is `{"games": {"<gameKey>": {"hired": ["sweeper"], "hiredAt": {"sweeper": "<ISO>"}}}, "paused": {"sweeper": false}}`. Bad or missing JSON gives an empty store.
- Produces (adapter, in `trainer.ts` scope): `gameKey(): string`.

- [ ] **Step 1:** Find what identifies a game. In the sandbox, note the `slot-1/<hash>/` folder name. Then start a new game in an empty sandbox slot (via the main menu's slot functions in `MoonMainMenu`/`MoonSaveSlots`) and check whether a different hash folder appears. If the hash identifies the game, `gameKey()` = `"slot<N>/<hash>"`. Otherwise use `"slot<N>/<first-seen creation time of slot.json>"`. Write the finding as a comment above `gameKey()`.
- [ ] **Step 2:** Write `hires.test.ts`:
  - `new HireStore(null).hired("k")` deep-equals `[]`;
  - after `hire("slot1/aaa","sweeper")`, `hired("slot1/aaa")` is `["sweeper"]` and `hired("slot1/bbb")` is `[]` (new game in the same slot);
  - hiring twice keeps one entry;
  - `new HireStore("{bad").hired("k")` is `[]`;
  - a round trip through `toJSON()` preserves hires and pause flags;
  - `PRICES.sweeper === 450 && PRICES.hauler === 350`.
- [ ] **Step 3:** Run `npm test`. Expected: the new tests fail (module missing). Implement `hires.ts`. Run again. Expected: all pass.
- [ ] **Step 4:** Wire it into `trainer.ts`: read `crew.json` on `init` and every 500 ms poll (as `loadConfigFile` does), and write it on change. Build with `scripts/build_agent.py`. Expected: `errors: []`.
- [ ] **Step 5:** Commit: `feat(crew): per-game hire storage`.

### Task 3: Shared seller

**Files:**
- Create: `agent/src/crew/seller.ts`, `agent/test/seller.test.ts`
- Modify: `agent/src/trainer.ts` (`autoSell` uses the seller)

**Interfaces:**
- Produces (pure): `interface Intake { id: string; selling(): boolean; canSell(): boolean; trayKg(): number; press(): boolean }` and `class Seller { trySell(intake: Intake, nowMs: number): boolean }`.
  - It presses only when `trayKg() > 0 && canSell() && !selling()`.
  - It never presses the same intake twice within 3000 ms. That window covers the frames before `selling()` turns true.
- Consumes (adapter): `MoonDepositIntake.get_Selling`, `get_CanSell`, `Press(walker)`; `MoonDustStation.get_TrayKilograms`, `get_Intake`.

- [ ] **Step 1:** Write `seller.test.ts` with a fake `Intake`:
  - three `trySell` calls in the same ms (Sweeper, Hauler, auto-sell) → exactly one `press`;
  - while `selling()` is true → no press;
  - `trayKg() === 0` → no press;
  - a second call at +3001 ms with the tray refilled and not selling → press.
- [ ] **Step 2:** `npm test` fails. Implement. `npm test` passes.
- [ ] **Step 3:** Replace the body of `autoSell` in `trainer.ts` with a `Seller` shared through a module-level instance exported from `seller.ts` (`export const seller = new Seller()`). Build: `errors: []`.
- [ ] **Step 4:** Sandbox check: put dust in a tray (F10 deposit after cleaning by hand, or `DevSetVehicleDust` plus a vehicle deposit), with auto-sell on. Expected: `status.json` `sales` goes up by exactly 1 per tray.
- [ ] **Step 5:** Commit: `feat(crew): shared seller with single-press guarantee`.

### Task 4: Helper bodies that walk

**Files:**
- Create: `agent/src/crew/body.ts`
- Modify: `agent/src/trainer.ts` (create `CrewManager` in tick; see Task 5)

**Interfaces:**
- Produces (adapter):
  - `class HelperBody { static spawn(walker: Il2Cpp.Object, kind: HelperKind, at: Vec3): HelperBody; get position(): Vec3; walkTo(target: Vec3, speed: number): void; setAct(act: "Stand" | "Clean" | "Walk" | "Carry"): void; setCarryFill(fraction: number): void; placeAt(p: Vec3): void; destroy(): void }`
  - `type Vec3 = [number, number, number]` (also exported from `agent/src/crew/vec.ts`, with `dist`, `sub`, `add`, `scale`, `norm`, `arcDistance(a, b, radius)`, all unit-tested in `agent/test/vec.test.ts`).
- Consumes: `MoonDemoCrew.Of(walker)`, `Add(name, look, tool, position, facing, act)`, `Look(suit, eyes, eyeColor)`, `Member.position/to/speed/act/capsuleFill/remote`, `MoonDemoCrew.Ground(point)`.

- [ ] **Step 1:** Read `MoonDemoCrew.Step` (RVA `0x76e8e0`) with `scripts/disasm.py` and the probe's `resolve`. Note which `Member` fields it reads to move (`to`, `speed`) and whether it snaps to ground. Record this in a comment at the top of `body.ts`. If `Step` doesn't move members toward `to`, `walkTo` moves `position` itself each tick at `speed * dt` and grounds it with `Ground`.
- [ ] **Step 2:** Pick the looks with `MoonDemoCrew.Look(suit, eyes, eyeColor)`. In the sandbox, spawn one body per candidate suit index and read the suit colour on `MoonAstronautAppearance`. Choose the orange-most and the yellow-most, plus two different eye styles that both differ from `MoonAstronautLook.get_Local()`. Put them in `body.ts` as `LOOKS: Record<HelperKind, {suit, eyes, eyeColor}>`, and the names as `NAMES: Record<HelperKind, string>`.
- [ ] **Step 3:** Write `vec.test.ts`:
  - `dist([0,0,0],[3,4,0]) === 5`;
  - `arcDistance` of two orthogonal unit directions at radius 2015 ≈ `2015 * Math.PI / 2` (±0.01).

  `npm test` fails, implement `vec.ts`, `npm test` passes.
- [ ] **Step 4:** Implement `body.ts`. Sandbox check via a probe RPC `spawnTest`: spawn both bodies 5 m from the player and `walkTo` a point 20 m away at 1.4 m/s. Expected after 15 s:
  - both bodies are within 1 m of the target;
  - they are separate `MoonRemotePlayer` objects, with name tags matching `NAMES`;
  - Aryan's live game is unaffected.
- [ ] **Step 5:** Commit: `feat(crew): helper bodies with distinct looks that walk`.

### Task 5: The Sweeper

**Files:**
- Create: `agent/src/crew/sweeper-brain.ts`, `agent/test/sweeper-brain.test.ts`, `agent/src/crew/world.ts`, `agent/src/crew/manager.ts`
- Modify: `agent/src/trainer.ts` (tick calls `crewManager.tick(now, dt)` when `config.enabled && inGame && solo`, where `solo = !MoonCleaners.MoonCrew.get_Joined()`, the same check `MoonDepositIntake.Press` makes)

**Interfaces:**
- Produces (pure):
  - `type SweeperState = "Seek" | "Clean" | "ToStation" | "Deposit" | "Return" | "Stuck"`
  - `interface SweeperInput { pos: Vec3; playerPos: Vec3; hopperKg: number; hopperCapKg: number; nearestStation: Vec3 | null; dirtyTarget: Vec3 | null; movedLast2s: number; nowMs: number }`
  - `class SweeperBrain { state: SweeperState; step(input: SweeperInput): SweeperAction }`
  - `type SweeperAction = { kind: "walk", to: Vec3, speed: number } | { kind: "clean", along: Vec3, width: number } | { kind: "deposit" } | { kind: "idle" } | { kind: "unstick", to: Vec3 }`
  - Constants exported from `sweeper-brain.ts`: `WORK_RADIUS_M = 25`, `STUCK_AFTER_MS = 3000`, `WALK_SPEED`, `CLEAN_SPEED`, `CLEAN_WIDTH`, `CLEAN_DEPTH`, `CLEAN_DOSE`, `HOPPER_KG = 150` (the last five tuned in Step 6).
- Produces (adapter, `world.ts`):
  - `findDirtyNear(center: Vec3, radius: number, budget: number): Vec3 | null`, incremental: it samples at most `budget` points per call and keeps state between calls;
  - `nearestStation(p: Vec3): {station: Il2Cpp.Object, pos: Vec3} | null`;
  - `ensureHopper(id: string, capKg: number): void` (`RegisterVehicleStorage`, then `FitVehicleCapacity` if the size differs);
  - `hopperKg(id: string): number`;
  - `cleanStroke(from: Vec3, to: Vec3, width: number, depth: number, dose: number, hopperId: string): number` (`MoonWorld.CleanToolStroke` with `inventoryId = ""` and `vehicleStorageId = hopperId`);
  - `depositHopper(id: string, station: Il2Cpp.Object): number` (replays what `MoonDustStation.DepositVehicle` does, read from its disassembly at RVA `0x33b690`, so the money is credited through the `WaitingWorth` delta and `Take`, as in `deposit()`).
- Produces (`manager.ts`): `class CrewManager { constructor(store: HireStore); tick(nowMs: number, dt: number): void; statusLines(): string[] }`. It spawns hired, unpaused helpers near the player when a shift loads, despawns them on menu or crew session, and calls the seller after each Sweeper deposit.

- [ ] **Step 1:** Write `sweeper-brain.test.ts`:
  - hopper 0/150 with a dirty target 10 m away → `walk` to it, then `clean` once within 1.5 m;
  - `hopperKg >= hopperCapKg` → state `ToStation`, `walk` to `nearestStation`;
  - while in `ToStation`, a different station becoming nearer doesn't change the target until arrival (Review Focus 1);
  - within 2 m of the station → `deposit`, then `Return`;
  - player 40 m away → `walk` toward the player until within `WORK_RADIUS_M`;
  - `movedLast2s < 0.2` while walking for `STUCK_AFTER_MS` → `unstick` to a point 2–4 m sideways;
  - three failed `unstick` attempts in a row → `{ kind: "reposition" }` (add it to `SweeperAction`); the manager then `placeAt`s the body at the target, but only when the player's camera isn't facing it (dot of camera forward and the direction to the body < 0.3);
  - no dirt and no full hopper → `idle` near the player.

  `npm test` fails.
- [ ] **Step 2:** Implement `sweeper-brain.ts`. `npm test` passes.
- [ ] **Step 3:** Read `MoonDustStation.DepositVehicle` (RVA `0x33b690`) and `MoonWorld.CleanToolStroke` (RVA `0x685a00`) with `disasm.py` and `resolve`. Note any reach or ray checks to skip (as `Deposit` had), and record the replay sequence in a comment in `world.ts`.
- [ ] **Step 4:** Implement `world.ts` and `manager.ts` (Sweeper only, hired via a temporary `crew.json` entry in the sandbox). Build: `errors: []`.
- [ ] **Step 5:** Sandbox check at `timeScale` 1, 5 minutes. Expected:
  - `hopperKg` rises while the Sweeper is in Clean;
  - the ground visibly clears (the probe reads dust at sampled points before and after);
  - when full, it walks to the station, deposits, and `sales` goes up;
  - `money` goes up by roughly the station's `WorthOf(kg)` for that trip, ±1%;
  - no `lastError` in `status.json`.
- [ ] **Step 6:** Tune for payback. Run the sandbox at `timeScale` 4 for 5 real minutes (20 game minutes) from a fresh hire on the copied save. Measure money earned by the Sweeper (deposit worth plus `PaySection` credits attributed during the run, from `status.json` counters added for this). Adjust the speed, width, depth, dose and hopper constants until earnings land in **$390–$530** (payback 17–23 min). Record the final values and the measured result in the `sweeper-brain.ts` constants' comment.
- [ ] **Step 7:** Reload check (Review Focus 2): with the hopper holding more than 50 kg, return to the menu and start the shift again. Expected: the hopper kg is the same after reload (±0.1), and the Sweeper respawns.
- [ ] **Step 8:** Commit: `feat(crew): Sweeper cleans, deposits and sells`.

### Task 6: The Hauler

**Files:**
- Create: `agent/src/crew/hauler-brain.ts`, `agent/test/hauler-brain.test.ts`
- Modify: `agent/src/crew/world.ts`, `agent/src/crew/manager.ts`

**Interfaces:**
- Produces (pure):
  - `type HaulJob = { kind: "dock", id: string, pos: Vec3 } | { kind: "vehicle", id: string, pos: Vec3 } | { kind: "canister", id: number, pos: Vec3 } | { kind: "deposit", pos: Vec3 } | { kind: "sell", intakeId: string, pos: Vec3 }`
  - `interface HaulWorld { docks: {id, pos, full: boolean, machine: boolean}[]; vehicles: {id, pos, kg: number, driven: boolean, machine: boolean}[]; canisters: {id, pos, kg: number}[]; carriedKg: number; capKg: number; stationPos: Vec3 | null; sellable: {intakeId, pos}[] }`
  - `function nextJob(w: HaulWorld, from: Vec3): HaulJob | null`
  - `HAULER_CAP_KG = 200`
- Produces (adapter): `world.ts` adds `fullDocks()`, `parkedVehicleHoppers()`, `looseCanisters(near: Vec3, radius: number)`, `takeFromDock(dock, kg, hopperId)`, `takeFromVehicle(storageId, kg, hopperId)`, `collectCanister(id, hopperId)`. Each moves kg between storages and conserves the total.

- [ ] **Step 1:** Write `hauler-brain.test.ts`:
  - a full dock and a parked vehicle → `dock` first;
  - a dock that isn't full is ignored;
  - a `machine: true` dock or vehicle is ignored even if full;
  - a driven vehicle is ignored;
  - `carriedKg >= capKg` → `deposit`;
  - nothing to haul but the hauler holds dust → `deposit`;
  - nothing to haul or deposit, with a sellable intake → `sell`;
  - nothing at all → `null`.

  `npm test` fails, implement, `npm test` passes.
- [ ] **Step 2:** Read `MoonRobotDock.Unload` (RVA `0x4ed470`), `MoonWorld.TakeVehicleDust` (RVA `0x710a70`) and `CollectDustCanister` (RVA `0x687d10`) to settle how dust moves out of each source into the Hauler's hopper. Record that in `world.ts`.
- [ ] **Step 3:** Implement the adapters and the Hauler in `manager.ts`: walk with `Carry` act, set `setCarryFill(carried/cap)`, and sell through the shared seller. Build: `errors: []`.
- [ ] **Step 4:** Sandbox check (10 min at `timeScale` 2). Expected:
  - a full robot dock gets emptied and that robot keeps working;
  - the kg taken equals the kg deposited (±0.1, logged per trip);
  - no conveyor-fed machine loses stock (check `MoonProductionInteraction`'s rows or the machine storages' kg before and after).
- [ ] **Step 5:** Commit: `feat(crew): Hauler empties docks, vehicles and canisters`.

### Task 7: Crew in the in-game shop

**Files:**
- Create: `agent/src/crew/shop.ts`, `agent/test/purchase.test.ts`
- Modify: `agent/src/crew/manager.ts`

**Interfaces:**
- Produces (pure): `function canBuy(money: number, price: number): {ok: boolean, reason?: string}`. `ok` is true when `money >= price`; otherwise the reason is `"Not enough money: $<price> needed"`.
- Produces (adapter): `installCrewShop(store: HireStore, onHire: (k: HelperKind) => void): void`. It hooks the shop build/refresh so the two crew cards appear with icons `Symbol.Brush` (Sweeper) and `Symbol.Hauler` (Hauler). Buying charges through the game's wallet (`MoonWorld.ChargeBuild(player, amount)`, or the purchase path the shop uses, whichever disassembly shows to deduct cleanly and save) and calls `store.hire`.

- [ ] **Step 1:** Write `purchase.test.ts`:
  - `canBuy(450, 450).ok === true`;
  - `canBuy(449.99, 450).ok === false`, with reason `"Not enough money: $450 needed"`;
  - `canBuy(0, 350).ok === false` (Review Focus 3).

  `npm test` fails, implement, `npm test` passes.
- [ ] **Step 2:** Read `MoonUpgradeShop.BuildShopMenu` (RVA `0x3507c0`), `AddConcept` (RVA `0x34cb50`), `SelectOffer` and `PurchaseGear` (RVA `0x353f60`) to choose the injection point. Concept cards that accept a buy action are the first choice. Otherwise, draw a "Crew" page inside the shop window with the shop's own `OfferView` components. Record the choice in `shop.ts`.
- [ ] **Step 3:** Implement `shop.ts`. Build: `errors: []`.
- [ ] **Step 4:** Sandbox check:
  - with sandbox money set to exactly $450 (`MoonWorld.DevAddMoney` on the sandbox only), buying the Sweeper succeeds, money becomes $0, the card shows "Hired" and the Sweeper spawns;
  - buying the Hauler with $0 shows the refusal and money stays $0;
  - after the sandbox restarts, the card still shows "Hired" and money is still $0 (the deduction was saved).
- [ ] **Step 5:** Commit: `feat(crew): hire Sweeper and Hauler from the in-game shop`.

### Task 8: Panel, notices, and a long soak

**Files:**
- Modify: `moon_trainer.py`, `agent/src/crew/manager.ts`, `README.md`
- Create: `tests/test_panel.py`

**Interfaces:**
- Consumes: `CrewManager.statusLines()` → written to `status.json` as `crew: string[]`; `HireStore.setPaused`.
- Produces: in the panel, one line per hired helper (state and kg delivered), and a "Sweeper working" / "Hauler working" checkbox per hired helper that writes `crew.json` `paused`.

- [ ] **Step 1:** Write `tests/test_panel.py` (unittest) for a new pure function `crew_lines(status: dict) -> list[str]` in `moon_trainer.py`:
  - `{"crew": ["Sweeper: Clean, 120 kg delivered"]}` → that list;
  - a missing key → `[]`.

  Run `tools/venv/Scripts/python -I -m unittest tests.test_panel`. Expected: fails, then passes after implementing.
- [ ] **Step 2:** Implement the panel lines and pause checkboxes. Make `MoonHudNotice` show `"<Name> deposited <kg> kg"` and `"<Name> sold the tray"`, rate-limited to one notice per helper every 5 s.
- [ ] **Step 3:** Soak test in the sandbox: both helpers hired, `timeScale` 4, 20 real minutes. Expected:
  - `lastError` stays empty;
  - both helpers spend under 5% of samples in `Stuck`;
  - the crew tick averages under 1 ms (instrument with `Date.now()` deltas summed over the run, reported in `status.json` as `crewMsPerFrame`);
  - the sandbox game is still responsive (new `status.json` writes).
- [ ] **Step 4:** Update the `README.md` "What it changes" table and add a "Crew" section with prices, behaviour, the pause switches and the restart-to-update note. Commit: `feat(crew): panel status, notices, soak-tested`.
- [ ] **Step 5:** Final check: `npm test` all pass, `scripts/build_agent.py agent/src/trainer.ts` gives `errors: []`, and `unittest` passes. Tell Aryan the crew arrives in his game after one restart via `Play with Trainer.bat`.
