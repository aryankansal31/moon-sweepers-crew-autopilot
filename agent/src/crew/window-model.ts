// What the in-game crew window says. Pure (no Frida); window.ts draws it with the game's own UI kit.
import { PRICES, type HelperKind } from "./hires.ts";
import { canBuy } from "./purchase.ts";

export interface CrewCard {
    kind: HelperKind;
    key: string;          // press this key to hire
    name: string;
    role: string;
    tag: string;          // "$450" or "HIRED"
    canHire: boolean;
}

export interface CrewWindowModel {
    title: string;
    balance: string;
    cards: CrewCard[];
    note: string;
}

const CARDS: { kind: HelperKind; key: string; name: string; role: string }[] = [
    { kind: "sweeper", key: "1", name: "Dusty the Sweeper",
      role: "Cleans dust around you, fills a 150 kg hopper and empties it into your packaging machine." },
    { kind: "hauler", key: "2", name: "Hank the Hauler",
      role: "Empties full robot docks and parked vehicles, carries up to 200 kg to your packaging machine." },
];

const HINT = "Press a number to hire. Paid once, from your in-game money.";

export function crewWindowModel(s: { hired: HelperKind[]; money: number; inCrewSession: boolean; message: string }): CrewWindowModel {
    const cards = CARDS.map(c => {
        const hired = s.hired.includes(c.kind);
        return { ...c, tag: hired ? "HIRED" : `$${PRICES[c.kind]}`, canHire: !hired && canBuy(s.money, PRICES[c.kind], s.inCrewSession).ok };
    });
    const note = s.message || (s.inCrewSession ? "Crew helpers work in solo shifts only" : HINT);
    // Grouped by hand: Frida's JS runtime has no Intl, so toLocaleString adds no separators there.
    // +half a cent: money arrives from System.Decimal as e.g. 499.9999998 for $500.00.
    const dollars = String(Math.floor(s.money + 0.005)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return { title: "CREW", balance: `$${dollars}`, cards, note };
}
