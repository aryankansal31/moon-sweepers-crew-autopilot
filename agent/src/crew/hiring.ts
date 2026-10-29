import "frida-il2cpp-bridge";
import { PRICES, type HelperKind, type HireStore } from "./hires.ts";
import { canBuy } from "./purchase.ts";
import { callDecimal, decimal, moon } from "./unity.ts";
import { LOCAL_PLAYER } from "./world.ts";

// Hiring a helper with in-game money. Requests come from the trainer panel (crew-request.json);
// the game's own card shop (MoonUpgradeShop) is not used: in normal play it only opens at a
// Prototype Station and never lists concept cards outside prototype testing.
//
// Money: MoonWorld.ChargeBuild(player, amount) *adds* amount to the wallet (it is the build-money
// credit path, also used for refunds), so a purchase charges -price through it.

export interface HireDeps {
    store(): HireStore;
    gameKey(): string;
    onHire(kind: HelperKind): void;
}

export const HELPER_SHORT: Record<HelperKind, string> = { sweeper: "Dusty", hauler: "Hank" };

/** Hire `kind` for the current game if affordable and solo. Returns the message for the player. */
export function hireHelper(world: Il2Cpp.Object, kind: HelperKind, deps: HireDeps): string {
    const key = deps.gameKey();
    if (!key) return "Start a shift first";
    if (deps.store().hired(key).includes(kind)) return `${HELPER_SHORT[kind]} is already part of your crew`;
    const local = Il2Cpp.string(LOCAL_PLAYER);
    const money = callDecimal(world.class.method("WalletDollars"), world, local.handle);
    const price = PRICES[kind];
    const ok = canBuy(money, price, moon("MoonCrew").method<boolean>("get_Joined").invoke());
    if (!ok.ok) return ok.reason!;
    world.method("ChargeBuild").invoke(local, decimal(-price));
    deps.store().hire(key, kind);
    deps.onHire(kind);
    return `${HELPER_SHORT[kind]} has joined your crew (-$${price})`;
}
