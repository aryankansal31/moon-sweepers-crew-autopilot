// The Hauler's choice of what to do next. Pure: the crew manager describes what's lying around,
// this picks one job, and the manager walks the body there and moves the dust.
//
// Order (design doc): a robot dock that is completely full (its outflow isn't keeping up), then a
// parked vehicle's hopper, then loose dust canisters, then deposit what's carried, then sell a tray.
// Machine storage (MoonWorld.MachineStorage) and docks that aren't full are never touched, so
// production lines are never starved.

import { dist, type Vec3 } from "./vec.ts";

export const HAULER_CAP_KG = 200;

export type HaulJob =
    | { kind: "dock"; id: string; pos: Vec3 }
    | { kind: "vehicle"; id: string; pos: Vec3 }
    | { kind: "canister"; id: number; pos: Vec3 }
    | { kind: "deposit"; pos: Vec3 }
    | { kind: "sell"; intakeId: string; pos: Vec3 };

export interface HaulWorld {
    docks: { id: string; pos: Vec3; full: boolean; machine: boolean }[];
    vehicles: { id: string; pos: Vec3; kg: number; driven: boolean; machine: boolean }[];
    canisters: { id: number; pos: Vec3; kg: number }[];
    carriedKg: number;
    capKg: number;
    stationPos: Vec3 | null;
    sellable: { intakeId: string; pos: Vec3 }[];
}

function nearest<T extends { pos: Vec3 }>(items: T[], from: Vec3): T | null {
    let best: T | null = null, bestD = Infinity;
    for (const it of items) {
        const d = dist(it.pos, from);
        if (d < bestD) { bestD = d; best = it; }
    }
    return best;
}

export function nextJob(w: HaulWorld, from: Vec3): HaulJob | null {
    const deposit: HaulJob | null = w.stationPos ? { kind: "deposit", pos: w.stationPos } : null;
    if (w.carriedKg >= w.capKg) return deposit;

    const dock = nearest(w.docks.filter(d => d.full && !d.machine), from);
    if (dock) return { kind: "dock", id: dock.id, pos: dock.pos };
    const vehicle = nearest(w.vehicles.filter(v => !v.driven && !v.machine && v.kg > 0), from);
    if (vehicle) return { kind: "vehicle", id: vehicle.id, pos: vehicle.pos };
    const canister = nearest(w.canisters.filter(c => c.kg > 0), from);
    if (canister) return { kind: "canister", id: canister.id, pos: canister.pos };

    if (w.carriedKg > 0 && deposit) return deposit;
    const sell = nearest(w.sellable, from);
    if (sell) return { kind: "sell", intakeId: sell.intakeId, pos: sell.pos };
    return null;
}
