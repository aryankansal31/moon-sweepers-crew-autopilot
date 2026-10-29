// Small vector helpers for crew logic. Pure; world space is centred on the moon (unrotated).

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 =>
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** v with its component along the surface normal at p removed (the moon is centred at the origin). */
export function tangent(p: Vec3, v: Vec3): Vec3 {
    const up = norm(p);
    return sub(v, scale(up, dot(v, up)));
}

export function norm(a: Vec3): Vec3 {
    const l = len(a);
    return l === 0 ? [0, 0, 0] : scale(a, 1 / l);
}

/** Great-circle distance between the directions of a and b on a sphere of the given radius. */
export function arcDistance(a: Vec3, b: Vec3, radius: number): number {
    const c = Math.max(-1, Math.min(1, dot(norm(a), norm(b))));
    return Math.acos(c) * radius;
}

/** Where a demo-crew member is after `travelled` metres from `from` toward `to` (clamped at `to`). */
export function pointAlong(from: Vec3, to: Vec3, travelled: number): Vec3 {
    const d = dist(from, to);
    if (d === 0) return [from[0], from[1], from[2]];
    return add(from, scale(sub(to, from), Math.min(1, travelled / d)));
}
