import "frida-il2cpp-bridge";
import type { HelperKind } from "./hires.ts";
import { dist, pointAlong, type Vec3 } from "./vec.ts";
import { destroy, enumValue, moon, surfacePoint, vector3, toVec3 } from "./unity.ts";

// A helper's body is a MoonDemoCrew member: the game's own scripted crewmate, drawn as a real
// MoonRemotePlayer with its own suit, eyes, held tool and name tag.
//
// How MoonDemoCrew.Step (RVA 0x76e8e0) moves a member, from its disassembly:
//  - act Stand (0) skips movement;
//  - otherwise travelled (0x94) += speed (0x54) * dt, and the member is drawn at
//    position (0x30) + (to (0x48) - position) * t, where t ping-pongs over the segment — demo crew
//    patrol back and forth, position itself is never written;
//  - the drawn point is grounded with MoonDemoCrew.Ground and sent to MoonRemotePlayer.Receive.
// So walkTo re-anchors the segment at the current point, and update() snaps the member to `to` on
// arrival (a zero-length segment stands still) before the patrol can turn it round.
//
// Do not use act Clean for real work: Step then calls CleanUnderTool → Stroke →
// MoonWorld.ApplyCrewStroke, which removes dust for a remote crewmate and credits nobody.
//
// Bodies stay on terrain: every point given to spawn/walkTo/placeAt is projected with
// surfacePoint (see unity.ts), because Ground can't see station floors.

export type Act = "Stand" | "Clean" | "Walk" | "Carry";

// Suit and eye-colour indices into MoonAstronautLook.SuitPresets / EyePresets; eye style into
// EyeNames. Aryan's own look is suit 0 (orange-ochre 0.77,0.46,0.08), eyes 0 "Classic", cyan.
export const LOOKS: Record<HelperKind, { suit: number; eyes: number; eyeColor: number }> = {
    sweeper: { suit: 4, eyes: 1, eyeColor: 8 },   // teal 0.10,0.62,0.62; "Happy"; green 0.40,1,0.62
    hauler: { suit: 2, eyes: 3, eyeColor: 3 },    // yellow 0.93,0.74,0.12; "Determined"; orange 1,0.52,0.20
};
export const NAMES: Record<HelperKind, string> = { sweeper: "Dusty (Sweeper)", hauler: "Hank (Hauler)" };
const TOOLS: Record<HelperKind, string> = { sweeper: "household_broom", hauler: "" };

// Name tags: MoonRemotePlayer.LateUpdate replaces DisplayName with MoonSteamLobby.PlayerName(SteamId)
// whenever that is non-empty, and a demo member's SteamId 0 reads as "Unknown User". So each helper
// gets a made-up SteamId, and PlayerName answers for those ids only (real players are untouched).
const STEAM_IDS: Record<HelperKind, string> = { sweeper: "77700000000000001", hauler: "77700000000000002" };
const helperNames = new Map<string, string>();
let nameHookInstalled = false;

function installNameTags() {
    if (nameHookInstalled) return;
    nameHookInstalled = true;
    const Lobby = moon("MoonSteamLobby");
    Lobby.method<Il2Cpp.String>("PlayerName", 1).implementation = function (id) {
        const name = helperNames.get(String(id));
        if (name) return Il2Cpp.string(name);
        return Lobby.method<Il2Cpp.String>("PlayerName", 1).invoke(id as UInt64);
    };
}

export class HelperBody {
    private constructor(private crew: Il2Cpp.Object, private member: Il2Cpp.Object, private world: Il2Cpp.Object) {}

    static spawn(walker: Il2Cpp.Object, kind: HelperKind, at: Vec3): HelperBody {
        const Demo = moon("MoonDemoCrew");
        const crew = Demo.method<Il2Cpp.Object>("Of").invoke(walker);
        const world = walker.field<Il2Cpp.Object>("world").value;
        const l = LOOKS[kind];
        const look = Demo.method<Il2Cpp.Object>("Look").invoke(l.suit, l.eyes, l.eyeColor);
        const member = crew.method<Il2Cpp.Object>("Add").invoke(
            Il2Cpp.string(NAMES[kind]), look, Il2Cpp.string(TOOLS[kind]),
            vector3(surfacePoint(world, at)), vector3([0, 0, 1]), enumValue(Demo.nested("Act"), "Stand"));
        const body = new HelperBody(crew, member, world);
        installNameTags();
        helperNames.set(STEAM_IDS[kind], NAMES[kind]);
        const remote = body.remote;
        if (!remote.isNull()) {
            remote.method("set_SteamId").invoke(uint64(STEAM_IDS[kind]));
            remote.method("set_DisplayName").invoke(Il2Cpp.string(NAMES[kind]));
        }
        return body;
    }

    private vec(field: string): Vec3 {
        return toVec3(this.member.field<Il2Cpp.ValueType>(field).value);
    }

    private set(field: string, p: Vec3) {
        this.member.field<Il2Cpp.ValueType>(field).value = vector3(p);
    }

    get position(): Vec3 {
        return pointAlong(this.vec("position"), this.vec("to"), this.member.field<number>("travelled").value as number);
    }

    /** Where the game is actually drawing the body (grounded), for checks. */
    get drawnPosition(): Vec3 | null {
        const remote = this.member.field<Il2Cpp.Object>("remote").value;
        if (remote.isNull()) return null;
        return toVec3(remote.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke());
    }

    get remote(): Il2Cpp.Object {
        return this.member.field<Il2Cpp.Object>("remote").value;
    }

    walkTo(target: Vec3, speed: number): void {
        const here = this.position;
        this.set("position", here);
        this.set("to", surfacePoint(this.world, target));
        this.member.field<number>("travelled").value = 0;
        this.member.field<number>("speed").value = speed;
    }

    /** Call every tick: stop at the target instead of patrolling back. */
    update(): void {
        const from = this.vec("position"), to = this.vec("to");
        const d = dist(from, to);
        if (d > 0 && (this.member.field<number>("travelled").value as number) >= d) this.snap(to);
    }

    get arrived(): boolean {
        return dist(this.vec("position"), this.vec("to")) === 0;
    }

    setAct(act: Act): void {
        this.member.field<Il2Cpp.ValueType>("act").value = enumValue(moon("MoonDemoCrew").nested("Act"), act);
    }

    setCarryFill(fraction: number): void {
        this.member.field<number>("capsuleFill").value = Math.max(0, Math.min(1, fraction));
    }

    placeAt(p: Vec3): void {
        const g = surfacePoint(this.world, p);
        this.set("position", g);
        this.set("to", g);
        this.member.field<number>("travelled").value = 0;
    }

    /** Snap to an exact point already on the surface (used on arrival; no re-projection). */
    private snap(p: Vec3): void {
        this.set("position", p);
        this.set("to", p);
        this.member.field<number>("travelled").value = 0;
    }

    destroy(): void {
        const members = this.crew.field<Il2Cpp.Object>("members").value;
        if (!members.isNull()) members.method("Remove").invoke(this.member);
        const remote = this.remote;
        if (!remote.isNull()) destroy(remote.method<Il2Cpp.Object>("get_gameObject").invoke());
    }
}
