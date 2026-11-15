import { PAD_STALE, type PadInputMsg } from '../tv/protocol.ts';
import type { Action, InputContext, InputDevice, RawInput } from './types.ts';

/**
 * A gamepad on another device: the phone in pad.html, heard over the cast channel or the relay
 * (src/tv/protocol.ts). The phone's touch controls already did the work (expo, inversion,
 * layout per vehicle), so this only replays what it sent: axes and held buttons until the next
 * message, one-shots once. Controls older than PAD_STALE seconds read as hands-off, so a pad that
 * drops out never leaves the stick held over.
 */
export class RemoteDevice implements InputDevice {
  private latest: PadInputMsg | null = null;
  private at = -Infinity;
  private th: number | null = null;
  private fs = 0;
  private fc = false;
  private actions: Action[] = [];
  /** Sequence numbers just seen: the same message can come twice (over two links). */
  private readonly seen: number[] = [];
  /** Where rumble goes (the link back to the phone). */
  onRumble: ((strength: number, durationMs: number) => void) | null = null;

  /** `now`: seconds on any steady clock (the same one `read` is given through `clock`). */
  constructor(private readonly clock: () => number = () => performance.now() / 1000) {}

  /** Has the pad been heard from recently? */
  get live(): boolean {
    return this.clock() - this.at < PAD_STALE;
  }

  apply(m: PadInputMsg): void {
    // Only repeats are dropped: a pad that reconnects starts counting again from 1.
    if (this.seen.includes(m.s)) return;
    this.seen.push(m.s);
    if (this.seen.length > 8) this.seen.shift();
    this.latest = m;
    this.at = this.clock();
    if (m.th !== undefined) this.th = m.th;
    if (m.fs) this.fs += m.fs;
    if (m.fc) this.fc = true;
    if (m.a) this.actions.push(...m.a);
  }

  read(raw: RawInput, _ctx: InputContext): void {
    if (this.th !== null) raw.throttleSet = this.th;
    this.th = null;
    raw.flapSteps += this.fs;
    this.fs = 0;
    if (this.fc) raw.flapCycle = true;
    this.fc = false;
    const m = this.latest;
    if (!m || !this.live) return;
    const [pitch, roll, yaw, throttleRate, brake, trimRate, aimYaw, aimPitch] = m.ax;
    raw.pitch += pitch;
    raw.roll += roll;
    raw.yaw += yaw;
    raw.throttleRate += throttleRate;
    raw.brake = Math.max(raw.brake, brake);
    raw.trimRate += trimRate;
    raw.aimYaw += aimYaw;
    raw.aimPitch += aimPitch;
    if (m.b & 1) raw.fire = true;
    if (m.b & 2) raw.fireAlt = true;
    if (m.b & 4) raw.hack = true;
  }

  drainActions(out: Action[]): void {
    out.push(...this.actions);
    this.actions = [];
  }

  rumble(strength: number, durationMs: number): void {
    this.onRumble?.(strength, durationMs);
  }
}
