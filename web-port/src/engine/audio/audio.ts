/**
 * WebAudio manager. OWNED BY: engine/presentation agent.
 *
 * Synthesises weapon/enemy/ambient cues with oscillators/noise so the slice has
 * audio without shipping original .wav files. Optionally decodes supplied
 * buffers later. Must be resumed from a user gesture (autoplay policy).
 * Replaces this stub.
 */
export interface AudioManager {
  /** Resume the AudioContext (call from a click/keydown gesture). */
  resume(): void;
  /** Play a named cue (fire, reload, hit, death, footstep, ambient...). */
  play(name: string, gain?: number): void;
  setMasterVolume(volume: number): void;
  readonly ready: boolean;
}

export function createAudioManager(): AudioManager {
  return {
    resume(): void {
      /* replaced by agent */
    },
    play(_name: string, _gain?: number): void {
      /* replaced by agent */
    },
    setMasterVolume(_volume: number): void {
      /* replaced by agent */
    },
    get ready(): boolean {
      return false;
    },
  };
}
