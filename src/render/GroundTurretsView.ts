import * as THREE from 'three/webgpu';
import type { GroundTurretSystem } from '../sim/groundTurrets.ts';
import { turretDef } from '../sim/groundTurrets.ts';
import { RemoteCraftView } from './RemoteCraftView.ts';

/**
 * Tower turrets, drawn from their craft definition (red-team colours, the vehicle grammar's
 * detail) with the head traversing and the barrels elevating. Their lights say what they are
 * doing (§5): dim while idle, full while tracking or firing, flickering once hit.
 */
export class GroundTurretsView {
  private readonly views = new Map<number, RemoteCraftView>();
  private readonly sides = new Map<number, number>();
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
      // Hacked over (or back): rebuilt in its new side's colours.
      if (v && this.sides.get(t.id) !== t.side) {
        v.root.removeFromParent();
        v.dispose();
        v = undefined;
      }
      if (!v) {
        this.sides.set(t.id, t.side);
        // Its own design (gun or railgun) in its team's colours.
        v = new RemoteCraftView(turretDef(t.side, t.site.kind), t.color, { beacon: false });
        this.views.set(t.id, v);
        this.scene.add(v.root);
      }
      v.update(t.pos, this.level, 0, 0, dt);
      v.setTurret(t.pose);
      // A railgun charging: its lights pulse up toward the shot.
      const charge = t.state === 'charging' && t.chargeAt !== null ? Math.min(1, (this.simTime - t.chargeAt) / 0.8) : 0;
      v.setLightState({ activity: t.state === 'idle' ? 0 : charge ? 0.5 + 0.5 * charge * (0.6 + 0.4 * Math.sin(this.time * 40)) : 1, integrity: t.hp / t.maxHp, time: this.time, inactive: t.disabledUntil > this.simTime });
    }
    for (const [id, v] of this.views) {
      if (live.has(id)) continue;
      this.scene.remove(v.root);
      v.dispose();
      this.views.delete(id);
      this.sides.delete(id);
    }
  }
}
