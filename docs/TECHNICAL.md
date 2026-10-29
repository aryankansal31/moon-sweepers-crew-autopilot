# Moon Sweepers — speed + automation mod

A working copy of the game lives in `game/` (not part of this repository: bring your own copy of
Moon Sweepers). The original install is never touched.
No game files are patched, not even in the copy. The trainer injects at runtime with Frida
and its hooks disappear when it detaches.

## Use

Double-click **`Play with Trainer.bat`**. It starts `game\MoonSweepers.exe`, or attaches to
the game if it is already running, and opens a control panel that stays on top.

- The trainer lives inside the game process until the game closes. Closing the panel or its
  console window does **not** remove it, and running the `.bat` again just reopens the panel
  (it never injects twice).
- To play without it, untick **Trainer enabled** in the panel. Everything goes back to vanilla
  values and 1x speed.
- The panel and the game talk through `config.json` (settings) and `status.json` (live status).
  You can edit `config.json` by hand while the game runs; changes apply within half a second.

Headless: `tools\venv\Scripts\python -I moon_trainer.py --nogui --set timeScale=3 autoSell=on`

| Hotkey (game window focused) | Action |
|---|---|
| F5 / F6 | Game speed down / up (0.5x … 10x) |
| F7 | Game speed back to 1x |
| F8 | Toggle auto-deposit + auto-sell |
| F9 | Toggle robot bin boost (3x bin size and unload rate / off) |
| F10 | Deposit your container now, from anywhere |
| F11 | Crew window: hire Dusty (1) or Hank (2); F11 again closes it |

## What it changes

| Feature | How |
|---|---|
| Game speed | Sets `UnityEngine.Time.timeScale` every frame while unpaused. Verified: 3x gives 2.92 game seconds per real second |
| Walk, vehicle, cleaning width/depth, container capacity, deposit speed | Wraps `MoonWorld.MoveSpeedMultiplier`, `VehicleSpeedFactor`, `CleaningWidthMultiplier`, `CleaningDepthMultiplier`, `ContainerCapacityMultiplier` and `DepositTimeMultiplier`, multiplying on top of your upgrade-tree bonus. Verified live: walk 1.07 → 1.605 at 1.5x |
| Auto-deposit | When your container is full, empties it into the nearest dust station. Replays the second half of `MoonDustStation.Deposit`, because the real method only works when the first-person camera ray hits the station. The tray's value is read with `callDecimal`: frida-il2cpp-bridge mis-reads methods that return a `System.Decimal`, and earlier versions credited auto-deposited trays with almost $0 |
| Auto-sell | Presses the station's intake sell button (`MoonDepositIntake.Press`) whenever its tray has dust. That method has no distance check |
| Robot vacuums | Multiplies each robot's bin size and unload rate, and keeps the world's storage record for the robot (`FitVehicleCapacity`) the same size, otherwise the robot fills to its authored 40 kg and keeps driving without collecting. Movement is left alone: at 3x travel the robot drives its lanes without cleaning (it cleans in fixed 0.4 s / 0.3 m strokes). Robots still get faster with game speed |
| Flags and sites on the map | The map screen normally draws only landmarks you've raised (`MoonMapScreen.ShowFlags` checks `IsLandmarkRaised`). While it draws, the trainer reports all 221 (195 flags, 26 landing sites) as raised, then dims the really-raised ones to 30% and enlarges the nearest unraised one. The panel shows the raised count and the nearest unraised landmark with its distance. Raising them is still up to you |

| Crew helpers | Dusty the Sweeper and Hank the Hauler, hired from the trainer panel. See **Crew** below |

Only use it in **solo** shifts. In a crew session the host's numbers win, and a speed-up desyncs the other players.

## Crew

Two helpers you hire during a solo shift, either in game or from the panel:

- **In game:** press **F11** for the crew window (drawn with the game's own UI kit), then **1** for
  Dusty or **2** for Hank. F11 closes it. While it's open the number keys don't switch tools.
- **Panel:** the **Hire Dusty ($450)** / **Hire Hank ($350)** buttons.

The price comes out of your in-game money and the game shows a notice ("Dusty has joined your crew").
They're real astronauts with their own suits and name tags, paid for once, and they work only in solo
shifts. (The game's own card shop isn't used: it only opens at a Prototype Station.)

| Helper | Price | Look | What it does |
|---|---|---|---|
| **Dusty the Sweeper** | $450 | Teal suit, "Happy" eyes, broom | Cleans dust near you in 3 m lanes, first within ~20 m of you, widening to 45, 75, 150 and 250 m while the nearer ground is clean (a base swept by robots has no dust for a long way). A tiny-dose stroke works as a dirt sensor that weighs what it picks up, so clean lanes are skipped without walking them. Fills a 150 kg hopper and empties it into your packaging machine (see **Unloading**). The money is yours |
| **Hank the Hauler** | $350 | Yellow suit, "Determined" eyes | Empties robot docks that are completely full and the hoppers of vehicles you've parked, carries up to 200 kg and empties it into your packaging machine (see **Unloading**). Never touches machine storage or a dock that still has room. Leaves loose canisters to you |

- **Payback:** Dusty earns back $450 in about 20 minutes on moderately dusty ground. On sparse
  ground it takes longer; on dense ground it's faster. A helper's dust is worth what yours is
  (price per kg × your payout upgrades).
- **Pausing:** the panel's **Dusty working** / **Hank working** switches pause a helper without
  un-hiring it. Unticking **Trainer enabled** pauses both.
- **Speed and buildings:** helpers move at half your running speed (upgrades and the trainer's walk boost included), never slower than a walk. They check the way ahead with the game's physics and walk round buildings, never under a roof; they unload from open ground next to a machine or station.
- **Unloading:** a full helper takes its load to the nearest packaging machine with room and moves the dust into your share of its stock (100 kg per machine); the machine packs it and pays you as it does for your own loads. Whatever doesn't fit stays in the hopper for the next trip; if every machine is full it waits beside one. Only when no packaging machine is built does it deposit and sell at a dust station instead.
- **Long trips:** helpers walk, but a trip longer than 60 m (catching up with you after you drive
  off, or a station far from fresh dust) finishes out of your view. You never see one teleport.
- **Saved:** who you've hired is kept in `crew.json` per game, so a new game in the same slot starts
  without crew. Helpers' hoppers are world storages saved with your game, so nothing is lost on
  reload.
- **Updates:** the trainer stays loaded until the game closes, so a new version only takes effect
  after you restart the game with `Play with Trainer.bat`.

Status lines in the panel show what each helper is doing, how much it has delivered and earned.

## Vehicle autopilot

Every vehicle model has an **Autopilot** row at the bottom of its **Upgrades** page in the garage
(below Floodlights), priced like the game's own upgrades: $1,000 × the model's price scale
($500 for the Push sweeper, $3,000 for the Mega vacuum rover). Pick the row, press **INSTALL**;
afterwards the same button reads **TURN OFF** / **TURN ON**. Who has it is saved per game in
`autopilot.json` next to `crew.json`.

An autopilot vehicle you're not driving:

- drives with its own physics and cleans dust in lanes of its own cleaning width around **where you
  left it** (drive it to dusty ground and get out), widening from 25 m to 250 m as nearby ground
  gets clean. It skips ground under
  roofs and cramped spots between machines and belts;
- when its hopper is 98% full, drives back to the garage and empties it into the garage collector
  (the silo that turns dust into capsules), from open ground beside the unload pad. One vehicle
  per garage unloads at a time; the others wait;
- reverses out when it gets stuck, rights itself when it flips, and if it's boxed in for 25 s it
  is put back beside its garage;
- far from you (beyond ~500 m) the game freezes parked vehicles because the ground there has no
  collision; autopilot keeps moving them along the ground itself until you come back;
- stops the moment you get in, and carries on when you leave it. Solo shifts only.

## Troubleshooting

- **`RtlCreateUserThread returned 0xc000010a`**: this means "process is terminating". An earlier version of
  the trainer crashed the game whenever its host window was killed, and Windows left those
  instances stuck (`MoonSweepers.exe` with 1 thread, can't be ended in Task Manager). The launcher
  now skips them. They only go away after a **reboot**, and they waste memory until then.
- **`[compile] ...` errors**: the agent TypeScript failed to build. The message gives the file and line.

## Layout

```
agent/src/trainer.ts   the mod (frida-il2cpp-bridge), eternalized in the game process
agent/src/crew/        crew helpers: pure logic (hires, seller, lanes, brains, purchase; unit-tested)
                       and game adapters (body, world, unity, manager, hiring, window)
agent/test/            node:test unit tests (cd agent && npm test)
agent/src/sandbox.ts   isolation for a second, development copy of the game (scripts/sandbox.py)
agent/src/dump.ts      runtime class dump, used for analysis
agent/src/probe.ts     test helper: start shift, read player state, resolve RVAs
moon_trainer.py        launcher + Tk control panel
tests/                 Python unit tests for the panel (python -m unittest discover -s tests)
scripts/               build_agent.py, sandbox.py, annotate.py / disasm.py / xrefs.py, live tests
analysis/              dump.cs (all assemblies), assembly-csharp.cs, moonworld.cs
save-backup/           copy of MoonSessions taken 2026-10-27 before testing
tools/venv/            Python 3.12 + frida 17.2.3, capstone, pefile
```

## Analysis notes

- Unity **6000.6.0f1**, IL2CPP, metadata version 0x6C. Static dumpers (Il2CppDumper and others) don't
  support this yet, so classes were dumped at runtime with frida-il2cpp-bridge 0.14. This follows the
  reverse-skill `seed-014_unity-il2cpp-reverse` flow, using its dynamic branch.
- The game code is `Assembly-CSharp`, namespace `MoonCleaners` (about 950 types). `MoonWorld` holds the
  economy and every upgrade effect. `MoonRunOver.get_LocalWalker()` returns the local player.
- `MoonDustStation.Deposit` (RVA 0x33b9f0) requires first-person view and a `Physics.Raycast` from
  `viewCamera` that hits the station within `interactionReach`. After that it calls
  `BeginDeposit` → `MoonWorld.DepositAtStation(playerId, max(1, displayedCanisterKilograms))` →
  `DepositStation = -1` → `Take(kg, WaitingWorth delta)`.
- Saves: `%USERPROFILE%\AppData\LocalLow\DragDropGames\MoonSweepers\MoonSessions` (shared with the
  original install, since this is Unity's per-user data folder).
- `MoonDevTools` only has a `Noclip` flag. `MoonWorld.DevAddMoney` exists but the trainer doesn't use it.

## If a game update breaks it

Re-run the dump (`tools\venv\Scripts\python -I scripts\run_agent.py agent\src\dump.ts --out analysis\dump.cs`)
and check that the method and field names used in `trainer.ts` still exist. The trainer resolves
everything by name, never by offset, so it survives most patches.
