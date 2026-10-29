import "frida-il2cpp-bridge";
import { autopilotOffer, type AutopilotOffer, type AutopilotStore } from "./autopilot.ts";
import { callDecimal, decimal, enumValue, moon, valueType } from "./unity.ts";
import { LOCAL_PLAYER, dictionaryEntries } from "./world.ts";

// The Autopilot row on the garage's Upgrades page (MoonGarageMenu), one per vehicle model.
//
// The page is the game's own: a strip of models, seven MoonVehicleUpgrades rows, a details panel
// with an action button. The Autopilot row is a copy of the last row ("Upgrade Lights": Glyph, Text,
// Level/Pip x3, Tag/Text, Text) placed under it, with its own click listener. It is NOT added to
// upgradeRows: the game looks every row's kind up in MoonVehicleUpgrades.All and has no eighth.
// While it is picked, Refresh() re-fills the details panel after the game's own refresh and Act()
// (the action button) buys or switches autopilot instead of InstallPicked. Picking a game row hands
// the panel back. Methods taking a System.Decimal (RefreshUpgrades, UpgradeDetails) are never hooked:
// frida-il2cpp-bridge mis-marshals Decimal.

export interface GarageAutopilotDeps {
    store(): AutopilotStore;
    gameKey(): string;
    save(): void;
    error(where: string, e: unknown): void;
}

const ROW_PITCH = 58;                       // MoonGarageMenu.UpgradePitch
const ROW_NAME = "Upgrade Autopilot";
const SUMMARY = "Drives this vehicle by itself whenever nobody is driving it: cleans dust in lanes around " +
    "its garage, and when the hopper is full drives back and empties it into the garage collector.";

let deps: GarageAutopilotDeps | null = null;
let picked = false;                         // the Autopilot row is the selected row
let model = -1;                             // vehicle model shown on the Upgrades page
let row: { go: Il2Cpp.Object; title: Il2Cpp.Object; tagText: Il2Cpp.Object; tag: Il2Cpp.Object; label: Il2Cpp.Object } | null = null;

const core = () => Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
const ui = () => Il2Cpp.domain.assembly("UnityEngine.UI").image;

function setText(t: Il2Cpp.Object, s: string) { if (!t.isNull()) t.method("set_text").invoke(Il2Cpp.string(s)); }

function child(t: Il2Cpp.Object, i: number): Il2Cpp.Object { return t.method<Il2Cpp.Object>("GetChild").invoke(i); }

function component(go: Il2Cpp.Object, klass: Il2Cpp.Class): Il2Cpp.Object {
    return go.method<Il2Cpp.Object>("GetComponent", 1).overload("System.Type").invoke(klass.type.object);
}

function rowAlive(): boolean {
    if (!row) return false;
    try { return !row.go.isNull() && core().class("UnityEngine.Object").method<boolean>("op_Implicit").invoke(row.go); } catch (e) { return false; }
}

/** Copy the last upgrade row under it as the Autopilot row (called after BuildUpgradesPage). */
function buildRow(menu: Il2Cpp.Object) {
    row = null;
    const rows = menu.field<Il2Cpp.Object>("upgradeRows").value;
    const n = rows.method<number>("get_Count").invoke();
    if (n === 0) return;
    const last = rows.method<Il2Cpp.Object>("get_Item").invoke(n - 1);
    const lastLabel = last.field<Il2Cpp.Object>("label").value;
    const lastT = lastLabel.method<Il2Cpp.Object>("get_transform").invoke();
    const Obj = core().class("UnityEngine.Object");
    // Instantiate(Object, Transform parent, bool worldPositionStays): the only non-generic parent overload here.
    const instantiate = Obj.methods.find(m => m.name === "Instantiate" && m.parameterCount === 3 && !m.isGeneric &&
        m.parameters[1].type.name === "UnityEngine.Transform")!;
    const go = instantiate.invoke(lastLabel.method<Il2Cpp.Object>("get_gameObject").invoke(),
        lastT.method<Il2Cpp.Object>("get_parent").invoke(), false) as Il2Cpp.Object;
    go.method("set_name").invoke(Il2Cpp.string(ROW_NAME));
    const t = go.method<Il2Cpp.Object>("get_transform").invoke();
    // Children: 0 Glyph, 1 Text (title), 2 Level (pips), 3 Tag (Text), 4 Text (state, hidden).
    const glyph = component(child(t, 0).method<Il2Cpp.Object>("get_gameObject").invoke(), moon("MoonTreeGlyph"));
    if (!glyph.isNull()) glyph.method("set_Kind").invoke(enumValue(moon("MoonUpgradeTree").nested("Glyph"), "Motor"));
    child(t, 2).method<Il2Cpp.Object>("get_gameObject").invoke().method("SetActive").invoke(false);
    const title = component(child(t, 1).method<Il2Cpp.Object>("get_gameObject").invoke(), Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_Text"));
    const tagText = component(child(child(t, 3), 0).method<Il2Cpp.Object>("get_gameObject").invoke(), Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_Text"));
    setText(title, "Autopilot");
    // Clicks: the copy has the row's Button but not its runtime listener; add ours.
    const Button = ui().class("UnityEngine.UI.Button");
    let button = component(go, Button);
    if (button.isNull()) button = go.method<Il2Cpp.Object>("AddComponent", 1).overload("System.Type").invoke(Button.type.object);
    const UnityAction = core().class("UnityEngine.Events.UnityAction");
    const onClick = button.method<Il2Cpp.Object>("get_onClick").invoke();
    onClick.method("AddListener").invoke(Il2Cpp.delegate(UnityAction, () => { try { pickRow(menu); } catch (e) { /* menu closing */ } }));
    row = { go, title, tagText, tag: child(t, 3), label: component(go, ui().class("UnityEngine.UI.Image")) };
    refreshRow(menu);
}

function world(menu: Il2Cpp.Object): Il2Cpp.Object { return menu.method<Il2Cpp.Object>("get_World").invoke(); }

/** The owned vehicle (its storage id) of the model on show, if Aryan owns one. */
function ownedStorage(menu: Il2Cpp.Object): string | null {
    if (model < 0) return null;
    for (const { key, value } of dictionaryEntries(world(menu).field<Il2Cpp.Object>("ownedVehicles").value)) {
        if (value.field<number>("vehicle").value === model) return (key as unknown as Il2Cpp.String).content ?? null;
    }
    return null;
}

function currentModel(menu: Il2Cpp.Object): number {
    if (model >= 0) return model;
    const strip = menu.field<Il2Cpp.Object>("strip").value;
    if (!strip.isNull() && strip.method<number>("get_Count").invoke() > 0) model = strip.method<Il2Cpp.Object>("get_Item").invoke(0).field<number>("vehicle").value as number;
    return model;
}

function offer(menu: Il2Cpp.Object): { o: AutopilotOffer; storage: string | null } {
    currentModel(menu);
    const storage = ownedStorage(menu);
    const game = deps!.gameKey();
    const w = world(menu);
    const money = callDecimal(w.class.method("WalletDollars"), w, Il2Cpp.string(LOCAL_PLAYER).handle);
    const scale = callDecimal(moon("MoonVehicleUpgrades").method("PriceScale"), null, ptr(model));
    const o = autopilotOffer({
        ownsVehicle: storage !== null, bought: !!storage && deps!.store().owned(game, storage),
        on: !!storage && deps!.store().on(game, storage), priceScale: scale, money,
        inCrewSession: moon("MoonCrew").method<boolean>("get_Joined").invoke(),
    });
    return { o, storage };
}

function refreshRow(menu: Il2Cpp.Object) {
    if (!rowAlive() || !deps) return;
    placeRow(menu);
    const { o } = offer(menu);
    const Kit = moon("MoonWorkshopKit");
    Kit.method("SetTag").invoke(row!.tag, row!.tagText, Il2Cpp.string(o.tag));          // sizes the tag to the text
    Kit.method("MarkTag").invoke(row!.tag, row!.tagText, o.enabled || o.action === "toggle");
    if (!row!.label.isNull()) Kit.method("MarkLabel").invoke(row!.label, row!.title, picked, false);
}

/** One pitch below the lowest row on show (the game lays its rows out after building them). */
function placeRow(menu: Il2Cpp.Object) {
    const rows = menu.field<Il2Cpp.Object>("upgradeRows").value;
    let lowest: Il2Cpp.ValueType | null = null, lowestY = Infinity;
    for (let i = 0; i < rows.method<number>("get_Count").invoke(); i++) {
        const r = rows.method<Il2Cpp.Object>("get_Item").invoke(i);
        if (!(r.field<boolean>("shown").value as boolean)) continue;
        const p = r.field<Il2Cpp.Object>("label").value.method<Il2Cpp.Object>("get_rectTransform").invoke()
            .method<Il2Cpp.ValueType>("get_anchoredPosition").invoke();
        const y = p.field<number>("y").value as number;
        if (y < lowestY) { lowestY = y; lowest = p; }
    }
    if (!lowest) return;
    const at = valueType(core().class("UnityEngine.Vector2"));
    at.field<number>("x").value = lowest.field<number>("x").value as number;
    at.field<number>("y").value = lowestY - ROW_PITCH;
    row!.go.method<Il2Cpp.Object>("get_transform").invoke().method("set_anchoredPosition").invoke(at);
}

/** Fill the right-hand panel for the Autopilot row (after the game's own refresh). */
function fillDetails(menu: Il2Cpp.Object) {
    const { o } = offer(menu);
    setText(menu.field<Il2Cpp.Object>("category").value, "VEHICLE AUTOPILOT");
    setText(menu.field<Il2Cpp.Object>("itemName").value, "Autopilot");
    setText(menu.field<Il2Cpp.Object>("summary").value, SUMMARY);
    const captions = menu.field<Il2Cpp.Array<Il2Cpp.Object>>("statCaptions").value;
    const values = menu.field<Il2Cpp.Array<Il2Cpp.Object>>("statValues").value;
    const stats: [string, string][] = [
        ["STATUS", o.action === "toggle" ? (o.tag === "ON" ? "Installed, on" : "Installed, off") : "Not installed"],
        ["WORKS", "Solo shifts"], ["UNLOADS", "Garage collector"], ["COST", o.action === "toggle" ? "Paid" : o.tag],
    ];
    for (let i = 0; !captions.isNull() && i < Math.min(captions.length, stats.length); i++) {
        setText(captions.get(i), stats[i][0]);
        setText(values.get(i), stats[i][1]);
    }
    menu.method("SetButtons").invoke(Il2Cpp.string(o.button), o.enabled, Il2Cpp.string(""), false);
    setText(menu.field<Il2Cpp.Object>("status").value, o.status);
}

function pickRow(menu: Il2Cpp.Object) {
    picked = true;
    refreshRow(menu);
    fillDetails(menu);
}

/** The action button with the Autopilot row picked: buy it, or switch it on/off. */
function act(menu: Il2Cpp.Object) {
    const { o, storage } = offer(menu);
    const game = deps!.gameKey();
    if (!storage || !game || !o.enabled) { menu.method("ShowStatus").invoke(Il2Cpp.string(o.status || "Not available"), false); return; }
    const store = deps!.store();
    if (o.action === "buy") {
        const w = world(menu);
        w.method("ChargeBuild").invoke(Il2Cpp.string(LOCAL_PLAYER), decimal(-o.price));  // ChargeBuild adds: charge -price
        store.buy(game, storage);
        menu.method("ShowStatus").invoke(Il2Cpp.string(`Autopilot installed (-${o.tag}). It drives itself when you leave it.`), true);
    } else if (o.action === "toggle") {
        const on = !store.on(game, storage);
        store.setOn(game, storage, on);
        menu.method("ShowStatus").invoke(Il2Cpp.string(on ? "Autopilot on." : "Autopilot off: it stays parked."), true);
    }
    deps!.save();
    refreshRow(menu);
    fillDetails(menu);
}

export function installGarageAutopilot(d: GarageAutopilotDeps): void {
    deps = d;
    const Menu = moon("MoonGarageMenu");
    Menu.method("BuildUpgradesPage").implementation = function (floor) {
        const self = this as Il2Cpp.Object;
        self.method("BuildUpgradesPage").invoke(floor as Il2Cpp.Object);
        picked = false;
        try { buildRow(self); } catch (e) { row = null; deps?.error("garage row", (e as Error)?.stack ?? e); }
    };
    Menu.method("PickModel").implementation = function (vehicle) {
        const self = this as Il2Cpp.Object;
        self.method("PickModel").invoke(vehicle as number);
        model = vehicle as number;
        try { refreshRow(self); if (picked) fillDetails(self); } catch (e) { /* row gone */ }
    };
    for (const name of ["ClickUpgrade", "PickUpgrade"]) {
        Menu.method(name).implementation = function (r) {
            picked = false;
            const self = this as Il2Cpp.Object;
            self.method(name).invoke(r as Il2Cpp.Object);
            try { refreshRow(self); } catch (e) { /* row gone */ }
        };
    }
    Menu.method("Refresh").implementation = function () {
        const self = this as Il2Cpp.Object;
        self.method("Refresh").invoke();
        try {
            if (!rowAlive()) return;
            refreshRow(self);
            if (picked && String(self.field("page").value) === "Upgrades") fillDetails(self);
        } catch (e) { /* keep the game's panel */ }
    };
    Menu.method("Act").implementation = function () {
        const self = this as Il2Cpp.Object;
        if (picked && rowAlive() && String(self.field("page").value) === "Upgrades") {
            try { act(self); } catch (e) { self.method("ShowStatus").invoke(Il2Cpp.string(`Autopilot: ${e}`), false); }
            return;
        }
        self.method("Act").invoke();
    };
}
