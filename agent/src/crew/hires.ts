// Who is hired, per game. Pure logic (no Frida), persisted as crew.json next to moon_trainer.py.

export type HelperKind = "sweeper" | "hauler";

export const PRICES: Record<HelperKind, number> = { sweeper: 450, hauler: 350 };

const KINDS: HelperKind[] = ["sweeper", "hauler"];

/**
 * A hire the panel asked for (crew-request.json: {"id": ..., "hire": kind}), or null if the text
 * isn't a valid request or `lastId` was already handled. The panel writes a fresh id per click.
 */
export function parseHireRequest(text: string | null, lastId: string): { id: string; kind: HelperKind } | null {
    if (!text) return null;
    try {
        const d = JSON.parse(text);
        if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id || d.id === lastId) return null;
        return KINDS.includes(d.hire) ? { id: d.id, kind: d.hire } : null;
    } catch {
        return null;
    }
}

// A slot's play time can step back slightly between reads (summary written mid-session);
// anything bigger means a different game now lives in the slot.
const NEW_GAME_DROP_SECONDS = 60;
// Play time is recorded in steps this big, so crew.json isn't rewritten on every half-second poll
// (that raced the panel's reads). Must stay well under NEW_GAME_DROP_SECONDS.
const RECORD_STEP_SECONDS = 30;

interface GameRecord { hired: HelperKind[]; hiredAt: Partial<Record<HelperKind, string>> }
interface SlotRecord { id: string; maxPlaySeconds: number }
interface Data {
    games: Record<string, GameRecord>;
    paused: Partial<Record<HelperKind, boolean>>;
    slots: Record<string, SlotRecord>;
}

/** crew.json as data; null when the text can't be read as a crew file (half-written, corrupt). */
function parseStrict(json: string | null): Data | null {
    if (!json) return { games: {}, paused: {}, slots: {} };
    try {
        const d = JSON.parse(json);
        if (!d || typeof d !== "object" || Array.isArray(d)) return null;
        return { games: d.games ?? {}, paused: d.paused ?? {}, slots: d.slots ?? {} };
    } catch {
        return null;
    }
}

export class HireStore {
    private data: Data;

    constructor(json: string | null) {
        this.data = parseStrict(json) ?? { games: {}, paused: {}, slots: {} };
    }

    /** A store from crew.json text, or null if the text is unreadable (never treat that as "no hires"). */
    static parse(json: string | null): HireStore | null {
        return parseStrict(json) ? new HireStore(json) : null;
    }

    /** Take the pause flags from crew.json as the panel wrote it; hires and slots stay ours. */
    adoptPaused(json: string): void {
        const d = parseStrict(json);
        if (d) this.data.paused = { ...d.paused };
    }

    hired(gameKey: string): HelperKind[] {
        return [...(this.data.games[gameKey]?.hired ?? [])].filter(k => KINDS.includes(k));
    }

    hire(gameKey: string, kind: HelperKind): void {
        const g = this.data.games[gameKey] ??= { hired: [], hiredAt: {} };
        if (g.hired.includes(kind)) return;
        g.hired.push(kind);
        g.hiredAt[kind] = new Date().toISOString();
    }

    paused(kind: HelperKind): boolean {
        return this.data.paused[kind] === true;
    }

    setPaused(kind: HelperKind, on: boolean): void {
        this.data.paused[kind] = on;
    }

    /**
     * The key for the game now in `slot`: stable while its play time grows, new when it drops.
     * playSeconds null (the slot summary couldn't be read) keeps the slot's current game, or "" if
     * it has none yet; it never starts a new game.
     */
    identify(slot: number, playSeconds: number | null, makeId: () => string): string {
        const name = String(slot);
        let rec = this.data.slots[name];
        if (playSeconds === null) return rec ? `slot${name}/${rec.id}` : "";
        if (!rec || playSeconds + NEW_GAME_DROP_SECONDS < rec.maxPlaySeconds) {
            rec = this.data.slots[name] = { id: makeId(), maxPlaySeconds: playSeconds };
        } else if (playSeconds >= rec.maxPlaySeconds + RECORD_STEP_SECONDS) {
            rec.maxPlaySeconds = playSeconds;
        }
        return `slot${name}/${rec.id}`;
    }

    toJSON(): string {
        return JSON.stringify(this.data, null, 2);
    }
}
