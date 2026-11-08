import * as THREE from 'three/webgpu';
import { renderOutput, texture, uv } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { RayTracer } from './RayTracer.ts';
import type { RayShape } from './shapes.ts';

export type RenderMode = 'raster' | 'raytrace';

/** A bounded tracing surface, upscaled and bloomed into the caller's destination. */
export class RayTraceMode {
  readonly tracer: RayTracer;
  readonly outputsDisplay = true;
  private readonly surface = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly pipeline: THREE.RenderPipeline;
  private readonly source;
  private width = 1;
  private height = 1;
  /** Interactive width cap. Photos may explicitly request more pixels. */
  resolution = 320;

  constructor(private readonly renderer: THREE.WebGPURenderer, scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
    this.tracer = new RayTracer(renderer, scene, camera);
    this.source = texture(this.surface.texture, uv());
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = renderOutput(this.source.add(bloom(this.source, 1.0, 0.45, 0.6)));
  }

  setShapes(shapes: readonly RayShape[]): void { this.tracer.setShapes(shapes); }
  reset(): void { this.tracer.reset(); }
  get samples(): number { return this.tracer.samples; }
  get renderWidth(): number { return this.width; }

  /** Always restores the current target; callers can compose capture passes around it. */
  render(samples = 1, resolution = this.resolution): void {
    const destination = this.renderer.getRenderTarget();
    const output = destination ? new THREE.Vector2(destination.width, destination.height) : this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(64, Math.round(Math.min(output.x, resolution)));
    const height = Math.max(1, Math.round(width * output.y / output.x));
    if (width !== this.width || height !== this.height) {
      this.width = width; this.height = height;
      this.surface.setSize(width, height);
      this.source.value = this.surface.texture;
      this.reset();
    }
    try {
      this.renderer.setRenderTarget(this.surface);
      for (let i = 0; i < samples; i++) this.tracer.render();
      this.renderer.setRenderTarget(destination);
      this.pipeline.render();
    } finally { this.renderer.setRenderTarget(destination); }
  }

  /** Capture still uses the actual traced image, with fresh progressive samples. */
  photoPass(samples = 16, resolution = 768): { render(): void; readonly outputsDisplay: boolean } {
    if (!Number.isFinite(samples) || !Number.isFinite(resolution)) throw new Error('Photo samples and resolution must be finite');
    const count = Math.max(1, Math.min(64, Math.floor(samples)));
    this.reset();
    return { outputsDisplay: true, render: () => this.render(count, Math.max(64, Math.min(1280, resolution))) };
  }

  dispose(): void { this.tracer.dispose(); this.pipeline.dispose(); this.surface.dispose(); }
}
