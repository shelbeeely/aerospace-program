import * as THREE from 'three';
import { knots, type AdsbRecord } from '../sim/adsb.ts';
import { wrapDelta } from '../sim/contacts.ts';
import { bendPoint } from '../render/curvature.ts';

const MAX = 12;
/** Tags within this of the craft (m); light cycles only this close. */
const REACH = 6000, RIDERS = 700;

/**
 * ADS-B tags in the main view: beside each of the nearest vehicles (up to 12 within 6 km), its
 * callsign, altitude and speed in small faint text in its side's colour. Only what is in view
 * is tagged (no edge arrows: the hostile brackets do that). Placed where the vehicle is drawn,
 * on the curved planet.
 */
export class AdsbTags {
  private readonly tags: Array<{ el: HTMLElement; name: HTMLElement; data: HTMLElement; text: string }> = [];
  private readonly _p = new THREE.Vector3();

  constructor(private readonly root: HTMLElement | null) {
    if (!root) return;
    for (let i = 0; i < MAX; i++) {
      const el = document.createElement('div');
      el.className = 'adsb-tag';
      el.style.display = 'none';
      const name = document.createElement('b');
      const data = document.createElement('span');
      el.append(name, document.createElement('br'), data);
      root.appendChild(el);
      this.tags.push({ el, name, data, text: '' });
    }
  }

  update(camera: THREE.Camera, records: readonly AdsbRecord[] | null, me: THREE.Vector3, width: number, height: number): void {
    if (!this.root) return;
    const near = records
      ? records.filter((r) => r.category !== 'self' && r.range < (r.category === 'ground' ? RIDERS : REACH)).sort((a, b) => a.range - b.range)
      : [];
    let n = 0;
    for (const r of near) {
      if (n >= MAX) break;
      // In the craft's image of the planet, bent the way it is drawn.
      this._p.set(me.x + wrapDelta(me.x, r.x), r.alt + (r.category === 'ground' ? 2 : 0), me.z + wrapDelta(me.z, r.z));
      const v = bendPoint(this._p, this._p).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 0.98 || Math.abs(v.y) > 0.98) continue;
      const t = this.tags[n++];
      const climb = r.vs > 2 ? '▲' : r.vs < -2 ? '▼' : ' ';
      const text = `${r.callsign}|${r.category === 'ground' ? '' : `${Math.round(r.alt)} m ${climb} `}${knots(r.gs)} kt`;
      if (text !== t.text) {
        t.text = text;
        const [a, b] = text.split('|');
        t.name.textContent = a;
        t.data.textContent = b;
      }
      t.el.style.color = r.color;
      t.el.classList.toggle('foe', r.foe);
      t.el.style.display = '';
      t.el.style.transform = `translate(${Math.round((v.x * 0.5 + 0.5) * width + 14)}px, ${Math.round((-v.y * 0.5 + 0.5) * height - 24)}px)`;
    }
    for (let i = n; i < MAX; i++) if (this.tags[i].el.style.display !== 'none') this.tags[i].el.style.display = 'none';
  }
}
