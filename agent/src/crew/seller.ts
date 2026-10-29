// One seller for everyone who presses an intake's sell button: the Sweeper, the Hauler and the
// trainer's auto-sell. Pure logic; the trainer adapts MoonDepositIntake to the Intake interface.

export interface Intake {
    id: string;
    selling(): boolean;
    canSell(): boolean;
    trayKg(): number;
    press(): boolean;
}

// MoonDepositIntake.Press starts a sale, but get_Selling only turns true a few frames later, so
// the same intake is left alone for this long after a press.
export const REPRESS_GUARD_MS = 3000;

export class Seller {
    private lastPress = new Map<string, number>();

    trySell(intake: Intake, nowMs: number): boolean {
        const last = this.lastPress.get(intake.id);
        if (last !== undefined && nowMs - last <= REPRESS_GUARD_MS) return false;
        if (intake.trayKg() <= 0 || !intake.canSell() || intake.selling()) return false;
        if (!intake.press()) return false;
        this.lastPress.set(intake.id, nowMs);
        return true;
    }
}

export const seller = new Seller();
