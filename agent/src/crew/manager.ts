import "frida-il2cpp-bridge";
import type { HelperKind, HireStore } from "./hires.ts";
import { HelperBody, NAMES } from "./body.ts";
import { LanePlanner } from "./lanes.ts";
import { Navigator } from "./nav.ts";
import { chooseUnload, type UnloadTarget } from "./unload.ts";
import {
    SweeperBrain, CLEAN_DEPTH, CLEAN_DOSE, CLEAN_EDGE, CLEAN_WIDTH, HOPPER_KG, WALK_SPEED, WORK_RADIUS_M,
    helperPace, laneAhead, needsCatchUp, type SweeperAction,
} from "./sweeper-brain.ts";
import { HAULER_CAP_KG, nextJob, type HaulJob, type HaulWorld } from "./hauler-brain.ts";
import { add, dist, dot, norm, scale, sub, type Vec3 } from "./vec.ts";
import { positionOf, surfacePoint, toVec3 } from "./unity.ts";
import {
    approachPoint, cleanStroke, clearPath, covered, depositHopper, dustDollarsPerKg, feedPackager, packagers, type PackagerInfo, ensureHopper, haulSources, hopperKg, nearestStation, playerPace, senseDirt,
    stations, transferDust,
    type HaulSourceInfo,
} from "./world.ts";

// Runs hired helpers inside the trainer tick (Unity main thread). The trainer decides when crew
// may run at all (trainer enabled, in a shift, solo); the manager decides which helpers are out.

export interface CrewDeps {
    gameKey(): string;
    walker(): Il2Cpp.Object;           // the local MoonWalker (null object when none)
    sell(station: Il2Cpp.Object): boolean;
    notify(text: string): void;
}

const MOVE_WINDOW_MS = 2000;
const RETARGET_M = 0.3;              // re-issue a walk only when the goal moved this much
const FACING_DOT = 0.3;              // camera facing the body: don't pop it into place
const FAR_TRIP_M = 60;               // trips longer than this finish out of view (see Worker.travel)
const TRACE_MAX = 40;
const PACKAGERS_MS = 2000;           // re-read packagers (and their room) this often

interface UnloadPlan { target: UnloadTarget; station: Il2Cpp.Object | null; packager: PackagerInfo | null }

/** What every helper needs: a body, walking, and out-of-view travel for long distances. */
const NOTICE_EVERY_MS = 5000;        // at most one HUD notice per helper this often

abstract class Worker {
    readonly body: HelperBody;
    protected goal: Vec3 | null = null;
    protected trail: { t: number; p: Vec3 }[] = [];
    private lastNotice = -Infinity;
    private nav = new Navigator();
    readonly events: string[] = [];
    private lastEvent = "";

    /** Note a decision (repeats collapse); the last TRACE_MAX are kept. */
    protected note(text: string) {
        if (text === this.lastEvent) return;
        this.lastEvent = text;
        this.events.push(`${new Date().toISOString().slice(11, 19)} ${this.shortName}: ${text}`);
        if (this.events.length > TRACE_MAX) this.events.shift();
    }

    constructor(protected deps: CrewDeps, protected world: Il2Cpp.Object, walker: Il2Cpp.Object, protected kind: HelperKind, side: number) {
        const p = positionOf(walker);
        const right = toVec3(walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_right").invoke());
        this.body = HelperBody.spawn(walker, kind, add(p, scale(right, side)));
    }

    abstract tick(nowMs: number, walker: Il2Cpp.Object): void;
    abstract status(): string;

    protected get shortName(): string { return this.kind === "sweeper" ? "Dusty" : "Hank"; }

    protected notify(text: string) {
        const now = Date.now();
        if (now - this.lastNotice < NOTICE_EVERY_MS) return;
        this.lastNotice = now;
        this.deps.notify(text);
    }

    private packCache: { at: number; list: PackagerInfo[] } = { at: -Infinity, list: [] };

    /** Where to empty a load from `pos`: a packaging machine if one is built, else a dust station. */
    protected unloadPlan(pos: Vec3, nowMs: number): UnloadPlan {
        if (nowMs - this.packCache.at > PACKAGERS_MS) this.packCache = { at: nowMs, list: packagers(this.world) };
        const list = this.packCache.list;
        const station = nearestStation(this.world, pos);
        const target = chooseUnload(pos, list.map(p => ({ id: p.id, pos: p.pos, roomKg: p.capKg - p.kg })), station?.pos ?? null);
        return {
            target, station: station?.station ?? null,
            packager: target?.kind === "packager" ? list.find(p => p.id === target.id) ?? null : null,
        };
    }

    /** Empty `storageId` per the plan: into the packager, or deposit and sell at the station. */
    protected unloadInto(plan: UnloadPlan, storageId: string): { kg: number; worth: number } {
        if (plan.packager) {
            const kg = feedPackager(this.world, storageId, plan.packager);
            this.packCache.at = -Infinity;  // its room just changed
            if (kg > 0) this.notify(`${this.shortName} loaded ${kg.toFixed(1)} kg into the packaging machine`);
            return { kg, worth: kg * dustDollarsPerKg(this.world) };
        }
        if (!plan.station) return { kg: 0, worth: 0 };
        const r = depositHopper(this.world, storageId, plan.station);
        this.deposited(r.kg, plan.station);
        return r;
    }

    /** Deposit report, then sell the tray through the shared seller (and say so if it sold). */
    protected deposited(kg: number, station: Il2Cpp.Object) {
        if (kg > 0) this.notify(`${this.shortName} deposited ${kg.toFixed(1)} kg`);
        if (this.deps.sell(station)) this.notify(`${this.shortName} sold the tray`);
    }

    /** Body position (after catching arrival) and a 2 s movement trail for stuck detection. */
    protected sample(nowMs: number): Vec3 {
        this.body.update();
        const pos = this.body.position;
        this.trail.push({ t: nowMs, p: pos });
        while (this.trail.length > 1 && nowMs - this.trail[0].t > MOVE_WINDOW_MS) this.trail.shift();
        return pos;
    }

    protected movedLast2s(pos: Vec3): number { return dist(this.trail[0]?.p ?? pos, pos); }

    /** Walk toward `to`, round any building in the way (see nav.ts); re-checked every call. */
    protected walk(to: Vec3, speed: number) {
        const pos = this.body.position;
        const next = this.nav.next(pos, to, clearPath);
        const where = (p: Vec3) => p.map(v => Math.round(v)).join(",");
        this.note(next === to ? `walk direct to ${where(to)}` : `detour via ${where(next)} to ${where(to)}`);
        if (this.goal && dist(this.goal, next) < RETARGET_M) return;
        this.goal = next;
        this.body.walkTo(next, speed);
    }

    /** Place the body at `to` (no walking). */
    protected jump(to: Vec3) {
        this.goal = null;
        this.trail = [];
        this.nav.reset();
        this.body.placeAt(to);
    }

    /** Half Aryan's own running speed (upgrades and the trainer's walk boost included); see helperPace. */
    protected pace(): number {
        try {
            return helperPace(playerPace(this.world));
        } catch (e) {
            return WALK_SPEED;
        }
    }

    /**
     * Go to `to`. A walking helper can't keep up with vehicles, and bases or fresh dust can be
     * hundreds of metres apart, so long trips set off on foot and finish by placing the body there
     * once the player's camera faces neither end (never in view).
     */
    protected travel(to: Vec3, speed: number, pos: Vec3, walker: Il2Cpp.Object) {
        if (dist(pos, to) > FAR_TRIP_M && !this.cameraFaces(walker, this.body.drawnPosition ?? pos) && !this.cameraFaces(walker, to)) {
            this.jump(to);
            return;
        }
        this.walk(to, speed);
    }

    /** Is the player's camera looking toward `p`? Unknown counts as yes (never pop into view). */
    protected cameraFaces(walker: Il2Cpp.Object, p: Vec3): boolean {
        const cam = walker.field<Il2Cpp.Object>("viewCamera").value;
        if (cam.isNull()) return true;
        const t = cam.method<Il2Cpp.Object>("get_transform").invoke();
        const fwd = toVec3(t.method<Il2Cpp.ValueType>("get_forward").invoke());
        return dot(norm(fwd), norm(sub(p, positionOf(cam)))) >= FACING_DOT;
    }

    destroy() { this.body.destroy(); }
}

// --- Sweeper --------------------------------------------------------------------------------------

const SWEEPER_BRAIN_MS = 200;
const STROKE_MS = 200;
const CATCH_UP_BEHIND_M = 6;
const SENSE_LANES_PER_STEP = 3;      // dirt-sensor budget per brain step (<= 9 tiny strokes)
// Lane rings around the player: start within ~WORK_RADIUS_M, widen when that ground is used up
// (a standing player's surroundings run out fast, and a base swept by robots has no dust for a
// long way), all inside the brain's LEASH_M.
const PLAN_RADII = [WORK_RADIUS_M * 0.8, 45, 75, 150, 250];
export const SWEEPER_HOPPER_ID = "crew/sweeper";
// Where the dirt sensor's ~0.6 g per reading goes (kept apart so the hopper filling up can't blind it).
const SENSOR_STORAGE_ID = "crew/sensor";
const SENSOR_STORAGE_KG = 100_000;

class SweeperWorker extends Worker {
    private brain = new SweeperBrain();
    // Lanes on the ground (see LanePlanner): `world` is set by Worker's constructor before this runs.
    private planner = new LanePlanner(CLEAN_WIDTH, PLAN_RADII, p => surfacePoint(this.world, p));
    private nextBrain = 0;
    private nextStroke = 0;
    private lastStroke: Vec3 | null = null;
    private action: SweeperAction = { kind: "idle" };
    deposits = 0;
    kgDelivered = 0;
    earned = 0;
    private strokes = 0;
    private cells = 0;
    private brainSteps = 0;
    private stuckSteps = 0;

    constructor(deps: CrewDeps, world: Il2Cpp.Object, walker: Il2Cpp.Object) {
        super(deps, world, walker, "sweeper", 3);
        ensureHopper(world, SWEEPER_HOPPER_ID, HOPPER_KG);
        ensureHopper(world, SENSOR_STORAGE_ID, SENSOR_STORAGE_KG);
    }

    get kg(): number { return hopperKg(this.world, SWEEPER_HOPPER_ID); }
    private ahead(): number { return laneAhead(this.pace(), SWEEPER_BRAIN_MS); }
    /** The game's own record of the hopper size (set to HOPPER_KG when the hopper is created). */
    get capKg(): number { return this.world.method<number>("VehicleDustCapacity").invoke(Il2Cpp.string(SWEEPER_HOPPER_ID)); }
    get state(): string { return this.brain.state; }

    status(): string {
        const stuck = this.brainSteps ? (100 * this.stuckSteps / this.brainSteps).toFixed(1) : "0.0";
        return `${NAMES.sweeper}: ${this.brain.state} (${this.action.kind}, lanes ${this.planner.remaining()}/` +
            `${this.planner.lanes().length} left, strokes ${this.strokes} cells ${this.cells}, stuck ${stuck}%), hopper ` +
            `${this.kg.toFixed(1)}/${this.capKg.toFixed(0)} kg, ${this.kgDelivered.toFixed(1)} kg delivered in ` +
            `${this.deposits} trips, $${this.earned.toFixed(2)} earned`;
    }

    tick(nowMs: number, walker: Il2Cpp.Object): void {
        const pos = this.sample(nowMs);
        // Everything is measured on the terrain the body walks on: the player may be standing on a
        // station floor metres above it, and lanes planned up there would never be "reached".
        const player = surfacePoint(this.world, positionOf(walker));
        // Rejoin a player who drove off, behind them, while neither spot is in view.
        if (needsCatchUp(pos, player, this.brain.state)) {
            const back = toVec3(walker.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_forward").invoke());
            const spot = sub(player, scale(norm(back), CATCH_UP_BEHIND_M));
            if (!this.cameraFaces(walker, pos) && !this.cameraFaces(walker, spot)) {
                this.jump(spot);
                return;
            }
        }
        this.planner.ensure(player, nowMs);

        if (this.brain.state === "Clean" && nowMs >= this.nextStroke) {
            this.nextStroke = nowMs + STROKE_MS;
            if (this.lastStroke && dist(this.lastStroke, pos) > 0.01) {
                this.strokes++;
                this.cells += cleanStroke(this.world, this.lastStroke, pos, CLEAN_WIDTH, CLEAN_DEPTH, CLEAN_DOSE, CLEAN_EDGE, SWEEPER_HOPPER_ID);
            }
            this.lastStroke = pos;
            const was = this.planner.cleaning;
            this.planner.progress(pos, this.kg);
            if (was && !this.planner.cleaning) this.note("lane finished");
        }
        if (this.brain.state !== "Clean") this.lastStroke = null;

        if (nowMs < this.nextBrain) return;
        this.nextBrain = nowMs + SWEEPER_BRAIN_MS;

        const plan = this.unloadPlan(pos, nowMs);
        const wasCleaning = this.brain.state === "Clean";
        // Lane points are on a flat plan; put them on the terrain before the brain measures distances.
        // Only look for lanes while looking for work; between lanes the dirt sensor skips clean ones,
        // stroking into its own storage (a full hopper accepts nothing, so lanes would read "clean").
        const looking = this.brain.state === "Seek" || this.brain.state === "Clean";
        // A lane that runs into a building is dropped (the next one is picked below), and lane points
        // under a roof never count as dirty: helpers clean open ground only.
        if (wasCleaning && this.planner.cleaning) {
            const ahead = this.planner.target(pos, true, this.ahead());
            if (ahead && !clearPath(pos, surfacePoint(this.world, ahead))) {
                this.planner.dropCurrent();
                this.note("lane dropped: building ahead");
            }
        }
        const lanePoint = !looking ? null : wasCleaning && this.planner.cleaning
            ? this.planner.target(pos, true, this.ahead())
            : this.planner.nextDirtyStart(pos, q => {
                const g = surfacePoint(this.world, q);
                return !covered(g) && senseDirt(this.world, g, SENSOR_STORAGE_ID) > 0;
            }, SENSE_LANES_PER_STEP);
        const dirty = lanePoint ? surfacePoint(this.world, lanePoint) : null;
        this.action = this.brain.step({
            pos, playerPos: player, hopperKg: this.kg, hopperCapKg: this.capKg,
            nearestStation: plan.target?.pos ?? null, dirtyTarget: dirty, movedLast2s: this.movedLast2s(pos), nowMs,
            pace: this.pace(),
        });
        this.note(`${this.brain.state}/${this.action.kind}${dirty ? ` dirt at ${dirty.map(v => Math.round(v)).join(",")}` : ""}`);
        if (this.brain.state === "Clean" && !this.planner.cleaning) {
            this.planner.begin(pos, this.kg);
            const r = (p: Vec3 | null) => p ? p.map(v => Math.round(v)).join(",") : "-";
            this.note(`begin lane at ${r(pos)} -> end ${r(this.planner.currentEnd())}, first target ${r(this.planner.target(pos, true, this.ahead()))}`);
        }
        if (this.brain.state !== "Clean" && this.planner.cleaning) this.planner.pause(pos);
        this.brainSteps++;
        if (this.action.kind === "unstick" || this.action.kind === "reposition") this.stuckSteps++;
        this.carryOut(this.action, pos, plan, walker);
    }

    private carryOut(a: SweeperAction, pos: Vec3, plan: UnloadPlan, walker: Il2Cpp.Object) {
        switch (a.kind) {
            case "walk":
                this.body.setAct("Walk");
                if (this.brain.state === "ToStation") this.travel(a.to, a.speed, pos, walker);
                else this.walk(a.to, a.speed);
                break;
            case "clean": {
                // Walk act with the broom held; cleaning itself is our CleanToolStroke (never act Clean,
                // whose ApplyCrewStroke removes dust without credit).
                this.body.setAct("Walk");
                this.walk(this.planner.target(pos, true, this.ahead()) ?? add(pos, a.along), this.pace());
                break;
            }
            case "deposit": {
                const { kg, worth } = this.unloadInto(plan, SWEEPER_HOPPER_ID);
                if (kg > 0) {
                    this.deposits++;
                    this.kgDelivered += kg;
                    this.earned += worth;
                }
                break;
            }
            case "idle":
                this.body.setAct("Stand");
                this.goal = null;
                this.body.placeAt(pos);
                break;
            case "unstick":
                this.body.setAct("Walk");
                this.goal = null;
                this.walk(a.to, this.pace());
                break;
            case "reposition":
                if (!this.cameraFaces(walker, this.body.drawnPosition ?? pos) && !this.cameraFaces(walker, a.to)) this.jump(a.to);
                break;
        }
    }
}

// --- Hauler ---------------------------------------------------------------------------------------

export const HAULER_STORAGE_ID = "crew/hauler";
const HAULER_BRAIN_MS = 500;
const SOURCES_MS = 2000;             // re-read docks and vehicles this often
const AT_JOB_M = 3;

class HaulerWorker extends Worker {
    private nextBrain = 0;
    private nextSources = 0;
    private sources: HaulSourceInfo = { docks: [], vehicles: [] };
    private job: HaulJob | null = null;
    kgTaken = 0;
    kgDeposited = 0;
    deposits = 0;
    earned = 0;
    trips: string[] = [];

    constructor(deps: CrewDeps, world: Il2Cpp.Object, walker: Il2Cpp.Object) {
        super(deps, world, walker, "hauler", -3);
        ensureHopper(world, HAULER_STORAGE_ID, HAULER_CAP_KG);
    }

    get kg(): number { return hopperKg(this.world, HAULER_STORAGE_ID); }
    get capKg(): number { return this.world.method<number>("VehicleDustCapacity").invoke(Il2Cpp.string(HAULER_STORAGE_ID)); }

    status(): string {
        const doing = this.job ? `${this.job.kind}${"id" in this.job ? ` ${this.job.id}` : ""}` : "idle";
        return `${NAMES.hauler}: ${doing}, carrying ${this.kg.toFixed(1)}/${this.capKg.toFixed(0)} kg, ` +
            `taken ${this.kgTaken.toFixed(1)} kg, deposited ${this.kgDeposited.toFixed(1)} kg in ${this.deposits} trips, ` +
            `$${this.earned.toFixed(2)} earned`;
    }

    tick(nowMs: number, walker: Il2Cpp.Object): void {
        const pos = this.sample(nowMs);
        if (nowMs < this.nextBrain) return;
        this.nextBrain = nowMs + HAULER_BRAIN_MS;
        if (nowMs >= this.nextSources) {
            this.nextSources = nowMs + SOURCES_MS;
            this.sources = haulSources(this.world);
        }

        const carried = this.kg, cap = this.capKg;
        const station = nearestStation(this.world, pos);
        const plan = this.unloadPlan(pos, nowMs);
        const sellable: HaulWorld["sellable"] = [];
        const byIntake = new Map<string, Il2Cpp.Object>();
        for (const s of stations()) {
            const intake = s.method<Il2Cpp.Object>("get_Intake").invoke();
            if (intake.isNull() || s.method<number>("get_TrayKilograms").invoke() <= 0) continue;
            if (!intake.method<boolean>("get_CanSell").invoke() || intake.method<boolean>("get_Selling").invoke()) continue;
            const id = `station-${s.method<number>("get_Index").invoke()}`;
            byIntake.set(id, s);
            sellable.push({ intakeId: id, pos: approachPoint(this.world, surfacePoint(this.world, positionOf(s))) });
        }
        this.job = nextJob({
            docks: this.sources.docks, vehicles: this.sources.vehicles, canisters: [],
            carriedKg: carried, capKg: cap, stationPos: plan.target?.pos ?? null, sellable,
        }, pos);

        this.body.setCarryFill(cap > 0 ? carried / cap : 0);
        this.body.setAct(carried > 0 ? "Carry" : "Walk");
        if (!this.job) {
            // Nothing to do: wait at the base.
            if (station && dist(pos, station.pos) > AT_JOB_M) this.travel(station.pos, this.pace(), pos, walker);
            else { this.body.setAct("Stand"); this.goal = null; }
            return;
        }
        if (dist(pos, this.job.pos) > AT_JOB_M) {
            this.travel(this.job.pos, this.pace(), pos, walker);
            return;
        }
        this.doJob(this.job, carried, cap, plan, byIntake);
    }

    private doJob(job: HaulJob, carried: number, cap: number, plan: UnloadPlan, byIntake: Map<string, Il2Cpp.Object>) {
        switch (job.kind) {
            case "dock":
            case "vehicle": {
                const moved = transferDust(this.world, job.id, HAULER_STORAGE_ID, Math.max(0, cap - carried));
                this.kgTaken += moved;
                this.nextSources = 0;  // re-read: that source just changed
                this.log(`took ${moved.toFixed(2)} kg from ${job.id}`);
                break;
            }
            case "deposit": {
                const { kg, worth } = this.unloadInto(plan, HAULER_STORAGE_ID);
                if (kg > 0) {
                    this.deposits++;
                    this.kgDeposited += kg;
                    this.earned += worth;
                    this.log(`${plan.packager ? `packed ${kg.toFixed(2)} kg in packager ${plan.packager.id}` : `deposited ${kg.toFixed(2)} kg`} ($${worth.toFixed(2)})`);
                }
                break;
            }
            case "sell": {
                const s = byIntake.get(job.intakeId);
                if (s && this.deps.sell(s)) {
                    this.log(`sold the tray at ${job.intakeId}`);
                    this.notify(`${this.shortName} sold the tray`);
                }
                break;
            }
            case "canister":
                break;  // not collected in this version (see world.ts)
        }
    }

    private log(line: string) {
        this.trips.push(line);
        if (this.trips.length > 20) this.trips.shift();
    }
}

// --- Manager --------------------------------------------------------------------------------------

export class CrewManager {
    private workers = new Map<HelperKind, Worker>();
    private walkerHandle = "";

    // A getter, not a store: the trainer replaces its HireStore whenever crew.json changes on disk.
    constructor(private store: () => HireStore, private deps: CrewDeps) {}

    tick(nowMs: number): void {
        const walker = this.deps.walker();
        if (walker.isNull()) { this.forget(); return; }
        // A new shift means a new walker: the old bodies died with the scene, so just drop them.
        if (walker.handle.toString() !== this.walkerHandle) {
            this.forget();
            this.walkerHandle = walker.handle.toString();
        }
        const world = walker.field<Il2Cpp.Object>("world").value;
        for (const kind of ["sweeper", "hauler"] as const) {
            const want = this.wants(kind), have = this.workers.get(kind);
            if (want && !have) {
                this.workers.set(kind, kind === "sweeper" ? new SweeperWorker(this.deps, world, walker)
                                                          : new HaulerWorker(this.deps, world, walker));
            } else if (!want && have) {
                have.destroy();
                this.workers.delete(kind);
            }
        }
        for (const w of this.workers.values()) w.tick(nowMs, walker);
    }

    private wants(kind: HelperKind): boolean {
        const store = this.store();
        return store.hired(this.deps.gameKey()).includes(kind) && !store.paused(kind);
    }

    /** Leaving the shift, or a crew session: remove helpers that still exist. */
    stop(): void {
        for (const w of this.workers.values()) {
            try { w.destroy(); } catch (e) { /* scene already gone */ }
        }
        this.forget();
    }

    private forget() { this.workers.clear(); this.walkerHandle = ""; }

    statusLines(): string[] {
        return [...this.workers.values()].map(w => w.status());
    }

    /** Recent decisions per helper (status.json crewTrace), for diagnosing movement in a live game. */
    trace(): string[] {
        return [...this.workers.values()].flatMap(w => w.events);
    }

    haulerTrips(): string[] {
        const h = this.workers.get("hauler");
        return h instanceof HaulerWorker ? h.trips : [];
    }
}
