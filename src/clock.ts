// The animation clock: every playing area, the timeline playhead and live-ink
// timing read time from here instead of performance.now(), so playback can be
// frozen as one (the renderer pauses it while ink is being laid down).

export const animClock = {
  offset: 0, // ms of paused time subtracted from the wall clock
  pausedAt: null as number | null, // wall-clock ms when the pause began
  stamp: 0, // bumps on every pause/resume (cache keys)
  /** seconds on the animation clock */
  now(): number {
    return ((this.pausedAt ?? performance.now()) - this.offset) / 1000;
  },
  get paused(): boolean {
    return this.pausedAt !== null;
  },
  pause() {
    if (this.pausedAt !== null) return;
    this.pausedAt = performance.now();
    this.stamp++;
  },
  resume() {
    if (this.pausedAt === null) return;
    this.offset += performance.now() - this.pausedAt;
    this.pausedAt = null;
    this.stamp++;
  },
};
