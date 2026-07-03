// Ported from bot_timers.lua. A tiny scheduler driven by a 1s tick, exposing the
// same API modules use: CreateRepeatTimer / ScheduleTimer / ScheduleAction.

import { osTime } from "../util/time";
import { logger } from "./logger";

type Callback = () => void | Promise<void>;

export class Timer {
  interval = 0;
  repetition = 0;
  callback: Callback | null;

  constructor(callback: Callback, interval: number, repetition: number) {
    this.callback = callback;
    this.interval = interval;
    this.repetition = repetition;
  }

  async execute(scheduler: Scheduler) {
    if (!this.callback) return;
    await Promise.resolve(this.callback()).catch((e) =>
      logger.warning("Timer callback failed: %s", e?.stack ?? e),
    );

    let repeat = false;
    if (this.repetition > 0) {
      this.repetition -= 1;
      if (this.repetition > 0) repeat = true;
    } else if (this.repetition < 0) {
      repeat = true;
    }

    if (repeat) scheduler.scheduleAction(osTime() + this.interval, () => this.execute(scheduler));
  }

  stop() {
    this.callback = null;
  }
}

interface ScheduledAction {
  time: number;
  cb: Callback;
}

export class Scheduler {
  private actions: ScheduledAction[] = [];
  private pending: ScheduledAction[] = [];
  lastExecution = -1;
  private handle: NodeJS.Timeout | null = null;

  start() {
    if (this.handle) return;
    this.handle = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  createRepeatTimer(interval: number, repetition: number, callback: Callback): Timer {
    const timer = new Timer(callback, interval, repetition);
    this.scheduleAction(osTime() + interval, () => timer.execute(this));
    return timer;
  }

  scheduleTimer(timestamp: number, callback: Callback): Timer {
    const timer = new Timer(callback, 0, 0);
    this.scheduleAction(timestamp, () => timer.execute(this));
    return timer;
  }

  scheduleAction(timestamp: number, cb: Callback) {
    this.pending.push({ time: timestamp, cb });
  }

  private tick() {
    const now = osTime();

    if (this.pending.length > 0) {
      for (const action of this.pending) {
        let index = this.actions.length;
        for (let i = 0; i < this.actions.length; i++) {
          if (this.actions[i].time > action.time) {
            index = i;
            break;
          }
        }
        this.actions.splice(index, 0, action);
      }
      this.pending = [];
    }

    let executed = 0;
    for (const action of this.actions) {
      if (action.time > now) break;
      Promise.resolve(action.cb()).catch((e) => logger.warning("Scheduled action failed: %s", e?.stack ?? e));
      executed++;
    }
    if (executed > 0) this.actions.splice(0, executed);

    this.lastExecution = now;
  }
}
