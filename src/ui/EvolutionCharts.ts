/**
 * The two charts of Bit evolution (the explorer's Evolution Lab and the K inspector's Bits tab):
 *
 * - **Gene means over time:** one 2px line per gene (0..1, one axis), a crosshair that snaps to
 *   the nearest sample and a tooltip listing every series there.
 * - **Look shares over time:** a stacked area of one style field's choices (shares 0..1), with
 *   2px surface gaps between the bands, and the same crosshair and tooltip.
 *
 * Canvas, sized for the device's pixel ratio; text in the panel's text colours, never the series
 * colour. The categorical palette was validated on the panel's surface (#030a1e) with the
 * dataviz validator: lightness band, chroma floor, CVD and normal-vision separation, contrast.
 */
export const CHART = {
  surface: '#030a1e',
  text: '#cfe6ff',
  textSecondary: '#8fb6e8',
  muted: '#6f8fbf',
  grid: 'rgba(143, 182, 232, 0.14)',
  axis: 'rgba(143, 182, 232, 0.35)',
  crosshair: 'rgba(207, 230, 255, 0.55)',
  /** Categorical slots, in fixed order (never cycled). */
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c'],
} as const;

export interface ChartSeries {
  label: string;
  color: string;
  /** One value per sample, 0..1. */
  values: number[];
}

/** Minutes, for the time axis. */
const fmtTime = (s: number) => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

abstract class TimeChart {
  readonly root: HTMLDivElement;
  protected readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  protected readonly legend: HTMLDivElement;
  protected times: number[] = [];
  protected series: ChartSeries[] = [];
  private hoverX: number | null = null;
  protected readonly pad = { l: 30, r: 8, t: 8, b: 20 };

  /** The top of the value axis, and how values are written (the Scenario Lab charts its own units). */
  protected readonly yMax: number;
  protected readonly fmt: (v: number) => string;

  constructor(title: string, private readonly height = 150, opts: { yMax?: number; fmt?: (v: number) => string } = {}) {
    this.yMax = opts.yMax ?? 1;
    this.fmt = opts.fmt ?? ((v) => v.toFixed(2));
    this.root = document.createElement('div');
    this.root.className = 'evo-chart';
    const h = document.createElement('div');
    h.className = 'evo-chart-title';
    h.textContent = title;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', title);
    this.tip = document.createElement('div');
    this.tip.className = 'evo-tip hidden';
    this.legend = document.createElement('div');
    this.legend.className = 'evo-legend';
    const wrap = document.createElement('div');
    wrap.className = 'evo-plot';
    wrap.append(this.canvas, this.tip);
    this.root.append(h, wrap, this.legend);
    this.canvas.addEventListener('pointermove', (e) => { this.hoverX = e.offsetX; this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.draw(); });
  }

  /** New data: sample times (s) and series of the same length. */
  set(times: number[], series: ChartSeries[]): void {
    this.times = times;
    if (series.map((s) => s.label + s.color).join() !== this.series.map((s) => s.label + s.color).join()) this.renderLegend(series);
    this.series = series;
    this.draw();
  }

  private renderLegend(series: ChartSeries[]): void {
    this.legend.replaceChildren();
    for (const s of series) {
      const item = document.createElement('span');
      const key = document.createElement('i');
      key.className = this.legendKey;
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.label));
      this.legend.append(item);
    }
  }

  protected abstract readonly legendKey: string;
  protected abstract plot(ctx: CanvasRenderingContext2D, x: (i: number) => number, y: (v: number) => number): void;
  /** Tooltip rows at sample i: value first, then the label. */
  protected abstract rows(i: number): Array<{ color: string; value: string; label: string }>;

  draw(): void {
    const w = Math.max(160, this.canvas.parentElement?.clientWidth || 320), h = this.height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = CHART.surface;
    ctx.fillRect(0, 0, w, h);
    const { l, r, t, b } = this.pad;
    const pw = w - l - r, ph = h - t - b;
    const n = this.times.length;
    const t0 = n ? this.times[0] : 0, t1 = n > 1 ? this.times[n - 1] : t0 + 1;
    const x = (i: number) => l + ((this.times[i] - t0) / (t1 - t0)) * pw;
    const y = (v: number) => t + (1 - Math.max(0, Math.min(1, v / this.yMax))) * ph;
    // Recessive grid and axis labels.
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const v = f * this.yMax;
      ctx.strokeStyle = v === 0 ? CHART.axis : CHART.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l, Math.round(y(v)) + 0.5);
      ctx.lineTo(l + pw, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = CHART.muted;
      ctx.textAlign = 'right';
      ctx.fillText(this.yMax === 1 ? v.toFixed(f === 0 || f === 1 ? 0 : 2) : this.fmt(v), l - 4, y(v));
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = CHART.muted;
    ctx.fillText(fmtTime(t0), l, h - 5);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(t1), l + pw, h - 5);
    if (n >= 2) this.plot(ctx, x, y);
    // Crosshair and tooltip at the nearest sample.
    if (this.hoverX === null || n < 2) { this.tip.classList.add('hidden'); return; }
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - this.hoverX) < Math.abs(x(best) - this.hoverX)) best = i;
    const cx = Math.round(x(best)) + 0.5;
    ctx.strokeStyle = CHART.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, t);
    ctx.lineTo(cx, t + ph);
    ctx.stroke();
    this.tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'evo-tip-head';
    head.textContent = fmtTime(this.times[best]);
    this.tip.append(head);
    for (const row of this.rows(best)) {
      const line = document.createElement('div');
      const key = document.createElement('i');
      key.style.background = row.color;
      const v = document.createElement('b');
      v.textContent = row.value;
      line.append(key, v, document.createTextNode(` ${row.label}`));
      this.tip.append(line);
    }
    this.tip.classList.remove('hidden');
    const left = cx + 10 + 150 > w ? cx - 10 - 150 : cx + 10;
    this.tip.style.left = `${Math.max(0, left)}px`;
    this.tip.style.top = `${t}px`;
  }
}

/** Gene means (0..1) over time: one line per gene. */
export class GeneChart extends TimeChart {
  protected readonly legendKey = 'evo-key-line';

  protected plot(ctx: CanvasRenderingContext2D, x: (i: number) => number, y: (v: number) => number): void {
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      s.values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
      ctx.stroke();
    }
  }

  protected rows(i: number) {
    return [...this.series].sort((a, b) => b.values[i] - a.values[i]).map((s) => ({ color: s.color, value: this.fmt(s.values[i]), label: s.label }));
  }
}

/** Shares of a style field's choices over time: stacked bands with surface gaps. */
export class ShareChart extends TimeChart {
  protected readonly legendKey = 'evo-key-box';

  protected plot(ctx: CanvasRenderingContext2D, x: (i: number) => number, y: (v: number) => number): void {
    const n = this.times.length;
    const base = new Array<number>(n).fill(0);
    const bounds: number[][] = [];
    for (const s of this.series) {
      const top = base.map((b, i) => b + s.values[i]);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      for (let i = 0; i < n; i++) (i === 0 ? ctx.moveTo(x(i), y(top[i])) : ctx.lineTo(x(i), y(top[i])));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), y(base[i]));
      ctx.closePath();
      ctx.fill();
      bounds.push(top);
      for (let i = 0; i < n; i++) base[i] = top[i];
    }
    // 2px surface gaps between the bands.
    ctx.strokeStyle = CHART.surface;
    ctx.lineWidth = 2;
    for (const top of bounds.slice(0, -1)) {
      ctx.beginPath();
      top.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
      ctx.stroke();
    }
  }

  protected rows(i: number) {
    return this.series.map((s) => ({ color: s.color, value: `${Math.round(s.values[i] * 100)}%`, label: s.label }));
  }
}
