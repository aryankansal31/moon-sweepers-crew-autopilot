// Where a helper empties its load. Pure. Aryan's choice (2026-10-28): dust goes into a packaging
// machine (MoonWorld packager, depot kind 10) instead of being sold at a dust station. A station is
// used only when no packager has been built, so a helper never ends up holding dust it can't drop.

import { dist, type Vec3 } from "./vec.ts";

export interface PackagerSpot { id: number; pos: Vec3; roomKg: number }
export type UnloadTarget = { kind: "packager"; id: number; pos: Vec3 } | { kind: "station"; pos: Vec3 } | null;

const MIN_ROOM_KG = 1;   // a packager with less room than this counts as full

export function chooseUnload(pos: Vec3, packagers: PackagerSpot[], station: Vec3 | null): UnloadTarget {
    if (packagers.length) {
        const open = packagers.filter(p => p.roomKg >= MIN_ROOM_KG);
        const pick = (open.length ? open : packagers).reduce((a, b) => (dist(pos, b.pos) < dist(pos, a.pos) ? b : a));
        return { kind: "packager", id: pick.id, pos: pick.pos };
    }
    return station ? { kind: "station", pos: station } : null;
}
