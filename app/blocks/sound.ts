// Minimal WebAudio board: a filtered tick per pending transaction and a sub
// thump per block. Off by default; the AudioContext is created on first
// enable so the user-gesture requirement is always satisfied.

export interface SoundBoard {
  readonly enabled: boolean;
  toggle(): boolean;
  tick(): void;
  thump(strength: number): void;
  dispose(): void;
}

const TICK_GAP_MS = 45;

export function createSoundBoard(): SoundBoard {
  let context: AudioContext | undefined;
  let enabled = false;
  let lastTickAt = 0;

  const board = {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      if (enabled) {
        context ??= new AudioContext();
        void context.resume();
      }
      return enabled;
    },
    tick() {
      if (!enabled || !context) return;
      const nowMs = performance.now();
      if (nowMs - lastTickAt < TICK_GAP_MS) return;
      lastTickAt = nowMs;
      const t = context.currentTime;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "triangle";
      osc.frequency.value = 1800 + Math.random() * 900;
      gain.gain.setValueAtTime(0.012, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
      osc.connect(gain).connect(context.destination);
      osc.start(t);
      osc.stop(t + 0.04);
    },
    thump(strength: number) {
      if (!enabled || !context) return;
      const t = context.currentTime;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.3);
      gain.gain.setValueAtTime(0.18 * Math.min(1.2, 0.4 + strength), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain).connect(context.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    },
    dispose() {
      enabled = false;
      void context?.close();
      context = undefined;
    },
  };
  return board;
}
