import "frida-il2cpp-bridge";
import { HireStore, parseHireRequest } from "./crew/hires.ts";
import { AutopilotStore } from "./crew/autopilot.ts";
import { AutopilotManager } from "./crew/autopilot-driver.ts";
import { installGarageAutopilot } from "./crew/garage-autopilot.ts";
import { seller, type Intake } from "./crew/seller.ts";
import { CrewManager } from "./crew/manager.ts";
import { hireHelper } from "./crew/hiring.ts";
import { CrewWindow } from "./crew/window.ts";
import { crewWindowModel } from "./crew/window-model.ts";
import { LOCAL_PLAYER } from "./crew/world.ts";
import { callDecimal, decimal } from "./crew/unity.ts";

// Moon Sweepers trainer. All game calls happen inside the MoonFramePacer.Update hook, i.e. on
// Unity's main thread.
//
// The launcher eternalizes this script and detaches, so the hooks never depend on the Python
// process: if Frida tears hooks down while the main thread is inside one, the game hard-crashes.
// Settings therefore come from config.json (polled) and status goes to status.json.

interface Config {
    enabled: boolean;        // false = pass everything through and run at 1x
    timeScale: number;       // Time.timeScale while unpaused
    moveMult: number;        // on top of MoonWorld.MoveSpeedMultiplier
    cleanWidthMult: number;  // MoonWorld.CleaningWidthMultiplier
    cleanDepthMult: number;  // MoonWorld.CleaningDepthMultiplier
    capacityMult: number;    // MoonWorld.ContainerCapacityMultiplier
    depositSpeedMult: number;// divides MoonWorld.DepositTimeMultiplier
    vehicleMult: number;     // MoonWorld.VehicleSpeedFactor
    robotBinMult: number;    // robot vacuum bin size and unload rate (never its movement)
    autoDeposit: boolean;    // dump a full container into the nearest station
    autoSell: boolean;       // press the intake sell button when the tray has dust
    mapLandmarks: boolean;   // draw every flag and site on the map, raised ones dimmed
    hotkeys: boolean;
}

const config: Config = {
    enabled: true, timeScale: 1, moveMult: 1, cleanWidthMult: 1, cleanDepthMult: 1, capacityMult: 1,
    depositSpeedMult: 1, vehicleMult: 1, robotBinMult: 1, autoDeposit: false, autoSell: false, mapLandmarks: true, hotkeys: true,
};

const SPEED_STEPS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10];
const AUTOMATION_INTERVAL_MS = 500;
const FILE_POLL_MS = 500;

const status = {
    ticks: 0, inGame: false, timeScale: 1, deposits: 0, sales: 0, robots: 0,
    landmarks: "", nearestLandmark: "", gameKey: "", crewReply: { id: "", text: "" }, crew: [] as string[], haulerTrips: [] as string[], crewTrace: [] as string[], crewMsPerFrame: 0, lastError: "",
};
const CREW_TICK_MS = 50;
const LANDMARK_INTERVAL_MS = 2000;
const RAISED_ALPHA = 0.3;    // dim landmarks already raised
const NEAREST_SCALE = 1.8;   // enlarge the closest unraised one

function log(msg: string) {
    try { send({ type: "log", msg }); } catch (e) { /* no host attached */ }
}

function err(where: string, e: unknown) {
    const text = `${where}: ${e}`;
    if (text !== status.lastError) log(text);
    status.lastError = text;
}

// --- Files shared with the control panel -------------------------------------------------------
const paths = { config: "", status: "", crew: "" };
let configText = "";
let crewText = "";
let crewStore = new HireStore(null);

// autopilot.json next to crew.json: which vehicles have the Autopilot upgrade, and whether it is on.
// The agent writes it (garage purchases); it is re-read when it changes on disk.
let autopilotStore = new AutopilotStore(null);
let autopilotText = "";
const autopilotPath = () => paths.crew.replace(/crew\.json$/, "autopilot.json");

function loadAutopilotFile() {
    if (!paths.crew) return;
    let text: string;
    try { text = File.readAllText(autopilotPath()); } catch (e) { return; }  // none yet
    if (text === autopilotText) return;
    const store = AutopilotStore.parse(text);
    if (!store) return;  // half-written: retry on the next poll
    autopilotStore = store;
    autopilotText = text;
}

function saveAutopilotFile() {
    if (!paths.crew) return;
    const text = autopilotStore.toJSON();
    if (text === autopilotText) return;
    try {
        File.writeAllText(autopilotPath(), text);
        autopilotText = text;
    } catch (e) { err("saveAutopilot", e); }
}

let crewLoaded = false;

// The agent owns hires and slot records; the panel only flips pause flags. So after the first
// load, a changed crew.json contributes its pause flags and nothing else, and an unreadable one
// (half-written, locked) changes nothing: it must never read as "no hires".
function loadCrewFile() {
    if (!paths.crew) return;
    let text: string;
    try { text = File.readAllText(paths.crew); } catch (e) { return; }  // no crew.json yet, or locked
    if (text === crewText) return;
    if (!crewLoaded) {
        const store = HireStore.parse(text);
        if (!store) return;  // retry on the next poll
        crewStore = store;
        crewLoaded = true;
    } else {
        crewStore.adoptPaused(text);
    }
    crewText = text;
}

let crewSaveFailures = 0;
let MoveFileExW: SystemFunction<number, [NativePointerValue, NativePointerValue, number]> | null = null;

function saveCrewFile() {
    if (!paths.crew) return;
    const text = crewStore.toJSON();
    if (text === crewText) return;
    // Write a temp file and rename it over crew.json, so the panel never reads half a file.
    // crewText only moves on once the file really holds `text`; a failed write retries next time.
    try {
        const tmp = paths.crew + ".agent.tmp";
        File.writeAllText(tmp, text);
        const move = MoveFileExW ??= new SystemFunction(Process.getModuleByName("kernel32.dll").getExportByName("MoveFileExW"),
            "int", ["pointer", "pointer", "uint32"]);
        const MOVEFILE_REPLACE_EXISTING = 1, MOVEFILE_WRITE_THROUGH = 8;
        const r = move(Memory.allocUtf16String(tmp), Memory.allocUtf16String(paths.crew),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
        if (!r.value) throw new Error(`MoveFileExW failed, error ${(r as WindowsSystemFunctionResult<number>).lastError}`);
        crewText = text;
        crewLoaded = true;
        crewSaveFailures = 0;
    } catch (e) {
        // A lone failure is the panel reading crew.json at that instant (access denied): the next
        // save retries. Report only a run of them.
        if (++crewSaveFailures >= 5) err("saveCrew", e);
    }
}

function loadConfigFile() {
    if (!paths.config) return;
    let text: string;
    try { text = File.readAllText(paths.config); } catch (e) { return; }
    if (text === configText) return;
    try {
        const next = JSON.parse(text);
        for (const k of Object.keys(config) as (keyof Config)[]) {
            if (typeof next[k] === typeof config[k]) (config as any)[k] = next[k];
        }
        configText = text;
    } catch (e) { /* panel mid-write; retry next poll */ }
}

function saveConfigFile() {
    if (!paths.config) return;
    configText = JSON.stringify(config, null, 2);
    try { File.writeAllText(paths.config, configText); } catch (e) { err("saveConfig", e); }
}

function writeStatus() {
    if (!paths.status) return;
    try {
        File.writeAllText(paths.status, JSON.stringify({ ...status, pid: Process.id, at: Date.now() }));
    } catch (e) { /* panel reading; next write wins */ }
}

// One trainer per game process: a second injection would multiply everything twice.
const kernel32 = Process.getModuleByName("kernel32.dll");
const CreateMutexW = new SystemFunction(kernel32.getExportByName("CreateMutexW"), "pointer", ["pointer", "int", "pointer"]);
const ERROR_ALREADY_EXISTS = 183;
const mutex = CreateMutexW(NULL, 0, Memory.allocUtf16String(`Local\MoonSweepersTrainer-${Process.id}`)) as unknown as WindowsSystemFunctionResult<NativePointer>;
const duplicate = mutex.lastError === ERROR_ALREADY_EXISTS;

rpc.exports = {
    init: (p: typeof paths) => {
        if (!duplicate) {
            Object.assign(paths, p);
            loadConfigFile();
            loadCrewFile();
            loadAutopilotFile();
            writeStatus();
        }
        return { pid: Process.id, duplicate };
    },
};

// --- Win32 hotkeys ------------------------------------------------------------------------------
const user32 = Process.getModuleByName("user32.dll");
const GetAsyncKeyState = new NativeFunction(user32.getExportByName("GetAsyncKeyState"), "int16", ["int"]);
const GetForegroundWindow = new NativeFunction(user32.getExportByName("GetForegroundWindow"), "pointer", []);
const GetWindowThreadProcessId = new NativeFunction(user32.getExportByName("GetWindowThreadProcessId"), "uint32", ["pointer", "pointer"]);

const VK = { F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, D1: 0x31, D2: 0x32 };
const keyWasDown: Record<number, boolean> = {};

function gameFocused(): boolean {
    const pid = Memory.alloc(4);
    GetWindowThreadProcessId(GetForegroundWindow(), pid);
    return pid.readU32() === Process.id;
}

function pressed(vk: number): boolean {
    const down = (GetAsyncKeyState(vk) & 0x8000) !== 0;
    const edge = down && !keyWasDown[vk];
    keyWasDown[vk] = down;
    return edge;
}

if (!duplicate) Il2Cpp.perform(() => {
    const game = Il2Cpp.domain.assembly("Assembly-CSharp").image;
    const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
    const cls = (name: string) => game.class(`MoonCleaners.${name}`);

    const Time = core.class("UnityEngine.Time");
    const World = cls("MoonWorld");
    const Session = cls("MoonSession");
    const RunOver = cls("MoonRunOver");
    const Station = cls("MoonDustStation");
    const Robot = cls("MoonRobotVacuum");
    const Notice = cls("MoonHudNotice");

    // --- Upgrade-multiplier hooks: scale whatever the player's upgrade tree already gives ------
    function scale(name: string, factor: () => number) {
        const m = World.method<number>(name, 1);
        m.implementation = function (player) {
            const base = (this as Il2Cpp.Object).method<number>(name, 1).invoke(player as Il2Cpp.String);
            return config.enabled ? base * factor() : base;
        };
    }
    scale("MoveSpeedMultiplier", () => config.moveMult);
    scale("CleaningWidthMultiplier", () => config.cleanWidthMult);
    scale("CleaningDepthMultiplier", () => config.cleanDepthMult);
    scale("ContainerCapacityMultiplier", () => config.capacityMult);
    scale("DepositTimeMultiplier", () => 1 / Math.max(config.depositSpeedMult, 0.01));
    scale("VehicleSpeedFactor", () => config.vehicleMult);

    // --- Helpers -----------------------------------------------------------------------------
    function notify(text: string) {
        try {
            const walker = RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke();
            if (walker.isNull()) return;
            const notice = Notice.method<Il2Cpp.Object>("For").invoke(walker);
            if (!notice.isNull()) notice.method("Show", 2).invoke(Il2Cpp.string(text), 2.0);
        } catch (e) { err("notify", e); }
    }

    function applyTimeScale() {
        const cur = Time.method<number>("get_timeScale").invoke();
        status.timeScale = cur;
        if (cur <= 0) return;                        // paused: leave alone, re-applied on resume
        const want = config.enabled ? config.timeScale : 1;
        if (Math.abs(cur - want) > 1e-3) Time.method("set_timeScale").invoke(want);
    }

    function setSpeed(v: number) {
        config.timeScale = v;
        notify(`Game speed ${v}x`);
        saveConfigFile();
    }

    function handleHotkeys() {
        if (!config.hotkeys || !gameFocused()) { for (const k of Object.values(VK)) pressed(k); return; }
        const idx = SPEED_STEPS.indexOf(config.timeScale);
        if (pressed(VK.F5)) setSpeed(SPEED_STEPS[Math.max(0, (idx < 0 ? 1 : idx) - 1)]);
        if (pressed(VK.F6)) setSpeed(SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, (idx < 0 ? 1 : idx) + 1)]);
        if (pressed(VK.F7)) setSpeed(1);
        if (pressed(VK.F8)) {
            const on = !(config.autoDeposit && config.autoSell);
            config.autoDeposit = config.autoSell = on;
            notify(`Auto deposit + sell ${on ? "ON" : "OFF"}`);
            saveConfigFile();
        }
        if (pressed(VK.F10)) depositNow();
        if (pressed(VK.F11)) toggleCrewWindow();
        if (crewWindow.isOpen) {
            if (pressed(VK.D1)) crewWindowHire("sweeper");
            if (pressed(VK.D2)) crewWindowHire("hauler");
        }
        if (pressed(VK.F9)) {
            const on = config.robotBinMult === 1;
            config.robotBinMult = on ? 3 : 1;
            notify(`Robot bin boost ${on ? "3x" : "off"}`);
            saveConfigFile();
        }
    }

    // Robot vacuums: remember each robot's authored stats, then apply robotBinMult on top of them.
    // Movement fields (cleaningSpeed, travelSpeed, acceleration) must stay authored: the robot
    // cleans in fixed strokes (StrokeInterval 0.4 s, PadStrokeStep 0.3 m), and at 3x travel it
    // drives its lanes without removing any dust. timeScale already speeds robots up evenly.
    const ROBOT_FIELDS = ["capacityKilograms", "unloadKilogramsPerSecond"];
    const robotBase = new Map<string, Record<string, number>>();
    function boostRobots() {
        const list = Robot.field<Il2Cpp.Object>("active").value;
        if (list.isNull()) { status.robots = 0; return; }
        const count = list.method<number>("get_Count").invoke();
        status.robots = count;
        for (let i = 0; i < count; i++) {
            const r = list.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (r.isNull()) continue;
            const key = r.handle.toString();
            let base = robotBase.get(key);
            if (!base) {
                base = {};
                for (const f of ROBOT_FIELDS) base[f] = r.field<number>(f).value as number;
                robotBase.set(key, base);
            }
            for (const f of ROBOT_FIELDS) {
                const want = base[f] * (config.enabled ? config.robotBinMult : 1);
                if (r.field<number>(f).value !== want) r.field<number>(f).value = want;
            }
            // The world keeps its own record of each robot's storage, registered at the authored
            // size. If it stays smaller than the robot's bin, the robot never heads home and keeps
            // driving its lanes while the world refuses more dust, so keep the two in step.
            const world = r.field<Il2Cpp.Object>("world").value;
            const storage = r.field<Il2Cpp.String>("storageId").value;
            if (!world.isNull() && !storage.isNull()) {
                const cap = r.field<number>("capacityKilograms").value as number;
                if (world.method<number>("VehicleDustCapacity").invoke(storage) !== cap) {
                    world.method("FitVehicleCapacity").invoke(storage, cap);
                }
            }
        }
    }

    function stations(): Il2Cpp.Object[] {
        const list = Station.field<Il2Cpp.Object>("stations").value;
        if (list.isNull()) return [];
        const n = list.method<number>("get_Count").invoke();
        const out: Il2Cpp.Object[] = [];
        for (let i = 0; i < n; i++) {
            const s = list.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (!s.isNull()) out.push(s);
        }
        return out;
    }

    function position(c: Il2Cpp.Object): number[] {
        const p = c.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke();
        return ["x", "y", "z"].map(a => p.field<number>(a).value as number);
    }

    function nearest(walker: Il2Cpp.Object, candidates: Il2Cpp.Object[]): Il2Cpp.Object | null {
        const [x, y, z] = position(walker);
        let best: Il2Cpp.Object | null = null, bestD = Infinity;
        for (const c of candidates) {
            const [cx, cy, cz] = position(c);
            const d = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    function deposit(walker: Il2Cpp.Object, force: boolean): number {
        const inv = walker.field<Il2Cpp.Object>("upgradeAccount").value;
        if (inv.isNull()) return 0;
        if (!force) {
            if (!inv.method<boolean>("get_IsFull").invoke()) return 0;
            // IsFull is also true with no container equipped (0 of 0 kg).
            if (inv.method<number>("get_Kilograms").invoke() <= 0) return 0;
        }
        const station = nearest(walker, stations());
        if (!station) return 0;
        // MoonDustStation.Deposit(walker) only works when the first-person camera ray hits the
        // station, so replay what it does after that check (GameAssembly RVA 0x33bcd6..0x33be53).
        const world = station.field<Il2Cpp.Object>("world").value;
        if (world.isNull()) return 0;
        // WaitingWorth returns a Decimal, which frida-il2cpp-bridge mis-marshals (it read back as
        // garbage, so trays were credited ~$0); read it with callDecimal and pass a real Decimal.
        const waitingWorth = () => callDecimal(World.method("WaitingWorth"), world);
        station.method("BeginDeposit").invoke();
        const before = waitingWorth();
        const canister = Math.max(1, station.field<number>("displayedCanisterKilograms").value as number);
        const playerId = inv.field<Il2Cpp.String>("playerId").value;
        const kg = world.method<number>("DepositAtStation").invoke(playerId, canister);
        world.field<number>("DepositStation").value = -1;
        const after = waitingWorth();
        station.method("Take").invoke(kg, decimal(after - before));
        if (kg > 0) {
            status.deposits++;
            notify(`Deposited ${kg.toFixed(1)} kg`);
        }
        return kg;
    }

    // A station's sell button as the shared seller sees it. Press takes the walker it credits.
    function intakeFor(station: Il2Cpp.Object, walker: Il2Cpp.Object): Intake | null {
        const intake = station.method<Il2Cpp.Object>("get_Intake").invoke();
        if (intake.isNull()) return null;
        return {
            id: `station-${station.method<number>("get_Index").invoke()}`,
            selling: () => intake.method<boolean>("get_Selling").invoke(),
            canSell: () => intake.method<boolean>("get_CanSell").invoke(),
            trayKg: () => station.method<number>("get_TrayKilograms").invoke(),
            press: () => intake.method<boolean>("Press").invoke(walker),
        };
    }

    function autoSell(walker: Il2Cpp.Object) {
        for (const s of stations()) {
            const intake = intakeFor(s, walker);
            if (intake && seller.trySell(intake, Date.now())) status.sales++;
        }
    }

    function depositNow(): number {
        const walker = RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke();
        return walker.isNull() ? -1 : deposit(walker, true);
    }
    // --- Landmarks on the map ------------------------------------------------------------------
    // MoonMapScreen.ShowFlags (RVA 0x407100) loops over every landmark but only draws those
    // IsLandmarkRaised reports, handing out icons from flagMarks / siteMarks in order and
    // recording (index, screen point) in flagsShown. Report everything as raised while it runs,
    // then dim the icons of the ones that really are.
    const MapScreen = cls("MoonMapScreen");
    let drawingFlags = false;
    let nearestIndex = -1;

    World.method<boolean>("IsLandmarkRaised", 1).implementation = function (index) {
        if (drawingFlags) return true;
        return (this as Il2Cpp.Object).method<boolean>("IsLandmarkRaised", 1).invoke(index as number);
    };

    MapScreen.method("ShowFlags", 1).implementation = function (world) {
        const screen = this as Il2Cpp.Object;
        const all = config.enabled && config.mapLandmarks;
        drawingFlags = all;
        try {
            screen.method("ShowFlags", 1).invoke(world as Il2Cpp.Object);
        } finally {
            drawingFlags = false;
        }
        if (all) try { styleLandmarkIcons(screen, world as Il2Cpp.Object); } catch (e) { err("mapLandmarks", e); }
    };

    function listItem<T extends Il2Cpp.Field.Type>(list: Il2Cpp.Object, i: number): T {
        return list.method<T>("get_Item").invoke(i);
    }

    function styleLandmarkIcons(screen: Il2Cpp.Object, world: Il2Cpp.Object) {
        const shown = screen.field<Il2Cpp.Object>("flagsShown").value;
        const flagIcons = screen.field<Il2Cpp.Object>("flagMarks").value;
        const siteIcons = screen.field<Il2Cpp.Object>("siteMarks").value;
        if (shown.isNull() || flagIcons.isNull() || siteIcons.isNull()) return;
        let flags = 0, sites = 0;
        const n = shown.method<number>("get_Count").invoke();
        for (let k = 0; k < n; k++) {
            const index = listItem<Il2Cpp.ValueType>(shown, k).field<number>("Item1").value as number;
            const site = world.method<Il2Cpp.Object>("Landmark").invoke(index).method<boolean>("get_IsSite").invoke();
            const icon = site ? listItem<Il2Cpp.Object>(siteIcons, sites++) : listItem<Il2Cpp.Object>(flagIcons, flags++);
            if (icon.isNull()) continue;
            const raised = world.method<boolean>("IsLandmarkRaised", 1).invoke(index);
            const colour = icon.method<Il2Cpp.ValueType>("get_color").invoke();
            colour.field<number>("a").value = raised ? RAISED_ALPHA : 1;
            icon.method("set_color").invoke(colour);
            const rect = icon.method<Il2Cpp.Object>("get_rectTransform").invoke();
            const scale = rect.method<Il2Cpp.ValueType>("get_localScale").invoke();
            const want = index === nearestIndex ? NEAREST_SCALE : 1;
            if (scale.field<number>("x").value !== want) {
                for (const a of ["x", "y", "z"]) scale.field<number>(a).value = want;
                rect.method("set_localScale").invoke(scale);
            }
        }
    }

    // Nearest unraised landmark, by arc length over the moon (centred at the origin, unrotated).
    function updateLandmarks(walker: Il2Cpp.Object) {
        const world = walker.field<Il2Cpp.Object>("world").value;
        if (world.isNull() || !world.method<boolean>("get_LandmarksInPlay").invoke()) return;
        const [x, y, z] = position(walker);
        const r = Math.hypot(x, y, z);
        const total = world.method<number>("get_LandmarkCount").invoke();
        let best = -1, bestAngle = Infinity;
        for (let i = 0; i < total; i++) {
            if (world.method<boolean>("IsLandmarkRaised", 1).invoke(i)) continue;
            const d = world.method<Il2Cpp.ValueType>("LandmarkDirection").invoke(i);
            const dot = ((d.field<number>("x").value as number) * x + (d.field<number>("y").value as number) * y +
                         (d.field<number>("z").value as number) * z) / r;
            const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
            if (angle < bestAngle) { bestAngle = angle; best = i; }
        }
        nearestIndex = best;
        const raised = world.method<number>("get_RaisedLandmarkCount").invoke();
        status.landmarks = `${raised}/${total} raised`;
        if (best < 0) { status.nearestLandmark = "all raised"; return; }
        const l = world.method<Il2Cpp.Object>("Landmark").invoke(best);
        const kind = l.method<boolean>("get_IsSite").invoke() ? "site" : "flag";
        const metres = bestAngle * r;
        status.nearestLandmark = `${l.field<Il2Cpp.String>("name").value.content} (${kind}), ` +
            (metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${metres.toFixed(0)} m`);
    }

    // --- Which game is loaded ----------------------------------------------------------------
    // The slot folder's hash can't tell games apart: MoonWorld.InitializeProgress builds it from
    // MoonProgressStore.Hash(SavedWorldDefinition), the same for every new game on this moon. So the
    // game is identified from the active slot's play time (HireStore.identify): it only grows within
    // one game, and drops when a new game starts in the slot.
    const SaveSlots = cls("MoonSaveSlots");
    function gameKey(): string {
        const slot = SaveSlots.method<number>("get_Active").invoke();
        const summary = SaveSlots.method<Il2Cpp.Object>("Read").invoke(slot);
        // An unreadable summary (slot.json missing or locked mid-save) is "don't know", not play time
        // 0: reading it as 0 would start a new game and orphan every hire.
        const played = summary.isNull() ? null : summary.field<number>("playSeconds").value as number;
        const key = crewStore.identify(slot, played, () => Math.random().toString(36).slice(2, 10));
        saveCrewFile();
        return key || status.gameKey;
    }

    // --- Crew helpers ----------------------------------------------------------------------
    const Crew = cls("MoonCrew");
    const crew = new CrewManager(() => crewStore, {
        gameKey: () => status.gameKey,
        walker: () => RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke(),
        sell: station => {
            const walker = RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke();
            const intake = intakeFor(station, walker);
            const sold = intake !== null && seller.trySell(intake, Date.now());
            if (sold) status.sales++;
            return sold;
        },
        notify: text => notify(text),
    });
    // The in-game crew window (F11): keys 1/2 hire while it is open. The tool belt also selects
    // slots on the number keys, so MoonToolbelt.SelectSlot is blocked while the window is open.
    const crewWindow = new CrewWindow();
    let crewWindowMessage = "";
    const hireDeps = { store: () => crewStore, gameKey: () => status.gameKey, onHire: () => saveCrewFile() };
    function localWorld(): Il2Cpp.Object | null {
        const walker = RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke();
        if (walker.isNull() || !Session.method<boolean>("get_InGame").invoke()) return null;
        const world = walker.field<Il2Cpp.Object>("world").value;
        return world.isNull() ? null : world;
    }
    function drawCrewWindow(world: Il2Cpp.Object) {
        const money = callDecimal(world.class.method("WalletDollars"), world, Il2Cpp.string(LOCAL_PLAYER).handle);
        crewWindow.show(crewWindowModel({ hired: crewStore.hired(status.gameKey), money,
            inCrewSession: Crew.method<boolean>("get_Joined").invoke(), message: crewWindowMessage }));
    }
    function toggleCrewWindow() {
        try {
            if (crewWindow.isOpen) { crewWindow.close(); return; }
            const world = localWorld();
            if (!world) { notify("Start a shift to hire crew"); return; }
            crewWindowMessage = "";
            drawCrewWindow(world);
        } catch (e) { crewWindow.close(); err("crewWindow", (e as Error)?.stack ?? e); }
    }
    function crewWindowHire(kind: "sweeper" | "hauler") {
        try {
            const world = localWorld();
            if (!world) { crewWindow.close(); return; }
            crewWindowMessage = hireHelper(world, kind, hireDeps);
            notify(crewWindowMessage);
            drawCrewWindow(world);
        } catch (e) { err("crewWindow", (e as Error)?.stack ?? e); }
    }
    /** Keep an open window current (money, hires); close it when the shift ends. */
    function refreshCrewWindow() {
        if (!crewWindow.isOpen) return;
        try {
            const world = config.enabled ? localWorld() : null;
            if (!world) crewWindow.close(); else drawCrewWindow(world);
        } catch (e) { crewWindow.close(); err("crewWindow", (e as Error)?.stack ?? e); }
    }
    try {
        const Toolbelt = cls("MoonToolbelt");
        Toolbelt.method<boolean>("SelectSlot").implementation = function (index) {
            if (crewWindow.isOpen) return false;
            return (this as Il2Cpp.Object).method<boolean>("SelectSlot").invoke(index as number);
        };
    } catch (e) { err("crewWindow", e); }

    // Hire requests from the panel's buttons (crew-request.json next to crew.json). A request already
    // in the file when the trainer loads is treated as handled, so a restart never re-runs an old click.
    const requestPath = () => paths.crew.replace(/crew\.json$/, "crew-request.json");
    const readRequest = () => { try { return File.readAllText(requestPath()); } catch (e) { return null; } };
    let lastRequest: string | null = null;  // null until the first poll has seen what is on disk
    function pollHireRequest(world: Il2Cpp.Object | null) {
        if (!paths.crew) return;
        if (lastRequest === null) { lastRequest = parseHireRequest(readRequest(), "")?.id ?? ""; return; }
        const req = parseHireRequest(readRequest(), lastRequest);
        if (!req) return;
        lastRequest = req.id;
        let text: string;
        if (!world || world.isNull()) text = "Start a shift first, then hire";
        else try {
            text = hireHelper(world, req.kind, hireDeps);
        } catch (e) { text = `Hiring failed: ${e}`; err("hire", e); }
        status.crewReply = { id: req.id, text };
        notify(text);
        writeStatus();
    }
    try {
        installGarageAutopilot({ store: () => autopilotStore, gameKey: () => status.gameKey, save: () => saveAutopilotFile(), error: (w, e) => err(w, e) });
    } catch (e) { err("garageAutopilot", (e as Error)?.stack ?? e); }
    const autopilot = new AutopilotManager({
        store: () => autopilotStore,
        gameKey: () => status.gameKey,
        walker: () => RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke(),
        notify: text => notify(text),
    });
    let crewRunning = false, nextCrew = 0;
    // Cost of crew work, averaged over every frame since load (crew ticks every CREW_TICK_MS).
    let crewMs = 0, crewFrames = 0;
    function crewTick(now: number) {
        crewFrames++;
        status.crewMsPerFrame = crewFrames ? crewMs / crewFrames : 0;
        // Solo only: the same check MoonDepositIntake.Press makes before talking to a crew session.
        const allowed = config.enabled && status.inGame && !Crew.method<boolean>("get_Joined").invoke();
        if (!allowed) {
            if (crewRunning) { crew.stop(); autopilot.stop(); crewRunning = false; status.crew = []; }
            return;
        }
        if (now < nextCrew) return;
        nextCrew = now + CREW_TICK_MS;
        crewRunning = true;
        const t0 = Date.now();
        crew.tick(now);
        try { autopilot.tick(now); } catch (e) { autopilot.stop(); err("autopilot", (e as Error)?.stack ?? e); }
        status.crew = [...crew.statusLines(), ...autopilot.statusLines()];
        status.haulerTrips = crew.haulerTrips();
        status.crewTrace = crew.trace();
        crewMs += Date.now() - t0;
    }

    let nextAutomation = 0, nextFiles = 0, nextLandmarks = 0;
    function tick() {
        status.ticks++;
        const now = Date.now();
        if (now >= nextFiles) {
            nextFiles = now + FILE_POLL_MS;
            loadConfigFile();
            loadCrewFile();
            loadAutopilotFile();
            writeStatus();
        }
        try { crewTick(now); } catch (e) { err("crew", e); }
        if (config.enabled) try { handleHotkeys(); } catch (e) { err("hotkeys", e); }
        try { applyTimeScale(); } catch (e) { err("timeScale", e); }

        if (now < nextAutomation) return;
        nextAutomation = now + AUTOMATION_INTERVAL_MS;

        status.inGame = Session.method<boolean>("get_InGame").invoke();
        refreshCrewWindow();
        if (!status.inGame) { try { pollHireRequest(null); } catch (e) { err("hire", e); } return; }
        try { status.gameKey = gameKey(); } catch (e) { err("gameKey", e); }
        try { boostRobots(); } catch (e) { err("robots", e); }
        const walker = RunOver.method<Il2Cpp.Object>("get_LocalWalker").invoke();
        try { pollHireRequest(walker.isNull() ? null : walker.field<Il2Cpp.Object>("world").value); } catch (e) { err("hire", e); }
        if (walker.isNull()) return;
        if (!config.enabled) return;
        if (config.mapLandmarks && now >= nextLandmarks) {
            nextLandmarks = now + LANDMARK_INTERVAL_MS;
            try { updateLandmarks(walker); } catch (e) { err("landmarks", e); }
        }
        if (config.autoDeposit) try { deposit(walker, false); } catch (e) { err("autoDeposit", e); }
        if (config.autoSell) try { autoSell(walker); } catch (e) { err("autoSell", e); }
    }

    // MoonFramePacer lives for the whole session (menu + game) and runs once per frame.
    const update = cls("MoonFramePacer").method("Update");
    update.implementation = function () {
        (this as Il2Cpp.Object).method("Update").invoke();
        tick();
    };

    log("trainer loaded");
}, "main");
