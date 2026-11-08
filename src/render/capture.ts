import * as THREE from 'three/webgpu';

/** ACES filmic approximation (Narkowicz), then sRGB encode: matches the on-screen look closely. */
function toDisplay(linear: number): number {
  const x = linear;
  const aces = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  const c = Math.min(1, Math.max(0, aces));
  const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

/**
 * Render the current view into a GPU render target, read it back and encode a PNG. Works the
 * same on the WebGPU and WebGL2 backends (no reliance on canvas presentation timing), so it
 * backs the screenshot/share features and automated visual checks.
 */
export async function captureFrame(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  width = 1280,
  /** Optional post-processing chain to render through instead of a plain scene render. */
  post?: { render(): void; readonly outputsDisplay: boolean },
): Promise<Blob> {
  // WebGPU copies rows in 256-byte steps: keep the width a multiple of 64 RGBA pixels.
  if (!Number.isFinite(width)) throw new Error('Capture width must be finite');
  const w = Math.max(64, Math.min(4096, Math.round(width / 64) * 64));
  const h = Math.max(1, Math.round(w / camera.aspect));
  const rt = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType });
  const previousTarget = renderer.getRenderTarget();
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  try {
    renderer.setRenderTarget(rt);
    if (post) {
      // The post chain's internal passes follow the drawing-buffer size: match it to the
      // capture so the PNG is rendered at full resolution, then put the canvas size back.
      const size = renderer.getSize(new THREE.Vector2());
      const ratio = renderer.getPixelRatio();
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      try {
        post.render();
      } finally {
        renderer.setPixelRatio(ratio);
        renderer.setSize(size.x, size.y, false);
      }
    } else renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    // A post chain that already tone-mapped and sRGB-encoded needs no further conversion.
    const display = !!post?.outputsDisplay;
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
    const webgl = !(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    const img = new ImageData(w, h);
    const half = px instanceof Uint16Array;
    const decode = (v: number) => (half ? THREE.DataUtils.fromHalfFloat(v) : v / 255);
    const toByte = display ? (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255) : toDisplay;
    for (let y = 0; y < h; y++) {
      // WebGL reads bottom-up, WebGPU top-down.
      const src = webgl ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const i = (src * w + x) * 4;
        const o = (y * w + x) * 4;
        img.data[o] = toByte(decode(px[i]));
        img.data[o + 1] = toByte(decode(px[i + 1]));
        img.data[o + 2] = toByte(decode(px[i + 2]));
        img.data[o + 3] = 255;
      }
    }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    rt.dispose();
  }
}
