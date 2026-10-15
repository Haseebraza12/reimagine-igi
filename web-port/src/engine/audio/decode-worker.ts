/**
 * Module worker: decodes ILSF sample files (PCM / IMA ADPCM, loaders/audio.ts)
 * off the main thread for igi-audio.ts. Messages:
 *   { ping: true }                   -> { pong: true }
 *   { id, buffer: ArrayBuffer }      -> { id, ok, format, sampleRate, channels, frames, samples }
 * The decoded channel arrays are transferred back (zero copy).
 */
import { decodeIlsfAny } from "../../loaders/audio";

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent) => {
  const msg = event.data as { ping?: boolean; id?: number; buffer?: ArrayBuffer };
  if (msg.ping) {
    scope.postMessage({ pong: true });
    return;
  }
  try {
    const d = decodeIlsfAny(msg.buffer!);
    scope.postMessage(
      { id: msg.id, ok: true, format: d.format, sampleRate: d.sampleRate, channels: d.channels, frames: d.frames, samples: d.samples },
      d.samples.map((s) => s.buffer),
    );
  } catch (error) {
    scope.postMessage({ id: msg.id, ok: false, error: (error as Error).message });
  }
};
