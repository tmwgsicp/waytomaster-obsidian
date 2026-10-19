import { SyncError } from './api';
import type { Progress } from './sync';

interface Clock {
  now(): number;
  set(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}
const clock: Clock = { now: Date.now, set: (callback, delay) => setTimeout(callback, delay), clear: timer => clearTimeout(timer) };
const retryable = new Set(['idle', 'page_limit', 'network', 'server', 'rate_limit', 'busy']);

// One timer after each settled round: sleeping devices never queue missed rounds.
export class SyncSchedule {
  enabled = false;
  nextAt = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly changed: () => void, private readonly time: Clock = clock) {}

  start(minutes: number, run: () => Promise<Progress>): void {
    if (![15, 30, 60].includes(minutes)) throw new SyncError('configuration', '请选择 15、30 或 60 分钟');
    this.stop();
    this.enabled = true;
    const generation = this.generation;
    const schedule = (delay: number) => {
      this.nextAt = this.time.now() + delay;
      this.timer = this.time.set(() => { void tick(); }, delay);
      this.changed();
    };
    const tick = async () => {
      if (generation !== this.generation) return;
      this.timer = undefined;
      this.nextAt = 0;
      this.changed();
      let result: Progress;
      try { result = await run(); }
      catch { if (generation === this.generation) this.stop(); return; }
      if (generation !== this.generation) return;
      if (!retryable.has(result.state)) { this.stop(); return; }
      schedule(Math.max(minutes * 60_000, (result.retryAt || 0) - this.time.now()));
    };
    schedule(0);
  }

  stop(): void {
    this.generation++;
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    this.enabled = false;
    this.nextAt = 0;
    this.changed();
  }
}
