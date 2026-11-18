// Beat-grid visualisation: one column per beat, 7 spectral bands stacked (bass at the
// bottom), bars and 4-bar phrases marked, and the ringtone drawn on the grid where it lands.
// Successor to frequencyMapVisual.cs / colorGrid.cs.

const BAND_HUES = [345, 15, 35, 160, 185, 205, 230];

export class Timeline {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * d));
    this.c.height = Math.max(1, Math.round(r.height * d));
    this.w = r.width;
    this.h = r.height;
    this.g.setTransform(d, 0, 0, d, 0, 0);
  }

  draw({ song, t, ring, preview, accent, level }) {
    const g = this.g, W = this.w, H = this.h;
    g.clearRect(0, 0, W, H);
    if (!song) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '500 14px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Pick a song to see its beats, bars and phrases here', W / 2, H / 2);
      g.textAlign = 'start';
      return;
    }
    const a = song.analysis;
    const beats = a.beats;
    const narrow = W < 560;
    const pps = W / (a.beatDur * (narrow ? 20 : 34)); // pixels per second
    const playX = Math.round(W * (narrow ? 0.18 : 0.2));
    const X = (s) => playX + (s - t) * pps;

    const laneTop = 26, laneH = 34;
    const specTop = laneTop + laneH + 18, specBot = H - 22;
    const cellH = (specBot - specTop) / 7;

    // Visible beat range.
    let i0 = 0;
    { let lo = 0, hi = beats.length - 1; const tl = t - playX / pps - a.beatDur;
      while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < tl) lo = m + 1; else hi = m; } i0 = lo; }

    let bar = 0;
    for (let i = i0; i < beats.length; i++) {
      const x0 = X(beats[i]);
      if (x0 > W) break;
      const next = beats[i + 1] ?? beats[i] + a.beatDur;
      const x1 = X(next);
      const past = next <= t;
      const cur = beats[i] <= t && t < next;
      const w = Math.max(1, x1 - x0 - 2);
      for (let b = 0; b < 7; b++) {
        const v = a.freq[b][i];
        const y = specBot - (b + 1) * cellH;
        const alpha = past ? 0.1 + 0.25 * v : 0.18 + 0.8 * v;
        g.fillStyle = `hsla(${BAND_HUES[b]}, 85%, ${38 + 30 * v}%, ${alpha})`;
        g.fillRect(x0 + 1, y + 1, w, cellH - 2);
      }
      if (cur) {
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(x0, specTop - 4, x1 - x0, specBot - specTop + 8);
      }
      if (a.isDown[i]) {
        const phrase = a.isPhrase[i];
        g.strokeStyle = phrase ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.28)';
        g.lineWidth = phrase ? 2 : 1;
        g.beginPath();
        g.moveTo(x0 + 0.5, phrase ? laneTop - 8 : specTop - 6);
        g.lineTo(x0 + 0.5, specBot + 4);
        g.stroke();
        if (phrase && x0 > 0) {
          g.fillStyle = 'rgba(255,255,255,0.55)';
          g.font = '600 10px ui-sans-serif, system-ui, sans-serif';
          g.fillText('PHRASE', x0 + 5, specBot + 15);
        }
        bar++;
      }
    }

    // Planned ring position for the current settings (before ringing).
    if (preview && !ring) {
      const x0 = X(preview.t), x1 = X(preview.t + preview.dur);
      g.setLineDash([5, 4]);
      g.strokeStyle = accent;
      g.lineWidth = 1.5;
      roundRect(g, x0, laneTop, Math.max(8, x1 - x0), laneH, 8);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = accent;
      g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      g.fillText('next ring lands here', x0 + 10, laneTop + laneH / 2 + 4);
      g.globalAlpha = 0.5;
      g.fillRect(x0, laneTop + laneH, 1.5, specBot - laneTop - laneH);
      g.globalAlpha = 1;
    }

    // Scheduled / sounding ringtone repeats.
    if (ring) {
      ring.plays.forEach((p, k) => {
        const x0 = X(p.t), x1 = X(p.t + p.dur);
        if (x1 < 0 || x0 > W) return;
        const active = t >= p.t && t < p.t + p.dur;
        g.fillStyle = accent;
        g.globalAlpha = active ? 0.95 : t > p.t + p.dur ? 0.25 : 0.55;
        roundRect(g, x0, laneTop, Math.max(6, x1 - x0 - 2), laneH, 8);
        g.fill();
        if (active) {
          g.globalAlpha = 0.18 + level * 0.5;
          g.fillRect(x0, laneTop + laneH, Math.max(6, x1 - x0 - 2), specBot - laneTop - laneH);
        }
        g.globalAlpha = 1;
        g.fillStyle = '#0b0b12';
        g.font = '700 11px ui-sans-serif, system-ui, sans-serif';
        g.fillText(`${ring.rt.name} ${k + 1}/${ring.plays.length}`, x0 + 10, laneTop + laneH / 2 + 4);
      });
    }

    // Playhead with a beat pulse.
    const ni = Math.max(0, Math.min(beats.length - 1, i0));
    let phase = 0;
    for (let i = ni; i < beats.length - 1; i++) {
      if (beats[i] <= t && t < beats[i + 1]) { phase = (t - beats[i]) / (beats[i + 1] - beats[i]); break; }
    }
    g.fillStyle = `rgba(255,255,255,${0.35 + 0.6 * (1 - phase)})`;
    g.fillRect(playX - 1, 10, 2, H - 20);
    g.beginPath();
    g.arc(playX, 10, 4 + 3 * (1 - phase), 0, Math.PI * 2);
    g.fill();

    // Countdown until a scheduled ring starts.
    if (ring && t < ring.t0) {
      const s = (ring.t0 - t).toFixed(1);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      g.fillText(`rings in ${s}s`, playX + 8, laneTop - 8);
    }

    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.font = '500 10px ui-sans-serif, system-ui, sans-serif';
    g.fillText('NOTIFICATION', 8, laneTop - 8);
    g.fillText('MUSIC  (bass → treble, per beat)', 8, specTop - 8);
  }
}

// Whole-song overview: energy per beat with the played part highlighted. Click to seek.
export class Overview {
  constructor(canvas, onSeek) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.song) return;
      const r = canvas.getBoundingClientRect();
      onSeek(((e.clientX - r.left) / r.width) * this.song.duration);
    });
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * d));
    this.c.height = Math.max(1, Math.round(r.height * d));
    this.w = r.width; this.h = r.height;
    this.g.setTransform(d, 0, 0, d, 0, 0);
  }
  draw(song, t, ring, accent) {
    this.song = song;
    const g = this.g, W = this.w, H = this.h;
    g.clearRect(0, 0, W, H);
    if (!song) return;
    const a = song.analysis;
    const n = a.beats.length;
    const cols = Math.min(n, Math.floor(W / 3));
    const per = n / cols;
    for (let c = 0; c < cols; c++) {
      const i = Math.floor(c * per);
      let e = 0;
      for (let b = 0; b < 7; b++) e += a.freq[b][i];
      e /= 7;
      const x = (a.beats[i] / song.duration) * W;
      const h = Math.max(2, e * (H - 4));
      g.fillStyle = a.beats[i] <= t ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.22)';
      g.fillRect(x, (H - h) / 2, Math.max(1, W / cols - 1), h);
    }
    if (ring) {
      g.fillStyle = accent;
      const x0 = (ring.t0 / song.duration) * W, x1 = (ring.t1 / song.duration) * W;
      g.fillRect(x0, H - 3, Math.max(2, x1 - x0), 3);
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
