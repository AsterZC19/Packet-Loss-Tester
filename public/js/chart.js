// public/js/chart.js
// Hand-rolled canvas "延迟趋势" chart — no external libraries, no CDN.
// Draws: RTT line (avg per bucket), the latency threshold as a dashed line,
// and red dots where echoes exceeded the threshold in that bucket.
export class TrendChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = [];
    this.thresholdMs = 200;
    this._render = this._render.bind(this);
    this._raf = 0;
    this._dirty = false;
    this._resizeHandler = () => {
      this._dirty = true;
      this.requestRender();
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  reset({ thresholdMs, durationMs }) {
    this.series = [];
    this.thresholdMs = thresholdMs ?? 200;
    this.durationMs = durationMs ?? 10;
    this._dirty = true;
    this.requestRender();
  }

  setSeries(series) {
    this.series = series;
    this._dirty = true;
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(this._render);
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
    cancelAnimationFrame(this._raf);
  }

  _render() {
    this._raf = 0;
    if (!this._dirty) return;
    this._dirty = false;
    this._draw();
  }

  _prepareCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(10, Math.round(rect.width));
    const h = Math.max(10, Math.round(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  _draw() {
    const { ctx, canvas } = this;
    const { w, h } = this._prepareCanvas();
    const pad = { l: 42, r: 12, t: 14, b: 24 };
    const plotW = Math.max(20, w - pad.l - pad.r);
    const plotH = Math.max(20, h - pad.t - pad.b);

    ctx.clearRect(0, 0, w, h);

    // ---- data bounds ----
    let yMax = Math.max(this.thresholdMs * 1.15, 10);
    for (const p of this.series) yMax = Math.max(yMax, p.max * 1.1);
    yMax = niceCeil(yMax);

    const maxT = Math.max(this.durationMs, this.series.length ? this.series[this.series.length - 1].t : 0, 1);

    const X = (t) => pad.l + (t / maxT) * plotW;
    const Y = (ms) => pad.t + (1 - ms / yMax) * plotH;

    // ---- grid + y labels ----
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const val = (yMax / ySteps) * i;
      const y = Y(val);
      ctx.strokeStyle = 'rgba(11, 59, 69, 0.08)';
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = '#587179';
      ctx.textAlign = 'right';
      ctx.fillText(fmtMs(val), pad.l - 6, y);
    }

    // x labels (seconds)
    ctx.textAlign = 'center';
    ctx.fillStyle = '#587179';
    const xSteps = Math.max(1, Math.min(10, Math.round(maxT)));
    for (let i = 0; i <= xSteps; i++) {
      const t = (maxT / xSteps) * i;
      ctx.fillText(`${t.toFixed(0)}s`, X(t), h - pad.b + 14);
    }

    // ---- threshold line ----
    ctx.save();
    ctx.strokeStyle = '#f9b417';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(this.thresholdMs));
    ctx.lineTo(w - pad.r, Y(this.thresholdMs));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f9b417';
    ctx.textAlign = 'left';
    ctx.fillText(`阈值 ${fmtMs(this.thresholdMs)}`, pad.l + 4, Math.max(pad.t + 8, Y(this.thresholdMs) - 8));
    ctx.restore();

    // ---- RTT line ----
    if (this.series.length) {
      ctx.strokeStyle = '#29abe2';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      this.series.forEach((p, i) => {
        const x = X(p.t);
        const y = Y(p.avg);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // late markers (red dots)
      for (const p of this.series) {
        if (p.late > 0) {
          ctx.fillStyle = '#ef4b41';
          ctx.beginPath();
          ctx.arc(X(p.t), Y(p.avg), 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ---- empty state ----
    if (!this.series.length) {
      ctx.fillStyle = '#8aa0a6';
      ctx.textAlign = 'center';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('测试进行中,正在采集延迟样本…', pad.l + plotW / 2, pad.t + plotH / 2);
    }

    // y axis caption
    ctx.save();
    ctx.fillStyle = '#8aa0a6';
    ctx.textAlign = 'center';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('ms', pad.l - 30, pad.t + 6);
    ctx.restore();
  }
}

function fmtMs(ms) {
  if (ms >= 100) return `${Math.round(ms)}`;
  return `${ms.toFixed(1)}`;
}

function niceCeil(v) {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  let n;
  if (norm <= 1) n = 1;
  else if (norm <= 2) n = 2;
  else if (norm <= 2.5) n = 2.5;
  else if (norm <= 5) n = 5;
  else n = 10;
  return n * mag;
}
