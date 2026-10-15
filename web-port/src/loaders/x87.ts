/**
 * igi.exe's x87 FPU state, emulated (docs/gameplay.md "FPU rounding mode").
 *
 * Recovered from igi.exe:
 * - FUN_004966d0 (0x4966d0) does `fstcw [0x68b8dc]; or word [0x68b8dc],
 *   0xC00; fldcw [0x68b8dc]`: rounding control = 11b, chop (truncate toward
 *   zero). WinMain calls it at 0x48db81, and at the top of every message-loop
 *   pass (0x48dbc1) it first checks that `fld -1.75; fistp` gives -1 (else
 *   "Invalid FPU rounding mode. May be caused by running a debug session with
 *   ftol optimize turned on.", string 0x53fc88, and a hang at 0x48dcb8), then
 *   calls FUN_004966d0 again (0x48dbe9). 0x4909ec and 0x4925c3 re-apply it
 *   after the DirectDraw/Direct3D set-up.
 * - DirectDraw is opened with DDSCL_FPUPRESERVE (SetCooperativeLevel flags
 *   0x1008 / 0x1011 at 0x491f72 / 0x492216), so Direct3D never leaves the FPU
 *   changed. Precision control keeps the Windows default (53-bit; the CRT
 *   compares against the default word 0x27F at 0x4a04be): game code runs
 *   with control word 0xE7F.
 * - The game was built with inline conversions ("ftol optimize"): every
 *   (int) cast is `fistp QWORD` followed by a read of the low dword (684
 *   sites; no __ftol). FLOOR/CEIL appear only where the code calls the CRT
 *   floor (0x49c4be) / ceil (0x49caf0), which set their own rounding mode.
 *
 * Consequences reproduced here:
 * - float -> int truncates toward zero; the int is the low 32 bits of the
 *   64-bit result (x87Fistp);
 * - every x87 add / sub / mul / div rounds its 53-bit result toward zero
 *   (x87Add, x87Sub, x87Mul, x87Div);
 * - every store to a float32 (FSTP DWORD, also int -> float32 via FILD/FSTP)
 *   truncates the mantissa (x87StoreF32), so a float32 op result is the exact
 *   result chopped to float32 (x87F32Add ... x87F32Div).
 * The chop arithmetic matters only when the exact result is an integer (or a
 * float32) that the FPU reaches inexactly, e.g. 60 / 50 rpm x 30 = 36 exactly,
 * but chop(chop(60 / 50) x 30) = 35.99999999999999 -> 35 ticks.
 */

const F64 = new Float64Array(1);
const F64_WORDS = new Uint32Array(F64.buffer);
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const LO = LITTLE_ENDIAN ? 0 : 1;
const HI = 1 - LO;
const F32 = new Float32Array(1);
const F32_BITS = new Uint32Array(F32.buffer);
/** 2^63: FISTP QWORD stores the integer indefinite (0x8000000000000000, low dword 0) at or beyond it. */
const INT64_LIMIT = 9223372036854775808;
/** Dekker split constant 2^27 + 1. */
const SPLIT = 134217729;

/**
 * FISTP QWORD in chop mode, then the low dword (what every igi.exe (int) cast
 * reads): truncation toward zero, wrapped to int32. NaN, +-Infinity and
 * |x| >= 2^63 give the integer indefinite, whose low dword is 0. Never -0.
 */
export function x87Fistp(x: number): number {
  // ToInt32 truncates toward zero and keeps the low 32 bits of any finite double.
  return Math.abs(x) < INT64_LIMIT ? x | 0 : 0;
}

/** The double next to x toward zero (x finite, non-zero). */
function towardZero64(x: number): number {
  F64[0] = x;
  if (F64_WORDS[LO] === 0) {
    F64_WORDS[LO] = 0xffffffff;
    F64_WORDS[HI] -= 1;
  } else {
    F64_WORDS[LO] -= 1;
  }
  return F64[0];
}

/** The float32 next to f (a float32 value, non-zero) toward zero; +-Infinity becomes +-FLT_MAX. */
function towardZero32(f: number): number {
  F32[0] = f;
  F32_BITS[0] -= 1;
  return F32[0];
}

/** Exact a*b - p for p = a*b rounded to nearest (Dekker; no overflow / underflow). */
function productError(a: number, b: number, p: number): number {
  let t = SPLIT * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b);
  const bl = b - bh;
  return ((ah * bh - p) + ah * bl + al * bh) + al * bl;
}

/** Round-to-nearest result r of an op whose exact value is r + err -> the chopped double. */
function chop64(r: number, err: number): number {
  return err !== 0 && r !== 0 && Number.isFinite(r) && (err < 0) !== (r < 0) ? towardZero64(r) : r;
}

/** x87 FADD in chop mode (53-bit precision). */
export function x87Add(a: number, b: number): number {
  const s = a + b;
  if (!Number.isFinite(s)) return s;
  const bb = s - a;
  return chop64(s, (a - (s - bb)) + (b - bb));
}

/** x87 FSUB in chop mode (53-bit precision). */
export function x87Sub(a: number, b: number): number {
  return x87Add(a, -b);
}

/** x87 FMUL in chop mode (53-bit precision). */
export function x87Mul(a: number, b: number): number {
  const p = a * b;
  if (p === 0 || !Number.isFinite(p)) return p;
  return chop64(p, productError(a, b, p));
}

/** x87 FDIV in chop mode (53-bit precision). */
export function x87Div(a: number, b: number): number {
  const q = a / b;
  if (q === 0 || !Number.isFinite(q) || !Number.isFinite(b)) return q;
  const p = q * b;
  // a - q*b exactly: a - p is exact (Sterbenz), the product error is exact.
  const r = (a - p) - productError(q, b, p);
  if (r === 0) return q;
  // Exact quotient = q + r/b: q is too large in magnitude when r/b opposes q.
  return ((r < 0) !== (b < 0)) !== (q < 0) ? towardZero64(q) : q;
}

/**
 * FSTP DWORD in chop mode: the float32 nearest x toward zero (x taken as the
 * exact value; overflow gives +-FLT_MAX, as the masked overflow does in chop
 * mode). Also int -> float32 (FILD + FSTP DWORD).
 */
export function x87StoreF32(x: number): number {
  const f = Math.fround(x);
  if (!Number.isFinite(x) || f === x) return f;
  return Math.abs(f) > Math.abs(x) ? towardZero32(f) : f;
}

/** FSTP DWORD of a value known exactly as hi + lo (|lo| <= ulp(hi) / 2). */
function storeF32Exact(hi: number, lo: number): number {
  if (lo === 0 || hi === 0 || !Number.isFinite(hi)) return x87StoreF32(hi);
  const f = Math.fround(hi);
  // sign(f - (hi + lo)); f - hi is exact (f and hi are within one float32 step).
  const t = (f - hi) - lo;
  return t !== 0 && (t > 0) === (hi > 0) ? towardZero32(f) : f;
}

/** float32 + float32 stored as float32 (fld; fadd DWORD; fstp DWORD in chop mode). */
export function x87F32Add(x: number, y: number): number {
  const s = x + y;
  if (!Number.isFinite(s)) return x87StoreF32(s);
  const bb = s - x;
  return storeF32Exact(s, (x - (s - bb)) + (y - bb));
}

/** float32 - float32 stored as float32. */
export function x87F32Sub(x: number, y: number): number {
  return x87F32Add(x, -y);
}

/** float32 x float32 stored as float32 (the double product of two float32 values is exact). */
export function x87F32Mul(x: number, y: number): number {
  return x87StoreF32(x * y);
}

/** float32 / float32 stored as float32. */
export function x87F32Div(x: number, y: number): number {
  const q = x / y;
  if (q === 0 || !Number.isFinite(q)) return Math.fround(q);
  let f = Math.fround(q);
  // f*y is exact (24 x 24 bits); |f| > |x/y| exactly when |f*y| > |x|.
  if (!Number.isFinite(f) || Math.abs(f * y) > Math.abs(x)) f = towardZero32(f);
  return f;
}
