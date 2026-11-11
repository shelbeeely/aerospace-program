import type * as THREE from 'three';

/** A hostile aircraft to mark: where it is, how far, and whether it is attacking. */
export interface HostileMark {
  pos: THREE.Vector3;
  range: number;
  attacking: boolean;
  /** Its side's colour (red when unset). */
  color?: string;
  /** A friend: a small caret instead of brackets. */
  friend?: boolean;
  /** A word before the range (e.g. RAIL). */
  tag?: string;
}

const MAX = 12;

/** Where a world point lands on the screen, slid to the edge (`edge` true) when it is out of view. */
function screenPoint(camera: THREE.Camera, pos: THREE.Vector3, width: number, height: number, margin: number): { x: number; y: number; edge: boolean } {
  const v = pos.clone().project(camera);
  const behind = v.z > 1;
  let x = (behind ? -v.x : v.x) * 0.5 + 0.5, y = (behind ? v.y : -v.y) * 0.5 + 0.5;
  let edge = behind || x < 0 || x > 1 || y < 0 || y > 1;
  if (edge) {
    const dx = x - 0.5, dy = y - 0.5;
    const k = 0.5 / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
    x = 0.5 + dx * k;
    y = 0.5 + dy * k;
  }
  const px = Math.min(width - margin, Math.max(margin, x * width));
  const py = Math.min(height - margin, Math.max(margin, y * height));
  edge ||= px !== x * width || py !== y * height;
  return { x: px, y: py, edge };
}

/**
 * The lock: a thin cyan diamond on the vehicle being acquired, which closes to a solid diamond
 * marked LOCK once it is locked (with the target's name and range).
 */
export class LockMarker {
  private readonly el: HTMLElement | null;
  private readonly label: HTMLElement | null;
  private shown = false;
  private text = '';

  constructor(root: HTMLElement | null) {
    if (!root) {
      this.el = this.label = null;
      return;
    }
    this.el = document.createElement('div');
    this.el.className = 'lock-mark';
    this.el.style.display = 'none';
    this.label = document.createElement('small');
    this.el.appendChild(this.label);
    root.appendChild(this.el);
  }

  update(camera: THREE.Camera, target: { pos: THREE.Vector3; range: number; name: string; locked: boolean } | null, width: number, height: number): void {
    if (!this.el || !this.label) return;
    if (!target) {
      if (this.shown) this.el.style.display = 'none';
      this.shown = false;
      return;
    }
    const p = screenPoint(camera, target.pos, width, height, 30);
    const size = target.locked ? 30 : 44;
    this.el.style.display = '';
    this.el.style.transform = `translate(${Math.round(p.x - size / 2)}px, ${Math.round(p.y - size / 2)}px)`;
    this.el.style.width = this.el.style.height = `${size}px`;
    this.el.classList.toggle('locked', target.locked);
    this.el.classList.toggle('edge', p.edge);
    const r = target.range >= 1000 ? `${(target.range / 1000).toFixed(1)} km` : `${Math.round(target.range / 10) * 10} m`;
    const text = `${target.locked ? 'LOCK' : 'TRACK'} ${target.name} ${r}`;
    if (text !== this.text) this.label.textContent = this.text = text;
    this.shown = true;
  }
}

/**
 * Target brackets over the hostile aircraft: a thin red square bracket around each one in view
 * (brighter while it attacks) with its range, and a small marker on the screen's edge toward any
 * that are out of view. Plain DOM, pooled.
 */
export class HostileMarkers {
  private readonly marks: Array<{ el: HTMLElement; label: HTMLElement; shown: boolean; text: string }> = [];

  constructor(private readonly root: HTMLElement | null) {
    if (!root) return;
    for (let i = 0; i < MAX; i++) {
      const el = document.createElement('div');
      el.className = 'hostile-mark';
      el.style.display = 'none';
      const label = document.createElement('small');
      el.appendChild(label);
      root.appendChild(el);
      this.marks.push({ el, label, shown: false, text: '' });
    }
  }

  update(camera: THREE.Camera, hostiles: HostileMark[], width: number, height: number): void {
    if (!this.root) return;
    const margin = 28;
    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i];
      const h = hostiles[i];
      if (!h) {
        if (m.shown) m.el.style.display = 'none';
        m.shown = false;
        continue;
      }
      const v = h.pos.clone().project(camera);
      const behind = v.z > 1;
      let x = (behind ? -v.x : v.x) * 0.5 + 0.5, y = (behind ? v.y : -v.y) * 0.5 + 0.5;
      let edge = behind || x < 0 || x > 1 || y < 0 || y > 1;
      if (edge) {
        // Out of view: slide to the screen's edge along the line from the centre.
        const dx = x - 0.5, dy = y - 0.5;
        const k = 0.5 / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
        x = 0.5 + dx * k;
        y = 0.5 + dy * k;
      }
      const px = Math.min(width - margin, Math.max(margin, x * width));
      const py = Math.min(height - margin, Math.max(margin, y * height));
      edge ||= px !== x * width || py !== y * height;
      // The bracket grows as the aircraft nears (it is a few pixels across at range).
      const size = edge ? 14 : Math.round(Math.min(72, Math.max(22, 9000 / Math.max(60, h.range))));
      m.el.style.display = '';
      m.el.style.transform = `translate(${Math.round(px - size / 2)}px, ${Math.round(py - size / 2)}px)`;
      m.el.style.width = m.el.style.height = `${size}px`;
      m.el.classList.toggle('edge', edge);
      m.el.classList.toggle('attacking', h.attacking);
      m.el.classList.toggle('friend', !!h.friend);
      m.el.style.color = h.color ?? '';
      const text = (h.tag ? `${h.tag} ` : '') + (h.range >= 1000 ? `${(h.range / 1000).toFixed(1)} km` : `${Math.round(h.range / 10) * 10} m`);
      if (text !== m.text) m.label.textContent = m.text = text;
      m.shown = true;
    }
  }

  hide(): void {
    for (const m of this.marks) {
      if (m.shown) m.el.style.display = 'none';
      m.shown = false;
    }
  }
}
