/**
 * ILSF sound decoder (`.wav` members of common/sounds/sounds.res).
 *
 * Measured header (confidence: observed on every format-1 member):
 *   0  "ILSF"
 *   4  u16 format      1 = signed 16-bit PCM (format 2 is compressed, unsupported)
 *   6  u16 bits        16
 *   8  u16 channels    1
 *   10 u16 flags       (0x1002 observed; meaning unknown)
 *   12 u32 sample rate (22050 or 44100)
 *   16 u32 frame count
 *   20 PCM samples; file length == 20 + frames * channels * 2 exactly
 *      (e.g. glock_shot_1: 20 + 47158 * 2 = 94336 bytes).
 */

export interface DecodedSound {
  sampleRate: number;
  channels: number;
  /** Interleaved samples scaled to [-1, 1). */
  samples: Float32Array;
}

export function decodeIlsf(buffer: ArrayBuffer): DecodedSound {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 20 || String.fromCharCode(...bytes.subarray(0, 4)) !== "ILSF") {
    throw new Error("ILSF: missing ILSF header");
  }
  const format = view.getUint16(4, true);
  const bits = view.getUint16(6, true);
  const channels = view.getUint16(8, true);
  const sampleRate = view.getUint32(12, true);
  const frames = view.getUint32(16, true);
  if (format !== 1 || bits !== 16) throw new Error(`ILSF: unsupported format ${format}/${bits}-bit`);
  if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 96000) {
    throw new Error(`ILSF: implausible ${channels} channels at ${sampleRate} Hz`);
  }
  const count = frames * channels;
  if (20 + count * 2 !== bytes.length) {
    throw new Error(`ILSF: ${frames} frames do not match the ${bytes.length}-byte file`);
  }
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(20 + i * 2, true) / 32768;
  return { sampleRate, channels, samples };
}
