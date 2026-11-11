import * as THREE from 'three/webgpu';
import type { AiAirTraffic } from '../sim/aiTraffic.ts';
import { RemoteCraftView } from './RemoteCraftView.ts';

/**
 * AI aircraft, drawn like any other craft (1982 palette, no beacon), banking through their turns.
 * A hostile's lights say what it is doing: dim on patrol, full when it attacks, flickering once
 * it has been hit.
 */
export class AiTrafficView {
  private readonly views = new Map<number, RemoteCraftView>();
  private readonly _q = new THREE.Quaternion();

  constructor(private readonly scene: THREE.Scene, private readonly traffic: AiAirTraffic) {}

  private time = 0;

  update(dt: number): void {
    this.time += dt;
    const live = new Set<number>();
    for (const f of this.traffic.flyers) {
      if (f.derezAt !== null) continue;
      live.add(f.id);
      let v = this.views.get(f.id);
      if (!v) {
        v = new RemoteCraftView(f.def, f.color, { beacon: false });
        this.views.set(f.id, v);
        this.scene.add(v.root);
      }
      v.update(f.pos, this.traffic.rotation(f, this._q), f.speed, 0.8, dt);
      if (f.hostile) v.setLightState({ activity: f.combat === 'patrol' ? 0 : 1, integrity: f.hp / f.maxHp, time: this.time });
    }
    for (const [id, v] of this.views) {
      if (live.has(id)) continue;
      this.scene.remove(v.root);
      v.dispose();
      this.views.delete(id);
    }
  }
}
