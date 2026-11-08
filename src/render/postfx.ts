import * as THREE from 'three/webgpu';
import { builtinAOContext, mrt, normalView, pass, renderOutput, screenUV } from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';

/**
 * Render quality. 'low' draws straight to the screen (MSAA, no post); 'medium' adds HDR bloom
 * and SMAA; 'high' adds ground-truth ambient occlusion (GTAO) on indirect light. Works on
 * WebGPU and the WebGL2 fallback (TSL compiles to both).
 */
export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];

export interface PostOptions {
  /** Bloom strength / radius / luminance threshold (HDR, before tone mapping). */
  bloom?: { strength: number; radius: number; threshold: number };
  /** AO radius (m) for 'high'. */
  aoRadius?: number;
}

/** One post-processing chain for one scene + camera, rebuilt when the quality changes. */
export class PostFX {
  private pipeline: THREE.RenderPipeline | null = null;
  private built: Quality | null = null;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly opts: PostOptions = {},
  ) {}

  setQuality(q: Quality): void {
    if (q === this.built) return;
    this.pipeline?.dispose();
    this.pipeline = null;
    this.built = q;
    if (q === 'low') return;

    const scenePass = pass(this.scene, this.camera);
    if (q === 'high') {
      // Depth + view-normal pre-pass feeds GTAO; AO then darkens only indirect (ambient/IBL)
      // light inside the materials, as real occlusion does, not direct sunlight.
      const pre = pass(this.scene, this.camera);
      pre.setMRT(mrt({ output: normalView }));
      const aoPass = ao(pre.getTextureNode('depth'), pre.getTextureNode(), this.camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = this.opts.aoRadius ?? 1.5;
      scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
    }
    const color = scenePass.getTextureNode('output');
    const b = this.opts.bloom ?? { strength: 0.25, radius: 0.5, threshold: 1.2 };
    const glow = bloom(color, b.strength, b.radius, b.threshold);
    // Tone map + sRGB before SMAA (edge detection wants display values).
    const pipeline = new THREE.RenderPipeline(this.renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = smaa(renderOutput(color.add(glow)));
    this.pipeline = pipeline;
  }

  get quality(): Quality {
    return this.built ?? 'low';
  }

  render(): void {
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.pipeline = null;
    this.built = null;
  }
}
