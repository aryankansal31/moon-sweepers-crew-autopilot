import "frida-il2cpp-bridge";
import { moon, valueType } from "./unity.ts";
import type { CrewWindowModel } from "./window-model.ts";

// The in-game crew window (F11), drawn with the game's own UI kit, MoonWorkshopKit: the same plates,
// fonts (Baloo 2 / Nunito), keycaps and colours as the supply wall and garage screens. It is a
// keyboard window: keys 1/2 hire, F11 closes (the trainer handles the keys; see trainer.ts). It is
// rebuilt whenever its model changes, which only happens on open, a hire, or a money change.
//
// Kit coordinates are in a 1920x1080 frame, x/y from the parent's top-left (checked in the sandbox).

const ROOT_NAME = "CrewWindow";
const PLATE = { x: 460, y: 120, w: 1000, h: 660 };

const core = () => Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;

function color(hex: string): Il2Cpp.ValueType {
    const c = valueType(core().class("UnityEngine.Color"));
    const n = parseInt(hex.slice(1), 16);
    c.field<number>("r").value = ((n >> 16) & 255) / 255;
    c.field<number>("g").value = ((n >> 8) & 255) / 255;
    c.field<number>("b").value = (n & 255) / 255;
    c.field<number>("a").value = 1;
    return c;
}

const CREAM = "#FFF4DE", MUTED = "#8F99A6", ORANGE = "#F26A1B", CYAN = "#46E0F0", GREEN = "#7FE0A0", RED = "#FF7A6B";

function align(name: string): Il2Cpp.ValueType {
    return Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TextAlignmentOptions").field<Il2Cpp.ValueType>(name).value;
}

function vector2(x: number, y: number): Il2Cpp.ValueType {
    const v = valueType(core().class("UnityEngine.Vector2"));
    v.field<number>("x").value = x;
    v.field<number>("y").value = y;
    return v;
}

/** Anchor a RectTransform at its parent's centre, keeping its size. */
function centre(rect: Il2Cpp.Object) {
    const mid = vector2(0.5, 0.5);
    rect.method("set_anchorMin").invoke(mid);
    rect.method("set_anchorMax").invoke(mid);
    rect.method("set_pivot").invoke(mid);
    rect.method("set_anchoredPosition").invoke(vector2(0, 0));
}

// The window is found again by a unique GameObject name, never through a kept MoonWorkshopKit:
// nothing managed references the kit after build(), so the GC can free it, and reading its root
// later returned garbage (closing failed silently and every redraw stacked another window).
let builds = 0;

export class CrewWindow {
    private rootName: string | null = null;
    private shown = "";

    get isOpen(): boolean {
        return this.rootName !== null;
    }

    /** Draw `model`, rebuilding only when it changed since the last draw. */
    show(model: CrewWindowModel): void {
        const key = JSON.stringify(model);
        if (this.rootName && key === this.shown) return;
        this.close();
        this.build(model);
        this.shown = key;
    }

    close(): void {
        if (!this.rootName) return;
        const name = this.rootName;
        this.rootName = null;
        this.shown = "";
        const go = core().class("UnityEngine.GameObject").method<Il2Cpp.Object>("Find").invoke(Il2Cpp.string(name));
        if (!go.isNull()) core().class("UnityEngine.Object").method("Destroy", 1).invoke(go);
    }

    private build(m: CrewWindowModel): void {
        // The kit only lives for this call (no GC handle: the bridge's GCHandle.free crashes here).
        const kit = moon("MoonWorkshopKit").alloc();
        kit.method(".ctor").invoke();
        this.draw(kit, m);
    }

    private draw(kit: Il2Cpp.Object, m: CrewWindowModel): void {
        const rootName = `${ROOT_NAME}#${++builds}`;
        const head = kit.field<Il2Cpp.Object>("head").value;
        const body = kit.field<Il2Cpp.Object>("text").value;
        const caps = kit.field<Il2Cpp.Object>("caps").value;
        const stage = kit.method<Il2Cpp.Object>("Stage").invoke(NULL as unknown as Il2Cpp.Object, Il2Cpp.string(rootName), 400, true);
        this.rootName = rootName;  // set before the rest, so a failed build can still be closed
        // Parent to the stage's root canvas (full screen); the kit's 1920x1080 "Frame" isn't screen-centred.
        const root = kit.field<Il2Cpp.Object>("root").value;
        const parent = root.isNull() ? stage : root.method<Il2Cpp.Object>("get_transform").invoke();
        const plate = kit.method<Il2Cpp.Object>("Plate").invoke(parent, Il2Cpp.string("CrewPlate"),
            PLATE.x, PLATE.y, PLATE.w, PLATE.h, true, true);
        centre(plate);  // the frame's anchoring shifts fixed x/y with the screen's shape
        const text = (value: string, x: number, y: number, w: number, h: number, size: number, hex: string, face: Il2Cpp.Object, how = "Left") =>
            kit.method("Text").invoke(plate, Il2Cpp.string(value), x, y, w, h, size, color(hex), face, align(how));

        text(m.title, 48, 34, 500, 80, 52, CREAM, body);
        text(`BALANCE  ${m.balance}`, 500, 60, 452, 50, 30, CYAN, caps, "Right");

        m.cards.forEach((c, i) => {
            const y = 140 + i * 190;
            kit.method("Socket").invoke(plate, 40, y, PLATE.w - 80, 170);
            kit.method("Keycap").invoke(plate, Il2Cpp.string(c.key), 72, y + 64, 56);
            text(c.name, 160, y + 18, 560, 60, 38, CREAM, caps);
            text(c.role, 160, y + 78, 600, 80, 24, MUTED, body);
            text(c.tag, 740, y + 30, 180, 60, 40, c.tag === "HIRED" ? GREEN : c.canHire ? ORANGE : RED, caps, "Right");
            if (c.tag !== "HIRED" && !c.canHire) text("NOT ENOUGH MONEY", 640, y + 96, 280, 40, 20, RED, caps, "Right");
        });

        text(m.note, 48, 530, 904, 50, 26, CREAM, body);
        kit.method("Keycap").invoke(plate, Il2Cpp.string("F11"), 800, 590, 44);
        text("CLOSE", 870, 590, 100, 44, 24, MUTED, caps);
    }
}
