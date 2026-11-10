import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';

/**
 * Render quality for the neon look. 'low' draws straight to the screen (MSAA, no post);
 * 'medium' adds a strong HDR bloom (the glowing lines) and SMAA; 'high' adds a second, wide
 * soft bloom for the hazy synthwave halo. Works on WebGPU and the WebGL2 fallback (TSL
 * compiles to both).
 */
export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];

export interface BloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

export interface PostOptions {
  /** Tight bloom (HDR luminance, before tone mapping): the glow right around the lines. */
  bloom?: BloomSettings;
  /** Wide, soft second bloom for 'high'. */
  haze?: BloomSettings;
}

const DEFAULT_BLOOM: BloomSettings = { strength: 0.75, radius: 0.35, threshold: 0.85 };
const DEFAULT_HAZE: BloomSettings = { strength: 0.3, radius: 1.0, threshold: 0.6 };

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
    const color = scenePass.getTextureNode('output');
    const b = this.opts.bloom ?? DEFAULT_BLOOM;
    let lit = color.add(bloom(color, b.strength, b.radius, b.threshold));
    if (q === 'high') {
      const h = this.opts.haze ?? DEFAULT_HAZE;
      lit = lit.add(bloom(color, h.strength, h.radius, h.threshold));
    }
    // Tone map + sRGB before SMAA (edge detection wants display values).
    const pipeline = new THREE.RenderPipeline(this.renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = smaa(renderOutput(lit));
    this.pipeline = pipeline;
  }

  get quality(): Quality {
    return this.built ?? 'low';
  }

  /**
   * Whether `render()` writes display-ready (tone-mapped, sRGB) colour. False for 'low', which
   * writes linear HDR into a render target (the renderer only tone-maps on the canvas).
   */
  get outputsDisplay(): boolean {
    return this.pipeline !== null;
  }

  /** Render to the current render target (the canvas unless one is set). */
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
