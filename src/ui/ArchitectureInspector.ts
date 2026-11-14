import type * as THREE from 'three/webgpu';
import type { DigitalWorldView } from '../render/arch/DigitalWorldView.ts';
import type { InfrastructureView } from '../render/arch/InfrastructureView.ts';
import type { TerrainView } from '../render/arch/TerrainView.ts';
import type { WorldView } from '../render/WorldView.ts';
import { ArchitectureDebugPanel } from './ArchitectureDebugPanel.ts';
import type { CensusRecorder } from '../sim/evolutionLab.ts';

/**
 * The in-game architecture inspector (K): the world tab and the structure inspector of the
 * explorer's debug panel over the flight view, and the Bits tab (how the people evolve). The
 * archetype lab and seed regeneration live in the Digital World Explorer (explore.html), which
 * shares the same panel.
 */
export class ArchitectureInspector {
  readonly panel: ArchitectureDebugPanel;

  constructor(opts: { world: DigitalWorldView; terrain: TerrainView; routes: InfrastructureView; sky: WorldView; camera: THREE.PerspectiveCamera; canvas: HTMLCanvasElement; active: () => boolean; bits?: { recorder: CensusRecorder; reset: () => void } }) {
    this.panel = new ArchitectureDebugPanel({ ...opts, lab: null, regenerate: null, teleport: null });
    this.panel.visible = false;
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.code === 'KeyK' && opts.active()) this.panel.visible = !this.panel.visible;
    });
  }

  update(dt: number): void {
    this.panel.update(dt);
  }
}
