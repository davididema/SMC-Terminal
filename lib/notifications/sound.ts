/**
 * Optional sound alerts using the Web Audio API (no audio dependencies).
 *
 * Sound is opt-in and disabled by default (the caller gates playback on
 * preferences). Browser autoplay rules require a prior user gesture: `unlock`
 * should be called from a real user interaction to create/resume the shared
 * context. All failures degrade silently.
 */

export interface AudioParamLike {
  value: number;
  setValueAtTime?(value: number, startTime: number): void;
  linearRampToValueAtTime?(value: number, endTime: number): void;
  exponentialRampToValueAtTime?(value: number, endTime: number): void;
}

export interface OscillatorLike {
  type: string;
  frequency: AudioParamLike;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike {
  gain: AudioParamLike;
  connect(destination: unknown): void;
}

export interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

export type AudioContextFactory = () => AudioContextLike | null;

export interface SoundPlayerOptions {
  frequency?: number;
  durationSeconds?: number;
  volume?: number;
}

export interface SoundPlayer {
  /** Schedules a short tone; returns false when audio is unavailable. */
  play(): boolean;
  /** Creates/resumes the shared context; call from a user gesture. */
  unlock(): void;
}

export function createSoundPlayer(
  factory: AudioContextFactory,
  options: SoundPlayerOptions = {}
): SoundPlayer {
  const frequency = options.frequency ?? 880;
  const duration = options.durationSeconds ?? 0.15;
  const volume = options.volume ?? 0.15;

  const getContext = (): AudioContextLike | null => {
    try {
      return factory();
    } catch {
      return null;
    }
  };

  return {
    unlock() {
      try {
        const ctx = getContext();
        if (ctx && ctx.state === 'suspended') {
          void ctx.resume().catch(() => undefined);
        }
      } catch {
        // Ignore.
      }
    },
    play() {
      try {
        const ctx = getContext();
        if (!ctx) return false;
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => undefined);
        }
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime;
        gain.gain.setValueAtTime?.(volume, start);
        gain.gain.exponentialRampToValueAtTime?.(0.0001, start + duration);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime?.(frequency, start);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + duration);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Cached browser factory. Returns `null` when the Web Audio API is unavailable
 * (SSR, unsupported browser), so callers degrade gracefully.
 */
export function browserAudioContextFactory(): AudioContextFactory {
  let cached: AudioContextLike | null = null;
  let created = false;
  return () => {
    if (created) return cached;
    created = true;
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
      AudioContext?: new () => AudioContextLike;
      webkitAudioContext?: new () => AudioContextLike;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
      cached = null;
      return null;
    }
    try {
      cached = new Ctor();
    } catch {
      cached = null;
    }
    return cached;
  };
}
