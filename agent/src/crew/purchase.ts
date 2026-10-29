// Can the player afford a helper? Pure. Money arrives as a double converted from the game's
// System.Decimal, so differences under half a cent are treated as equal.

const HALF_CENT = 0.005;

export function canBuy(money: number, price: number, inCrewSession = false): { ok: boolean; reason?: string } {
    // Helpers only work in solo shifts; in a crew session the charge would hit the team wallet.
    if (inCrewSession) return { ok: false, reason: "Crew helpers work in solo shifts only" };
    if (money + HALF_CENT >= price) return { ok: true };
    return { ok: false, reason: `Not enough money: $${price} needed` };
}
