# Crew helpers for Moon Sweepers: Sweeper and Hauler

Date: 2026-10-27. Status: approved by Aryan 2026-10-27 ("start the work on crew").

## Intent

Aryan wants helpers he can hire. They work beside him in a shift, look like real crew members
(clearly different from his own astronaut), and do the repetitive parts of the game for him.
His own example was "cleaning dust and depositing it automatically like me". He asked for a
crew of several helpers with different jobs, and for proposals beyond his own examples.

The full proposed roster is Sweeper, Hauler, Driver, Surveyor and Architect. **This document
covers the first two: Sweeper and Hauler.** The rest, plus blueprints and a layout advisor, are
under "Later" at the end.

Success means Aryan buys a Sweeper and a Hauler in the in-game shop. He then watches them walk
around, clean and carry like crewmates, and his money goes up while he does something else.

## How it gets built (already decided)

- The helpers are part of the existing trainer mod in `moon-sweepers-mod/`: a Frida agent
  (`agent/src/trainer.ts`, frida-il2cpp-bridge 0.14), injected by `moon_trainer.py`, and
  eternalized inside the game process. No game files are patched.
- The agent talks to the launcher/panel only through JSON files next to `moon_trainer.py`
  (`config.json`, `status.json`). The helpers follow the same pattern. Any new state, such as
  who is hired, goes in a new file there, not over RPC.
- All game calls run on Unity's main thread, from the existing `MoonFramePacer.Update` hook.
- The game is Unity 6000.6 IL2CPP. Class and method names come from the runtime dump in
  `analysis/` (`dump.cs`, `assembly-csharp.cs`, `moonworld.cs`). `scripts/disasm.py` and the
  `resolve` RPC in `agent/src/probe.ts` map GameAssembly RVAs to names. Use them to read how a
  game method works before replaying its internals (as was done for `MoonDustStation.Deposit`).

## Building blocks found in the game

These are verified to exist by name. Behaviour noted where it was checked in the disassembly.

- **Helper bodies:** `MoonDemoCrew`. `MoonDemoCrew.Of(walker)` adds the component to the local
  player, with no dev-mode gate. `Add(name, MoonAstronautLook look, string tool, Vector3 position,
  Vector3 facing, Act act)` spawns a `MoonRemotePlayer` body with its own suit, eyes and held tool,
  and `Step()` animates it. Acts: Stand, Clean, Walk, Carry, Drive, Jump.
  `MoonDemoCrew.Look(suit, eyes, eyeColor)` builds a look. The `Member` class has fields
  `position`, `to`, `speed`, `act`, `capsuleFill`, `remote`.
- **The demo crew's own cleaning doesn't bank anything.** `Stroke` calls
  `MoonWorld.ApplyCrewStroke`, which is meant for remote co-op crewmates. Real cleaning must use
  `MoonWorld.CleanToolStroke(from, to, fromRight, toRight, width, depth, dose, edgeWidth,
  pushDirection, inventoryId, vehicleStorageId)`, the call the player's own tools go through.
- **Helper hopper:** use a vehicle-style storage. `MoonWorld.RegisterVehicleStorage(id,
  capacity)`, `VehicleDustCapacity(id)`, `TakeVehicleDust(storage, kg)`,
  `DepositVehicleDust(id, player, capacity)`. `MoonDustStation.DepositVehicle(vehicle)` shows how
  a station takes a vehicle's dust.
- **Selling:** `MoonDepositIntake.Press(walker)` has no distance check (already used by the
  trainer's auto-sell). The station deposit replay in `trainer.ts` (`deposit()`) shows how money
  is credited (`WaitingWorth` delta → `MoonDustStation.Take`).
- **Hauler sources:** robot docks (`MoonRobotDock.get_All`, `get_Full`, `get_StoredKilograms`,
  `Unload(robotStorage, maximum)`); vehicle hoppers (`TakeVehicleDust`, `VehicleDustCapacity`);
  loose canisters (`MoonWorld.NearbyCanisters`, `TryGetCanister`, `CarryDustCanister`,
  `CollectDustCanister`, `TransferCanisterDust`, `get_DroppedCanisterCount`).
- **Shop:** `MoonUpgradeShop`. Categories are Tools, Vehicles, Inventory, BaseEquipment and Suit.
  Offer kinds are Tool, Vehicle, Container, Concept and Gear. `ConceptOffer(category, name, type,
  description, MoonShopConceptIcon.Symbol)`. Icon symbols include Brush, Hauler, Canister,
  Scanner and Workbench. `AddConcept`, `BuildShopMenu` and `Refresh` build the menu.
- **Money:** `MoonDustInventory.get_Money`, `MoonWorld.WalletDollars(player)`. `TeamWallet`
  balance changes raise `MoneyChanged`. The local player id is `"local"`.
- **Current prices**, as calibration: tools $5–150, Walk-behind sweeper $300, Rider $1,000,
  Crew van $2,000. Aryan had about $255 when this was measured.

## The two helpers

### Sweeper — "cleans and deposits like me"

- **Look:** a distinct orange suit and its own eye style, holding a broom-class tool. It has a
  name tag. The name is the builder's call; it should be friendly and in the game's tone.
- **Work:** cleans dust in sweeping lanes like a player would, near Aryan. It works within about
  25 m of him and drifts after him when he moves on. It prefers dirty ground and never stands
  still on ground that is already clean.
- **Rate (Aryan's decision): pays back its $450 in about 20 minutes of play at 1x speed.** That
  is the hard number. Tune its cleaning width, depth/dose, walking speed and hopper size until it
  hits it, measured from hire to $450 earned including the walks to the station. It may clean
  faster than a broom-wielding player to get there. It should still look like a person cleaning
  (lanes, Clean animation), not a vacuum truck. Section and region bounties it earns
  (`PaySection`) count toward payback.
- **Hopper:** starts at 150 kg; the size may be tuned for the payback target. When full, it
  walks to the nearest dust station and deposits. **It then presses the sell button itself**, as
  Aryan does, so a Sweeper hired alone still turns dust into money (my call). Then it walks back
  and carries on.
- **Movement:** walks visibly the whole time, with no teleporting in view, and uses the Walk and
  Clean animations. Game speed (`timeScale`) speeds it up naturally.

### Hauler — "moves the dust I'd otherwise have to fetch"

- **Look:** a distinct yellow suit and its own eye style, with a name tag. It looks like it is
  carrying something (Act Carry, capsule fill) when it holds dust.
- **Work, in priority order:**
  1. Empty a robot dock that is **completely full** (`get_Full`), which means its outflow isn't
     keeping up.
  2. Empty the hopper of a vehicle that is parked and not being driven.
  3. Pick up loose dust canisters.
  4. Take what it holds to the nearest station and deposit it.
  5. Press the sell button on an intake whose tray has dust.
- **Capacity:** 200 kg per trip. It walks between jobs and idles at the base when there is
  nothing to do.
- **Never starves production (my call):** it never takes from machines, conveyors, catchers or
  any storage that `MoonWorld.MachineStorage(id)` reports as machine storage, and never from a
  dock that isn't full.
- **Overlap (my call):** all selling, whether by the Sweeper, the Hauler or the trainer's
  auto-sell, goes through one shared seller routine. It presses an intake only when it isn't
  already selling, and at most once per sale, so they never double-press or fight.

### Shared behaviour

- **One of each in this version.** Hiring is a one-time purchase with no wages and no firing or
  refund (my call, open to change).
- **Shop:** both are bought **in the in-game shop**, as cards with the game's own icons (Brush
  for the Sweeper, Hauler for the Hauler). They go under a "Crew" heading, or inside
  BaseEquipment if a new heading can't be added. Buying takes the price from Aryan's in-game
  money and refuses if he can't afford it. A bought card shows "Hired". If the shop's Concept
  cards can't take a buy action, the builder may draw a Crew page inside the shop window with
  the game's UI kit. **The trainer panel alone is not acceptable as the shop.**
- **Prices (my call):** Sweeper $450, Hauler $350.
- **Persistence (my call):** who is hired is stored in a new file next to `moon_trainer.py` (for
  example `crew.json`), keyed **per game, not per slot number**. A new game started in a reused
  slot starts with no crew. Key it by something unique to the game: the session folder hash inside
  the slot (for example `slot-1/e42ac78b…`) if that changes with a new game, otherwise a marker
  the builder picks after checking `MoonSaveSlots`. Out of scope: reconciling hires with money
  after restoring an old save backup, or after quitting without saving. Helpers respawn near
  Aryan when a shift loads.
- **Status:** the trainer panel shows each helper's state (cleaning / walking to station /
  hauling from dock / idle) and kg delivered. A short HUD notice (`MoonHudNotice`) appears when a
  helper deposits or sells.
- **Panel switches:** turn the Sweeper and Hauler on or off (pause them) without unhiring them.
  The trainer's master "enabled" switch pauses them too.
- **Solo only.** Helpers don't spawn in crew (multiplayer) sessions.

## Goals

- Two working helpers, bought in the shop, that look and move like crewmates and add income.
- Behaviour that holds up over a long session: no getting stuck, no dust lost, no repeated
  error spam.

## Non-goals (this version)

- Driver, Surveyor and Architect helpers.
- More than one of each helper, wages, firing or refunds.
- Multiplayer support.
- Changing the game's save format. Hire state lives only in the mod's own file.

## Anti-goals (would make this a failure even if it technically works)

- Helpers that glitch the way the boosted robot vacuum did: moving without actually cleaning,
  jittering, or getting stuck on terrain or buildings. A helper that is stuck for a few seconds
  must recover (re-path, hop or step around). If it can't, it may reposition out of the player's
  view.
- Dust or money going missing, or being counted twice: hopper → station must conserve kg.
- Anything that can crash the game. Every helper step runs in try/catch, and the main-thread
  hook must never throw. This matters even more because the agent is eternalized and can't be
  reloaded without restarting the game.
- Corrupting or bloating Aryan's save. Before testing on his save, back up `MoonSessions`, and
  restore it afterwards, as done in earlier sessions.

## Constraints

- Every helper action goes through game methods on the main thread, inside the existing tick.
  The tick's budget must stay small (well under 1 ms per frame on average); spread heavy work
  such as finding dirt or stations across frames.
- Changes to `trainer.ts` only take effect after the game restarts, because of the duplicate
  injection guard. The builder must say so when handing over.
- Testing touches Aryan's real save (`%USERPROFILE%\AppData\LocalLow\DragDropGames\MoonSweepers\
  MoonSessions`), so back it up and restore it as above.

## Left to the builder

- How dirty ground is found: dust sampling via `MoonWorld`, the robot dust-map classes, or
  section and region data.
- How walking is driven (setting `Member.to`/`speed` and letting `Step` animate, or moving
  `position` directly) and the pathing and stuck-recovery approach.
- The exact cleaning parameters, tuned to the earn-back target.
- The file format for hire state, and how the shop injection is done (hooking `BuildShopMenu`
  or `Refresh`, or `AddConcept` plus a purchase hook).
- The names, eye styles and exact suit colours, within the orange/yellow direction.

## Later (to-do, not part of this build)

1. **Remaining crew:** Driver ($900, drives an owned vehicle on cleaning lanes using the vehicle
   `Autopilot` flag, then unloads), Surveyor ($250, finds the dirtiest unpaid sections and points
   other helpers there), Architect ($1,500, builds base layouts).
2. **Blueprints in the shop:** ready-made base layouts (depots, conveyors, catwalks) bought in
   the shop and placed with normal build costs. These use `MoonWorld.PlanStructure`,
   `BuildingPlanValid`, `TryBuildStructure`, `TryBuildConveyor` and `TryBuildDepot`.
3. **Layout advisor toolkit:** a real-time in-game overlay that reads where the machines are now
   (depots, processors, packagers, catchers, stations) and shows the conveyor layout that
   maximizes earnings for that placement, including expected $/hour. It could later hand the
   chosen layout to the Architect to build.
