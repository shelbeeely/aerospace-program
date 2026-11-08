import type * as THREE from 'three/webgpu';

interface BatteryManager extends EventTarget {
  charging: boolean;
  level: number;
}

/**
 * Keeps the frame rate up and the battery alive:
 * - Adaptive resolution: drops the render scale when frames run slow, recovers when there's headroom.
 * - Page Visibility: pauses simulation and rendering in background tabs.
 * - Power saver (Battery Status API, or manual): 30 fps render cap and a lower resolution ceiling,
 *   switched on automatically when unplugged below 25%.
 */
export class PerformanceGovernor {
  /** Current render scale (multiplies the device pixel ratio). */
  scale = 1;
  powerSaver = false;
  /** Power saver forced on/off by the player (null = automatic). */
  powerSaverOverride: boolean | null = null;
  paused = typeof document !== 'undefined' && document.hidden;
  battery: { level: number; charging: boolean } | null = null;
  saveData = false;
  onChange: (() => void) | null = null;

  private avgFrame = 1 / 60;
  private evalTimer = 0;
  private goodSeconds = 0;
  private renderBudget = 0;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly basePixelRatio: number,
  ) {
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      this.onChange?.();
    });
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManager>;
      connection?: { saveData?: boolean; addEventListener?: (t: string, f: () => void) => void };
    };
    nav.getBattery?.()
      .then((b) => {
        const update = () => {
          this.battery = { level: b.level, charging: b.charging };
          this.updatePowerSaver();
        };
        b.addEventListener('levelchange', update);
        b.addEventListener('chargingchange', update);
        update();
      })
      .catch(() => {});
    if (nav.connection) {
      const c = nav.connection;
      const update = () => {
        this.saveData = !!c.saveData;
        this.onChange?.();
      };
      c.addEventListener?.('change', update);
      update();
    }
  }

  setPowerSaver(on: boolean | null): void {
    this.powerSaverOverride = on;
    this.updatePowerSaver();
  }

  private updatePowerSaver(): void {
    const auto = !!this.battery && !this.battery.charging && this.battery.level < 0.25;
    const next = this.powerSaverOverride ?? auto;
    if (next !== this.powerSaver) {
      this.powerSaver = next;
      if (next && this.scale > 0.75) this.applyScale(0.75);
      this.onChange?.();
    }
  }

  private applyScale(s: number): void {
    this.scale = Math.round(s * 100) / 100;
    this.renderer.setPixelRatio(this.basePixelRatio * this.scale);
  }

  /** Call once per animation frame with the real frame time. Returns whether to render it. */
  frame(dt: number): boolean {
    this.avgFrame += (dt - this.avgFrame) * 0.1;
    this.evalTimer += dt;
    if (this.evalTimer >= 1) {
      this.evalTimer = 0;
      const fps = 1 / Math.max(1e-3, this.avgFrame);
      const target = this.powerSaver ? 28 : 50;
      const ceiling = this.powerSaver ? 0.75 : 1;
      if (fps < target && this.scale > 0.5) {
        this.applyScale(Math.max(0.5, this.scale - 0.1));
        this.goodSeconds = 0;
        this.onChange?.();
      } else if (fps > target + 8 && this.scale < ceiling) {
        if (++this.goodSeconds >= 3) {
          this.applyScale(Math.min(ceiling, this.scale + 0.05));
          this.goodSeconds = 0;
          this.onChange?.();
        }
      } else this.goodSeconds = 0;
    }
    if (!this.powerSaver) return true;
    // 30 fps render cap in power saver (physics keeps its own fixed rate).
    this.renderBudget += dt;
    if (this.renderBudget < 1 / 31) return false;
    this.renderBudget = 0;
    return true;
  }

  describe(): string {
    const parts = [`scale ${Math.round(this.scale * 100)}%`];
    if (this.powerSaver) parts.push('power saver');
    if (this.battery) parts.push(`battery ${Math.round(this.battery.level * 100)}%${this.battery.charging ? ' ⚡' : ''}`);
    if (this.saveData) parts.push('data saver');
    return parts.join(', ');
  }
}
