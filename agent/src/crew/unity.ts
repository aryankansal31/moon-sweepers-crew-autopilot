import "frida-il2cpp-bridge";
import type { Vec3 } from "./vec.ts";

// IL2CPP value helpers shared by the crew adapters. Call only inside Il2Cpp.perform, on the main thread.

export const game = () => Il2Cpp.domain.assembly("Assembly-CSharp").image;
export const moon = (name: string) => game().class(`MoonCleaners.${name}`);
const core = () => Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;

export function toVec3(v: Il2Cpp.ValueType): Vec3 {
    return [v.field<number>("x").value as number, v.field<number>("y").value as number, v.field<number>("z").value as number];
}

/** A fresh UnityEngine.Vector3 holding p (boxed then unboxed, so it owns its memory). */
/**
 * A zeroed value type in Frida-owned memory. Never `klass.alloc().unbox()`: that boxes it on the
 * game's GC heap with nothing managed referencing the box, so the GC can free it while we still
 * use it (the crew window crashed with access violations that way).
 */
export function valueType(klass: Il2Cpp.Class): Il2Cpp.ValueType {
    const size = klass.valueTypeSize;
    const p = Memory.alloc(size);
    p.writeByteArray(new Array(size).fill(0));
    return new Il2Cpp.ValueType(p, klass.type);
}

export function vector3(p: Vec3): Il2Cpp.ValueType {
    const v = valueType(core().class("UnityEngine.Vector3"));
    v.field<number>("x").value = p[0];
    v.field<number>("y").value = p[1];
    v.field<number>("z").value = p[2];
    return v;
}

/**
 * The terrain point under p (MoonWorld.SurfaceAt along p's direction from the moon's centre).
 * Helpers walk on terrain only: MoonDemoCrew.Ground can't see station floors (a player standing
 * in a station is ~7 m above SurfaceAt there), so a body sent indoors would be drawn under it.
 */
export function surfacePoint(world: Il2Cpp.Object, p: Vec3): Vec3 {
    const r = Math.hypot(p[0], p[1], p[2]);
    const up = Memory.alloc(12), onStructure = Memory.alloc(4);
    return toVec3(world.method<Il2Cpp.ValueType>("SurfaceAt").invoke(vector3([p[0] / r, p[1] / r, p[2] / r]), up, onStructure));
}

export function positionOf(component: Il2Cpp.Object): Vec3 {
    return toVec3(component.method<Il2Cpp.Object>("get_transform").invoke().method<Il2Cpp.ValueType>("get_position").invoke());
}

/** The value of a static enum member, e.g. enumValue(moon("MoonDemoCrew").nested("Act"), "Walk"). */
export function enumValue(klass: Il2Cpp.Class, member: string): Il2Cpp.ValueType {
    return klass.field<Il2Cpp.ValueType>(member).value;
}

// --- System.Decimal ---------------------------------------------------------------------------
// frida-il2cpp-bridge 0.14 mis-marshals methods that *return* a Decimal (a 16-byte struct the
// generated code returns through a hidden pointer): Decimal(1.0) came back reading 7, Decimal(10)
// as 1.8e12. So Decimals are read and written as bytes here, and Decimal-returning methods are
// called through NativeFunction with the hidden return buffer passed explicitly.
// Layout (.NET Core): int flags (bit 31 = sign, bits 16-23 = scale), uint hi32, ulong lo64.

const DECIMAL_SCALE = 6;  // write with micro-dollar precision

export function readDecimal(p: NativePointer): number {
    const flags = p.readU32();
    const hi = p.add(4).readU32();
    const lo = p.add(8).readU64();
    const scale = (flags >>> 16) & 0xff;
    const magnitude = (hi * 2 ** 64 + Number(lo.toString())) / 10 ** scale;
    return (flags & 0x80000000) !== 0 ? -magnitude : magnitude;
}

export function writeDecimal(p: NativePointer, value: number): void {
    const units = Math.round(Math.abs(value) * 10 ** DECIMAL_SCALE);
    p.writeU32(((value < 0 ? 0x80000000 : 0) | (DECIMAL_SCALE << 16)) >>> 0);
    p.add(4).writeU32(Math.floor(units / 2 ** 64));
    p.add(8).writeU64(uint64(String(units % 2 ** 64)));
}

/** A Decimal value type holding `value`, for passing to game methods. */
export function decimal(value: number): Il2Cpp.ValueType {
    const v = valueType(Il2Cpp.corlib.class("System.Decimal"));
    writeDecimal(v.handle, value);
    return v;
}

export function decimalValue(v: Il2Cpp.ValueType): number {
    return readDecimal(v.handle);
}

/**
 * Call a game method that returns a Decimal and read the result.
 * x64 IL2CPP ABI: (Decimal* ret, [this], args..., MethodInfo*). Pointer args only (objects,
 * strings, value-type pointers); pass doubles with `{ double: x }`.
 */
export function callDecimal(method: Il2Cpp.Method, self: Il2Cpp.Object | null,
                            ...args: (NativePointer | { double: number })[]): number {
    const types: NativeFunctionArgumentType[] = ["pointer"];
    const values: NativeFunctionArgumentValue[] = [];
    const ret = Memory.alloc(16);
    values.push(ret);
    if (!method.isStatic) { types.push("pointer"); values.push(self!.handle); }
    for (const a of args) {
        if (a instanceof NativePointer) { types.push("pointer"); values.push(a); }
        else { types.push("double"); values.push(a.double); }
    }
    types.push("pointer");
    values.push(method.handle);
    const fn = new NativeFunction(method.virtualAddress, "pointer", types);
    (fn as (...v: NativeFunctionArgumentValue[]) => NativePointer)(...values);
    return readDecimal(ret);
}

export function destroy(obj: Il2Cpp.Object) {
    core().class("UnityEngine.Object").method("Destroy", 1).invoke(obj);
}
