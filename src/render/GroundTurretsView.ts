import * as THREE from 'three/webgpu';
import type { GroundTurretSystem } from '../sim/groundTurrets.ts';
import { TURRET_DEF } from '../sim/groundTurrets.ts';
import { RemoteCraftView } from './RemoteCraftView.ts';

/**
 * Tower turrets, drawn from their craft definition (red-team colours, the vehicle grammar's
 * detail) with the head traversing and the barrels elevating. Their lights say what they are
 * doing (§5): dim while idle, full while tracking or firing, flickering once hit.
 */
export class GroundTurretsView {
  private readonly views = new Map<number, RemoteCraftView>();
  private readonly level = new THREE.Quaternion();
  private time = 0;
  /** The simulation's clock (EMP timers are in it). */
  simTime = 0;

  constructor(private readonly scene: THREE.Scene, private readonly turrets: GroundTurretSystem) {}

  update(dt: number): void {
    this.time += dt;
    const live = new Set<number>();
    for (const t of this.turrets.turrets) {
      if (t.derezAt !== null) continue;
      live.add(t.id);
      let v = this.views.get(t.id);
      if (!v) {
        v = new RemoteCraftView(TURRET_DEF, t.color, { beacon: false });
        this.views.set(t.id, v);
        this.scene.add(v.root);
      }
      v.update(t.pos, this.level, 0, 0, dt);
      v.setTurret(t.pose);
      v.setLightState({ activity: t.state === 'idle' ? 0 : 1, integrity: t.hp / t.maxHp, time: this.time, inactive: t.disabledUntil > this.simTime });
    }
    for (const [id, v] of this.views) {
      if (live.has(id)) continue;
      this.scene.remove(v.root);
      v.dispose();
      this.views.delete(id);
    }
  }
}
