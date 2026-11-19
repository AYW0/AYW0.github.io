// Live interfaces shown in the story's centre card, taken from the demo pages:
// the musical assistant's piano roll (from sing.js) and a RISE song track (from rise.js).
import * as V from './voice.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = (m) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

export class Roll {
  constructor(c, engine, opts = {}) {
    this.engine = engine; this.opts = opts;
    this.c = c; this.g = c.getContext('2d');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(c);
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * d)); this.c.height = Math.max(1, Math.round(r.height * d));
    this.w = r.width; this.h = r.height;
    this.g.setTransform(d, 0, 0, d, 0, 0);
  }
  draw(song, mel, t, n, accent, level) {
    const g = this.g, W = this.w, H = this.h;
    g.clearRect(0, 0, W, H);
    const font = (w, s) => `${w} ${s}px ui-sans-serif, system-ui, sans-serif`;
    if (!song || !mel) {
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = font(500, 14); g.textAlign = 'center';
      g.fillText('Pick a song to see the singer’s melody here', W / 2, H / 2); g.textAlign = 'start';
      return;
    }
    const a = song.analysis;
    const narrow = W < 560;
    const pps = W / (a.beatDur * (narrow ? 10 : 18));
    const playX = Math.round(W * 0.18);
    const X = (s) => playX + (s - t) * pps;
    const tL = t - playX / pps, tR = t + (W - playX) / pps;
    this.view = { t, playX, pps };
    const laneTop = 22, laneH = 22, top = laneTop + laneH + 14, bot = H - 14;
    const Y = (m) => bot - ((m - mel.lo) / (mel.hi - mel.lo)) * (bot - top);
    const muted = n && n.mode === 'musical' && (this.opts.replaceVocals ?? true);

    // Octave lines.
    g.font = font(500, 10);
    for (let m = Math.ceil(mel.lo / 12) * 12; m <= mel.hi; m += 12) {
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, Y(m), W, 1);
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillText(noteName(m), W - 26, Y(m) - 3);
    }
    // Beats and bars.
    let i = this.engine.nextBeatIndex(tL);
    for (; i < a.beats.length && a.beats[i] < tR; i++) {
      const x = Math.round(X(a.beats[i])) + 0.5;
      g.fillStyle = a.isDown[i] ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
      g.fillRect(x, top - 6, 1, bot - top + 6);
    }
    // Notification span.
    if (n) {
      const x0 = X(n.t0), x1 = X(n.t1);
      g.fillStyle = n.mode === 'standard' ? '#ffffff' : accent;
      g.globalAlpha = n.mode === 'standard' ? 0.05 : 0.09;
      g.fillRect(x0, top - 6, x1 - x0, bot - top + 6);
      g.globalAlpha = 1;
    }
    // Singer's melody (pitch track), dimmed where it is muted.
    const k0 = Math.max(0, Math.floor((tL - mel.t0) / mel.hop)), k1 = Math.min(mel.f0.length - 1, Math.ceil((tR - mel.t0) / mel.hop));
    for (let k = k0; k <= k1; k++) {
      if (!mel.f0[k] || mel.conf[k] < 0.6) continue;
      const tt = mel.timeOf(k), m = V.hzToMidi(mel.f0[k]);
      const inN = n && tt >= n.t0 && tt <= n.t1;
      const past = tt < t;
      g.fillStyle = `rgba(255,255,255,${(inN && muted ? 0.12 : past ? 0.3 : 0.6) * mel.conf[k]})`;
      g.fillRect(X(tt) - 1, Y(m) - 1.5, 3, 3);
    }
    // Notification.
    if (n && n.mode === 'musical') {
      g.fillStyle = 'rgba(127,209,255,0.08)';
      g.fillRect(X(n.t0) - 4, laneTop, X(n.t1) - X(n.t0) + 8, laneH);
      let labelRight = -Infinity, below = false;
      for (const nt of n.notes) {
        const xr = X(nt.rawT), xq = X(nt.t), y = Y(nt.songMidi);
        // speech onset → snapped onset
        g.strokeStyle = 'rgba(127,209,255,0.55)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(xr, laneTop + laneH); g.lineTo(xq, y - 6); g.stroke();
        g.fillStyle = '#7fd1ff'; g.fillRect(xr - 1, laneTop + 3, 2, laneH - 6);
        const active = t >= nt.t && t < nt.t1;
        g.fillStyle = accent;
        g.globalAlpha = active ? 1 : t > nt.t1 ? 0.35 : 0.8;
        rr(g, xq + 1, y - 5, Math.max(4, X(nt.t1) - xq - 3), 10, 4); g.fill();
        if (active) { g.globalAlpha = 0.25 + level; rr(g, xq - 2, y - 8, Math.max(4, X(nt.t1) - xq + 3), 16, 7); g.fill(); }
        g.globalAlpha = 1;
        if (nt.label) {
          g.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.75)'; g.font = font(active ? 700 : 600, 11);
          // Alternate above/below the note when labels would collide.
          below = xq + 2 < labelRight + 3 ? !below : false;
          g.fillText(nt.label, xq + 2, below ? y + 18 : y - 10);
          labelRight = xq + 2 + g.measureText(nt.label).width;
        }
      }
    } else if (n) {
      const x0 = X(n.t0), x1 = X(n.t1);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      rr(g, x0, laneTop, Math.max(8, x1 - x0), laneH, 6); g.fill();
      g.fillStyle = '#0b0b12'; g.font = font(700, 11);
      g.fillText('speaking · music ducked', x0 + 8, laneTop + 15);
    }
    // Playhead.
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(playX - 1, 8, 2, H - 16);
    g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = font(500, 10);
    g.fillText('SPEECH RHYTHM', 8, laneTop - 6);
    g.fillText('PITCH', 8, top + 4);
    if (n && t < n.t0) {
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = font(600, 12);
      g.fillText(`${n.mode === 'musical' ? 'sings' : 'speaks'} in ${(n.t0 - t).toFixed(1)}s`, playX + 8, laneTop + 15);
    }
  }
}
function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// RISE track (as on rise.html): the song around the chorus in song time, sections drawn hot or
// calm, the playhead, an upcoming loop as an arc with its replayed region, and loops taken.
export class RiseTrack {
  constructor(c) { this.c = c; this.g = c.getContext('2d'); }
  fit() {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (this.c.width !== Math.round(r.width * d) || this.c.height !== Math.round(r.height * d)) { this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); }
    this.g.setTransform(d, 0, 0, d, 0, 0); this.w = r.width; this.h = r.height;
  }
  draw({ segs, beats, pos, from, to, upcoming, jumps, working, alert, now, loop }) {
    this.fit();
    const g = this.g, W = this.w, H = this.h;
    g.clearRect(0, 0, W, H);
    const L = 10, R = W - 10, top = 64, laneH = H - top - 30, mid = top + laneH / 2;
    const X = (s) => L + ((s - from) / (to - from)) * (R - L);
    for (const s of segs) {
      const x0 = Math.max(L, X(s.start)), x1 = Math.min(R, X(s.end)); if (x1 <= x0) continue;
      g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, laneH); g.clip();
      const grd = g.createLinearGradient(0, top, 0, top + laneH);
      if (s.high) { grd.addColorStop(0, '#ff8a3d'); grd.addColorStop(0.5, '#ff5a6e'); grd.addColorStop(1, '#7a1030'); }
      else { grd.addColorStop(0, '#1b2f55'); grd.addColorStop(1, '#0c1630'); }
      g.fillStyle = grd; g.fillRect(x0, top, x1 - x0, laneH);
      g.globalAlpha = 0.16; g.fillStyle = '#fff';
      if (s.high) { const off = (now * 120) % 40; for (let x = x0 - laneH - 40 + off; x < x1; x += 40) { g.beginPath(); g.moveTo(x, top + laneH); g.lineTo(x + 14, top + laneH); g.lineTo(x + 14 + laneH, top); g.lineTo(x + laneH, top); g.fill(); } }
      g.globalAlpha = 1;
      g.font = '800 12px Inter, sans-serif'; g.fillStyle = s.high ? '#fff' : 'rgba(170,205,255,0.9)'; g.textBaseline = 'alphabetic';
      if (x1 - x0 > 110) g.fillText(s.high ? '🔥 HIGH ENERGY · drop' : '〰 CALM · build', x0 + 8, top + laneH - 9);
      g.restore();
    }
    for (const b of beats) { const x = X(b); if (x < L || x > R) continue; g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(x, top + laneH - 10, 1, 10); }
    // time ticks every 10 s
    g.font = '600 10px "Roboto Mono", monospace'; g.textBaseline = 'alphabetic'; g.fillStyle = 'rgba(255,255,255,0.45)';
    const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
    for (let s = Math.ceil(from / 10) * 10; s <= to; s += 10) { const x = X(s); if (x < L + 20 || x > R - 20) continue; g.fillRect(x, top + laneH, 1, 5); g.fillText(mmss(s), x - 13, top + laneH + 16); }
    // played region is dimmed
    g.fillStyle = 'rgba(7,7,13,0.4)'; g.fillRect(L, top, Math.max(0, X(pos) - L), laneH);
    const arc = (j, col, dashed, label) => {
      const xo = X(j.orig), xd = X(j.dest), h = Math.min(top - 12, 16 + Math.abs(xd - xo) * 0.3);
      g.fillStyle = col; g.globalAlpha = 0.25; g.fillRect(Math.min(xo, xd), top, Math.abs(xo - xd), laneH); g.globalAlpha = 1;
      g.strokeStyle = col; g.lineWidth = 3; if (dashed) g.setLineDash([7, 5]);
      g.beginPath(); g.moveTo(xo, top - 2); g.bezierCurveTo(xo, top - 2 - h, xd, top - 2 - h, xd, top - 2); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.beginPath(); g.moveTo(xd, top); g.lineTo(xd - 6, top - 10); g.lineTo(xd + 6, top - 10); g.fill();
      g.fillRect(xo - 1.5, top, 3, laneH);
      if (label) { g.font = '800 12px Inter, sans-serif'; const tw = g.measureText(label).width + 14, lx = Math.max(L, Math.min(R - tw, (xo + xd) / 2 - tw / 2)), ly = Math.max(2, top - 2 - h - 22);
        g.fillStyle = col; rr(g, lx, ly, tw, 20, 10); g.fill(); g.fillStyle = '#0b0b12'; g.textBaseline = 'middle'; g.fillText(label, lx + 7, ly + 10); }
    };
    // the looped chunk stays marked, with where it jumps from and to
    if (loop) {
      const xo = X(loop.orig), xd = X(loop.dest);
      g.strokeStyle = LOOPC; g.lineWidth = 2; g.setLineDash([4, 4]); g.strokeRect(xd, top + 1, xo - xd, laneH - 2); g.setLineDash([]);
      g.font = '800 11px Inter, sans-serif'; g.fillStyle = LOOPC; g.textBaseline = 'alphabetic';
      const pill = (t, x) => { const w = g.measureText(t).width + 12; g.fillStyle = 'rgba(11,11,18,0.85)'; rr(g, x, top + 4, w, 18, 9); g.fill(); g.fillStyle = LOOPC; g.fillText(t, x + 6, top + 17); return w; };
      pill('↩ to ' + mmss(loop.dest) + '.' + Math.floor((loop.dest % 1) * 10), xd + 4);
      const tl = 'from ' + mmss(loop.orig) + '.' + Math.floor((loop.orig % 1) * 10); pill(tl, xo - g.measureText(tl).width - 16);
    }
    for (const j of jumps) arc(j, j.dest < j.orig ? LOOPC : SKIPC, false, null);
    if (upcoming) arc(upcoming, LOOPC, true, `↺ LOOP in ${(upcoming.orig - pos).toFixed(1)} s · back ${(upcoming.orig - upcoming.dest).toFixed(1)} s`);
    const xp = X(pos);
    g.fillStyle = '#fff'; g.fillRect(xp - 1.5, top - 6, 3, laneH + 12); g.beginPath(); g.arc(xp, mid, 7, 0, Math.PI * 2); g.fill();
    g.font = '700 11px "Roboto Mono", monospace'; g.textBaseline = 'alphabetic';
    g.fillStyle = working ? '#ffd166' : 'rgba(255,255,255,0.5)';
    g.fillText(working ? '● SET IN PROGRESS' : 'RESTING', L, H - 8);
    if (alert) { g.fillStyle = '#ff7a6e'; g.font = '800 13px Inter, sans-serif'; g.fillText('⚠ the drop ended mid-set', L + 150, H - 8); }
  }
}

// MARingBA's first step, drawn live from the playing song: music → MIR → beat, key, structure.
export class MirFigure {
  constructor(c) { this.c = c; this.g = c.getContext('2d'); this.env = null; }
  fit() {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (this.c.width !== Math.round(r.width * d) || this.c.height !== Math.round(r.height * d)) { this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); }
    this.g.setTransform(d, 0, 0, d, 0, 0); this.w = r.width; this.h = r.height;
  }
  envelope(song) {
    if (this.env && this.env.song === song) return this.env;
    const a = song.acc.getChannelData(0), v = song.vocals.getChannelData(0), sr = song.acc.sampleRate, hop = Math.round(sr * 0.02);
    const e = new Float32Array(Math.floor(a.length / hop));
    for (let i = 0; i < e.length; i++) { let m = 0; for (let j = i * hop; j < (i + 1) * hop; j += 8) m = Math.max(m, Math.abs(a[j] + (v[j] || 0))); e[i] = m; }
    return (this.env = { song, e, hop: 0.02 });
  }
  draw({ song, t, keyName, scale }) {
    this.fit();
    const g = this.g, W = this.w, H = this.h, A = song.analysis;
    g.clearRect(0, 0, W, H);
    const font = (w, s) => `${w} ${s}px Inter, system-ui, sans-serif`;
    const mono = (s) => `600 ${s}px "Roboto Mono", monospace`;
    // left: the music, a scrolling waveform around the playhead
    const lx = 8, lw = W * 0.3, cy = H / 2, env = this.envelope(song);
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = mono(10); g.fillText('MUSIC', lx, 18);
    const span = 4, i0 = Math.floor((t - span / 2) / env.hop);
    for (let k = 0; k < lw / 2; k++) {
      const i = i0 + Math.floor((k / (lw / 2)) * (span / env.hop)), m = env.e[Math.max(0, Math.min(env.e.length - 1, i))] || 0;
      const h = Math.max(1, m * (H * 0.55));
      g.fillStyle = k < lw / 4 ? '#ff9f5a' : 'rgba(255,159,90,0.45)'; g.fillRect(lx + k * 2, cy - h / 2, 1.4, h);
    }
    g.fillStyle = '#fff'; g.fillRect(lx + lw / 2 - 1, cy - H * 0.32, 2, H * 0.64);
    // arrow → MIR → arrows
    const bx = lx + lw + 22, bw = Math.max(W * 0.14, 92), bh = 62, by = cy - bh / 2;
    const arrow = (x0, y0, x1, y1) => { g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      const a = Math.atan2(y1 - y0, x1 - x0); g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - 8 * Math.cos(a - 0.4), y1 - 8 * Math.sin(a - 0.4)); g.lineTo(x1 - 8 * Math.cos(a + 0.4), y1 - 8 * Math.sin(a + 0.4)); g.fill(); };
    arrow(lx + lw + 2, cy, bx - 4, cy);
    g.fillStyle = '#2fae74'; rr(g, bx, by, bw, bh, 10); g.fill();
    g.fillStyle = '#0b0b12'; g.font = font(900, 18); g.textAlign = 'center'; g.fillText('MIR', bx + bw / 2, cy - 4);
    g.font = mono(8.5); g.fillText('music information', bx + bw / 2, cy + 12); g.fillText('retrieval', bx + bw / 2, cy + 23); g.textAlign = 'left';
    // right: three outputs
    const rx = bx + bw + 30, rw = W - rx - 8, rows = [cy - H * 0.3, cy, cy + H * 0.3];
    rows.forEach((y) => arrow(bx + bw + 2, cy, rx - 6, y));
    const label = (txt, y) => { g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = mono(10); g.fillText(txt, rx, y - 14); };
    // beat: beats in the next few seconds, the current one lit
    label('BEAT', rows[0]);
    const beats = A.beats; let cur = 0; while (cur + 1 < beats.length && beats[cur + 1] <= t) cur++;
    const ph = Math.min(1, (t - beats[cur]) / A.beatDur);
    for (let k = -2; k < 14; k++) {
      const i = cur + k; if (i < 0 || i >= beats.length) continue;
      const x = rx + 8 + (k + 2) * (rw - 16) / 15, down = A.isDown[i];
      const on = k === 0, r = (down ? 6 : 4) + (on ? 4 * (1 - ph) : 0);
      g.fillStyle = on ? '#ffd166' : k < 0 ? 'rgba(255,255,255,0.2)' : down ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.4)';
      g.beginPath(); g.arc(x, rows[0] + 4, r, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = font(700, 11); g.textAlign = 'right'; g.fillText(`${Math.round(60 / A.beatDur)} BPM`, rx + rw, rows[0] - 14); g.textAlign = 'left';
    // key: one octave keyboard with the song's scale lit
    label('KEY', rows[1]);
    const kw = Math.min(16, (rw - 110) / 7), white = [0, 2, 4, 5, 7, 9, 11], kx = rx, ky = rows[1] - 6;
    white.forEach((pc, i) => { g.fillStyle = scale.includes(pc) ? '#ffd166' : '#e8e8f0'; g.fillRect(kx + i * kw, ky, kw - 1.5, 26); });
    [1, 3, 6, 8, 10].forEach((pc) => { const i = [0, 1, 3, 4, 5][[1, 3, 6, 8, 10].indexOf(pc)]; g.fillStyle = scale.includes(pc) ? '#e8a33d' : '#22223a'; g.fillRect(kx + (i + 1) * kw - kw * 0.3, ky, kw * 0.6, 16); });
    g.fillStyle = '#fff'; g.font = font(800, 15); g.fillText(keyName, kx + 7 * kw + 12, rows[1] + 12);
    // structure: 4-bar phrases across the whole song, the current one lit
    label('STRUCTURE · 4-bar phrases', rows[2]);
    const P = A.phraseIdx.map((i) => beats[i]).concat([song.duration]), X = (s) => rx + (s / song.duration) * rw;
    for (let i = 0; i + 1 < P.length; i++) {
      const on = t >= P[i] && t < P[i + 1];
      g.fillStyle = on ? '#ffd166' : i % 2 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.18)';
      rr(g, X(P[i]) + 1, rows[2] - 4, Math.max(2, X(P[i + 1]) - X(P[i]) - 2), 18, 3); g.fill();
    }
    g.fillStyle = '#fff'; g.fillRect(X(t) - 1, rows[2] - 8, 2, 26);
  }
}

// MultiVerse: the C³ Venn diagram (interactive) next to the lyric being adapted.
// Hover a region to see which kind of system covers it (from the UIST '26 talk); during the
// walkthrough the circles light up as the songwriter adds each kind of control.
const C3 = {
  creator: { name: 'CREATOR', col: '#f07a1c', x: 0.5, y: 0.66 },
  content: { name: 'CONTENT', col: '#e0384f', x: 0.32, y: 0.36 },
  context: { name: 'CONTEXT', col: '#1fa4b8', x: 0.68, y: 0.36 },
};
const REGIONS = {
  creator: ['Creator', 'The artist’s intent: theme, style, words that matter'],
  content: ['Content', 'The media’s structure: rhyme, syllables, meter'],
  context: ['Context', 'The listener: who they are, what they’re going through'],
  'content+context': ['Automatic adaptive media', 'Adapts to the listener, but the artist has no say · e.g. SoundsRide (UIST ’21)'],
  'content+creator': ['Creator-authored static media', 'The artist is in control, but there is one fixed version · e.g. Promptify (UIST ’23)'],
  'context+creator': ['Creator-authored adaptive interfaces', 'Adapts to context, but it’s the interface, not the media · e.g. AUIT (UIST ’22)'],
  'content+context+creator': ['⭐ Creator-authored adaptive media', 'MultiVerse: the artist authors how the media adapts to each listener'],
};
export class MvPanel {
  constructor(root) {
    this.root = root;
    root.innerHTML = `<div class="mv-venn"><canvas></canvas><div class="mv-info"><b></b><span></span></div></div>
      <div class="mv-lyr"><div class="mv-who"></div><div class="mv-persona" hidden><button class="mv-pbtn"></button><dl class="mv-pfacts" hidden></dl></div><div class="mv-orig"></div><div class="mv-new"></div><ul class="mv-ctl"></ul></div>`;
    this.c = root.querySelector('canvas'); this.g = this.c.getContext('2d');
    this.info = root.querySelector('.mv-info');
    this.active = new Set(); this.hover = null; this.pinned = null; this.flash = 0;
    this.c.addEventListener('pointermove', (e) => { this.hover = this.regionAt(e); });
    this.c.addEventListener('pointerleave', () => { this.hover = null; });
    this.showInfo(null);
  }
  geom() {
    const W = this.w, H = this.h, s = Math.min(W, H), r = s * 0.27;
    const pts = {};
    for (const [k, v] of Object.entries(C3)) pts[k] = { x: (W - s) / 2 + v.x * s, y: (H - s) / 2 + v.y * s + 4, r };
    return pts;
  }
  regionAt(e) {
    const b = this.c.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, P = this.geom();
    const inn = Object.keys(C3).filter((k) => Math.hypot(x - P[k].x, y - P[k].y) < P[k].r).sort();
    return inn.length ? inn.join('+') : null;
  }
  showInfo(key) {
    const [t, d] = key ? REGIONS[key] : ['C³: creator · content · context', 'Hover the diagram'];
    this.info.querySelector('b').textContent = t; this.info.querySelector('span').textContent = d;
    this.info.classList.toggle('star', key === 'content+context+creator');
  }
  // step: { who, orig, lines: [html, html], controls: [[dim, text]], active: [dims] }
  set(step) {
    const q = (s) => this.root.querySelector(s);
    q('.mv-who').innerHTML = step.who || '';
    // the listener's simulated profile: a chip that opens to show what the system knows
    const pc = q('.mv-persona'), pf = q('.mv-pfacts'), pb = q('.mv-pbtn');
    pc.hidden = !step.persona;
    if (step.persona) {
      const P = step.persona;
      pb.innerHTML = `<i>${P.name[0]}</i><span><b>${P.name}</b>${P.line}</span><em>${pf.hidden ? 'profile ▸' : 'profile ▾'}</em>`;
      pf.innerHTML = P.facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      pb.onclick = () => { pf.hidden = !pf.hidden; pb.querySelector('em').textContent = pf.hidden ? 'profile ▸' : 'profile ▾'; };
    }
    q('.mv-orig').innerHTML = step.orig || '';
    q('.mv-new').innerHTML = (step.lines || []).map((l) => `<div>${l}</div>`).join('');
    q('.mv-new').className = 'mv-new ' + (step.tone || '');
    q('.mv-ctl').innerHTML = (step.controls || []).map(([d, t]) => `<li style="--c:${C3[d].col}"><i>${C3[d].name}</i>${t}</li>`).join('');
    this.active = new Set(step.active || []);
    this.flash = performance.now();
    q('.mv-new').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
  }
  fit() {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (this.c.width !== Math.round(r.width * d) || this.c.height !== Math.round(r.height * d)) { this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); }
    this.g.setTransform(d, 0, 0, d, 0, 0); this.w = r.width; this.h = r.height;
  }
  draw(t) {
    if (!this.root.classList.contains('on')) return;
    this.fit();
    const g = this.g, P = this.geom(), keys = Object.keys(C3);
    g.clearRect(0, 0, this.w, this.h);
    const sel = this.pinned || this.hover;
    this.showInfo(sel);
    const circle = (k) => { g.beginPath(); g.arc(P[k].x, P[k].y, P[k].r, 0, Math.PI * 2); };
    // fills: lit circles (walkthrough), then the hovered region
    const pop = Math.min(1, (performance.now() - this.flash) / 500);
    for (const k of keys) if (this.active.has(k)) { g.globalAlpha = 0.28 * pop; g.fillStyle = C3[k].col; circle(k); g.fill(); }
    g.globalAlpha = 1;
    if (sel) {
      // the region alone (inside its circles, outside the others), drawn offscreen then laid on top
      const ins = sel.split('+'), outs = keys.filter((k) => !ins.includes(k));
      const o = this.off || (this.off = document.createElement('canvas'));
      if (o.width !== this.c.width || o.height !== this.c.height) { o.width = this.c.width; o.height = this.c.height; }
      const h = o.getContext('2d'), d = this.c.width / this.w;
      h.setTransform(d, 0, 0, d, 0, 0); h.clearRect(0, 0, this.w, this.h);
      h.save();
      for (const k of ins) { h.beginPath(); h.arc(P[k].x, P[k].y, P[k].r, 0, Math.PI * 2); h.clip(); }
      h.fillStyle = sel === 'content+context+creator' ? '#ffd166' : 'rgba(255,255,255,0.8)';
      h.fillRect(0, 0, this.w, this.h);
      h.globalCompositeOperation = 'destination-out';
      for (const k of outs) { h.beginPath(); h.arc(P[k].x, P[k].y, P[k].r, 0, Math.PI * 2); h.fill(); }
      h.restore();
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(o, 0, 0); g.restore();
    }
    for (const k of keys) {
      const on = this.active.has(k);
      g.lineWidth = on ? 3 : 2; g.strokeStyle = on ? C3[k].col : 'rgba(255,255,255,0.55)';
      circle(k); g.stroke();
    }
    // labels pushed to the outer side of each circle
    g.font = '800 12px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const cx = this.w / 2, cy = (P.content.y + P.context.y + P.creator.y) / 3;
    for (const k of keys) {
      const dx = P[k].x - cx, dy = P[k].y - cy, n = Math.hypot(dx, dy) || 1;
      const lx = P[k].x + (dx / n) * P[k].r * 0.42, ly = P[k].y + (dy / n) * P[k].r * 0.42;
      g.fillStyle = sel && sel.split('+').includes(k) && sel.indexOf('+') < 0 ? '#0e0e17' : C3[k].col;
      g.fillText(C3[k].name, lx, ly);
    }
    // the centre: where MultiVerse sits
    const all = this.active.size === 3;
    g.font = `${all ? 18 : 13}px sans-serif`; g.globalAlpha = all ? 1 : 0.5;
    g.fillText('⭐', cx, cy + 2 + (all ? Math.sin(t * 4) * 1.5 : 0));
    g.globalAlpha = 1; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }
}


// ---------------------------------------------------------------- animated paper figures
// Redrawn versions of the paper figures, in the same live style as the MIR figure. Each loops.
class AnimFig {
  constructor(c) { this.c = c; this.g = c.getContext('2d'); }
  fit() {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (this.c.width !== Math.round(r.width * d) || this.c.height !== Math.round(r.height * d)) { this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); }
    this.g.setTransform(d, 0, 0, d, 0, 0); this.w = r.width; this.h = r.height;
    this.g.clearRect(0, 0, this.w, this.h);
  }
  text(s, x, y, { size = 11, w = 700, col = '#fff', mono = false, align = 'left' } = {}) {
    const g = this.g; g.font = mono ? `600 ${size}px "Roboto Mono", monospace` : `${w} ${size}px Inter, system-ui, sans-serif`;
    g.fillStyle = col; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(s, x, y); g.textAlign = 'left';
  }
}
const GOOD = '#5fd38a', BAD = '#ff6b5e', HOT = '#ff9f5a', GOLD = '#ffd166';
const LOOPC = '#ff4d5e', SKIPC = '#5cc8ff'; // loop red, skip blue, as in the RISE paper

// MARingBA: a ringtone at its own tempo drifts off the song's beats; stretched to the song's
// tempo, every note lands on a beat.
export class BeatMatchFig extends AnimFig {
  draw(t) {
    this.fit();
    const g = this.g, W = this.w, H = this.h, L = 196, R = W - 12, beats = 8, cyc = 4.8;
    const ph = (t % (cyc + 0.8)) / cyc, head = L + Math.min(1, ph) * (R - L);
    const bx = (i) => L + (i / beats) * (R - L);
    const rows = [{ y: 92, name: 'Without beat matching', cap: 'Onsets misaligned', col: BAD, step: 0.74, off: 0.3 }, { y: 182, name: 'With beat matching', cap: 'Notes land on the beats', col: GOOD, step: 1, off: 0 }];
    // the song's beats, shared by both rows
    this.text('MUSIC · BEATS', 12, 22, { size: 10, mono: true, col: 'rgba(255,255,255,0.5)' });
    for (let i = 0; i <= beats; i++) {
      const x = bx(i), hit = Math.abs(head - x) < 7;
      g.fillStyle = hit ? '#fff' : i % 4 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.2)';
      g.fillRect(x - (i % 4 === 0 ? 1 : 0.5), 32, i % 4 === 0 ? 2 : 1, H - 46);
      g.beginPath(); g.arc(x, 26, hit ? 6 : 3.5, 0, Math.PI * 2); g.fill();
    }
    for (const r of rows) {
      this.text(r.name, 12, r.y - 6, { size: 13, w: 800 });
      this.text(r.cap, 12, r.y + 12, { size: 11, w: 700, col: r.col });
      // ringtone notes: a fixed rhythm in the ringtone's own beat unit
      const pat = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      for (const k of pat) {
        const pos = r.off + k * r.step; if (pos > beats - 0.2) break;
        const x = bx(pos), w = Math.max(10, (r.step * 0.62) * (R - L) / beats), played = head >= x;
        const near = Math.round(pos), dx = bx(near) - x;
        g.globalAlpha = played ? 1 : 0.45;
        g.fillStyle = HOT; rr(g, x, r.y - 14, w, 22, 5); g.fill();
        g.globalAlpha = 1;
        // onset marker: on the beat or off it
        const flash = played && head - x < 26;
        if (Math.abs(dx) > 2) {
          g.strokeStyle = BAD; g.lineWidth = 2; g.setLineDash([3, 3]);
          g.beginPath(); g.moveTo(x, r.y + 14); g.lineTo(bx(near), r.y + 14); g.stroke(); g.setLineDash([]);
          if (flash) { g.fillStyle = BAD; g.beginPath(); g.arc(x, r.y - 22, 5, 0, Math.PI * 2); g.fill(); }
        } else if (flash) { g.fillStyle = GOOD; g.beginPath(); g.arc(x, r.y - 22, 5, 0, Math.PI * 2); g.fill(); }
      }
    }
    g.fillStyle = GOLD; g.fillRect(head - 1, 32, 2, H - 46);
  }
}

// Music-aware voice agent: the same syllables sung on the song's original melody (stretched or
// crammed) and on a melody generated to follow the speech's prosody (each note on a syllable).
const SYL = [['New', 0.007, 0.203], ['ca', 0.203, 0.444], ['len', 0.444, 0.579], ['dar', 0.579, 0.712], ['in', 0.712, 0.868], ['vite', 0.868, 1.12], ['from', 1.12, 1.29], ['A', 1.29, 1.467], ['lex', 1.467, 1.765]];
const ORIG_MEL = [[0, 0.4, 5], [0.4, 0.6, 7], [0.6, 0.8, 8], [0.8, 1.0, 7], [1.0, 1.1, 5], [1.1, 1.2, 4], [1.2, 1.3, 5], [1.3, 1.4, 3], [1.4, 1.77, 2]];
const PRO_MEL = [4, 6, 5, 4, 5, 7, 6, 5, 3];
export class ProsodyFig extends AnimFig {
  draw(t) {
    this.fit();
    const g = this.g, W = this.w, H = this.h, L = 178, R = W - 12, T = 1.8, cyc = 3.6;
    const ph = (t % (cyc + 0.8)) / cyc, now = Math.min(1, ph) * T, X = (s) => L + (s / T) * (R - L);
    const lanes = [{ y: 40, name: 'SPEECH', sub: 'spoken syllables' }, { y: 120, name: 'Original melody', sub: 'Stretched or crammed', col: BAD }, { y: 205, name: 'Prosody-conditioned', sub: 'Speech rhythm kept', col: GOOD }];
    // spoken syllables
    this.text('SPEECH PROSODY', 12, 36, { size: 10, mono: true, col: 'rgba(255,255,255,0.5)' });
    this.text('“New calendar invite', 12, 52, { size: 11, w: 600, col: 'rgba(255,255,255,0.75)' }); this.text('from Alex”', 12, 66, { size: 11, w: 600, col: 'rgba(255,255,255,0.75)' });
    SYL.forEach(([s, a, b]) => {
      const on = now >= a && now < b;
      g.fillStyle = on ? GOLD : 'rgba(255,255,255,0.16)'; rr(g, X(a) + 1, 28, X(b) - X(a) - 2, 24, 5); g.fill();
      this.text(s, (X(a) + X(b)) / 2, 45, { size: 11, w: 800, col: on ? '#0e0e17' : '#fff', align: 'center' });
    });
    const lane = (y, notes, name, sub, col, good) => {
      this.text(name, 12, y - 8, { size: 13, w: 800 });
      this.text(sub, 12, y + 9, { size: 11, w: 700, col });
      g.fillStyle = 'rgba(255,255,255,0.05)'; rr(g, L - 4, y - 34, R - L + 8, 58, 6); g.fill();
      notes.forEach(([a, b, p], i) => {
        const ny = y + 16 - p * 5.4, on = now >= a && now < b;
        // connector from the spoken syllable to the note it is sung on
        const [, sa, sb] = SYL[i], sx = (X(sa) + X(sb)) / 2, nx = (X(a) + X(b)) / 2;
        g.strokeStyle = good ? 'rgba(95,211,138,0.35)' : Math.abs(sx - nx) > 6 || Math.abs((sb - sa) - (b - a)) > 0.06 ? 'rgba(255,107,94,0.55)' : 'rgba(255,255,255,0.2)';
        g.lineWidth = 1.2; g.beginPath(); g.moveTo(sx, 54); g.lineTo(nx, ny - 2); g.stroke();
        g.fillStyle = on ? GOLD : good ? GOOD : '#e0479e'; rr(g, X(a) + 1, ny - 7, Math.max(4, X(b) - X(a) - 2), 9, 3); g.fill();
        this.text(SYL[i][0], X(a) + 3, ny - 10, { size: 9.5, w: 700, col: on ? GOLD : 'rgba(255,255,255,0.8)' });
      });
    };
    lane(lanes[1].y, ORIG_MEL, lanes[1].name, lanes[1].sub, BAD, false);
    lane(lanes[2].y, SYL.map(([, a, b], i) => [a, b, PRO_MEL[i]]), lanes[2].name, lanes[2].sub, GOOD, true);
    g.fillStyle = '#fff'; g.fillRect(X(now) - 1, 24, 2, H - 30);
  }
}

// RISE: a loop jumps back to an earlier beat (B plays twice); a skip jumps ahead (B is left out).
export class CutFig extends AnimFig {
  draw(t) {
    this.fit();
    const g = this.g, W = this.w, H = this.h, cyc = 5;
    const ph = Math.min(1, (t % (cyc + 1)) / cyc);
    const half = (x0, w, kind) => {
      const loop = kind === 'loop', order = loop ? ['A', 'B', 'B', 'C'] : ['A', 'C'];
      const bw = w * 0.15, ox = x0 + (w - 3 * bw) / 2, pos = { A: ox, B: ox + bw, C: ox + 2 * bw }, y1 = 70, y2 = 170, bh = 34;
      this.text(loop ? 'Jump back to an earlier beat' : 'Jump ahead to a later beat', x0 + w / 2, 22, { size: 12.5, w: 800, col: HOT, align: 'center' });
      const wave = (y, xa, xb, seed) => { g.fillStyle = 'rgba(126,196,255,0.55)'; for (let x = xa; x < xb; x += 3) { const a = 6 + 5 * Math.abs(Math.sin(x * 0.37 + seed) * Math.cos(x * 0.11)); g.fillRect(x, y + bh / 2 - a, 2, a * 2); } };
      // original song: calm, then the high-energy A B C, then calm
      wave(y1, x0 + 6, ox, 1); wave(y1, ox + 3 * bw, x0 + w - 6, 2);
      for (const k of ['A', 'B', 'C']) { g.fillStyle = '#e8402f'; rr(g, pos[k] + 1, y1, bw - 2, bh, 4); g.fill(); this.text(k, pos[k] + bw / 2, y1 + 23, { size: 15, w: 900, col: '#fff', align: 'center' }); }
      // where the playhead is in the played order
      const n = order.length, f = ph * n, i = Math.min(n - 1, Math.floor(f)), frac = Math.min(1, f - i);
      const px = pos[order[i]] + frac * bw;
      g.fillStyle = GOLD; g.fillRect(px - 1, y1 - 8, 2, bh + 16);
      // the jump, drawn as an arc once it's been taken
      const jumpAt = loop ? 2 : 1;
      if (f >= jumpAt - 0.15) {
        const xs = loop ? pos.B + bw : pos.A + bw, xd = loop ? pos.B : pos.C, a = Math.min(1, (f - (jumpAt - 0.15)) / 0.3);
        g.strokeStyle = GOLD; g.lineWidth = 2.5; g.beginPath();
        const steps = 24; for (let s = 0; s <= steps * a; s++) { const u = s / steps, x = xs + (xd - xs) * u, y = y1 - 10 - Math.sin(u * Math.PI) * 26; s ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      }
      // what is heard: the played blocks build up below
      const total = n * bw, sx = x0 + (w - total) / 2;
      this.text('played', x0 + 8, y2 - 10, { size: 10, mono: true, col: 'rgba(255,255,255,0.45)' });
      wave(y2, x0 + 6, sx, 3); wave(y2, sx + total, x0 + w - 6, 4);
      for (let k = 0; k < n; k++) {
        const fill = k < i ? 1 : k === i ? frac : 0; if (fill <= 0) continue;
        const rep = loop && k === 2;
        g.fillStyle = rep ? '#d23bd6' : '#e8402f'; rr(g, sx + k * bw + 1, y2, Math.max(2, bw * fill - 2), bh, 4); g.fill();
        if (fill > 0.5) this.text(order[k], sx + k * bw + bw / 2, y2 + 23, { size: 15, w: 900, col: '#fff', align: 'center' });
      }
      this.text(loop ? 'Loop: section extended' : 'Skip: section shortened', x0 + w / 2, H - 12, { size: 13.5, w: 900, align: 'center' });
    };
    half(0, W / 2 - 6, 'loop');
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(W / 2 - 1, 16, 1.5, H - 30);
    half(W / 2 + 6, W / 2 - 6, 'skip');
  }
}

// MARingBA user study (CHI '24, §7.5): reaction time by delivery method, notifications detected,
// and the distraction finding. Numbers as reported in the paper; medium urgency's mean reaction
// time isn't reported there, so it isn't drawn.
export class StudyFig extends AnimFig {
  draw(t) {
    this.fit();
    const g = this.g, W = this.w, H = this.h;
    if (this.t0 == null) this.t0 = t;
    const k = Math.min(1, (t - this.t0) / 1.2), e = 1 - Math.pow(1 - k, 3);
    this.text('REACTION TIME', 14, 20, { size: 10, mono: true, col: 'rgba(255,255,255,0.55)' });
    this.text('mean seconds from ringtone to response', 14, 34, { size: 10.5, w: 600, col: 'rgba(255,255,255,0.45)' });
    // bars: standard delivery vs. MARingBA's high- and low-urgency settings (CHI '24, §7.5.2)
    const rt = [['Standard', 16.29, '#9aa0b4'], ['High urgency', 20.29, '#ff6b5e'], ['Low urgency', 34.33, '#7ec4ff']];
    const L = 60, R = W - 30, base = H - 30, top = 92, max = 36, bw = (R - L) / rt.length;
    const cx = (i) => L + bw * i + bw / 2, ytop = (v) => base - ((base - top) * v / max) * e;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (const v of [0, 10, 20, 30]) { const y = base - (base - top) * v / max; g.beginPath(); g.moveTo(L - 6, y); g.lineTo(R, y); g.stroke(); this.text(`${v} s`, L - 10, y + 4, { size: 10, w: 600, col: 'rgba(255,255,255,0.45)', align: 'right' }); }
    rt.forEach(([name, v, col], i) => {
      const w = Math.min(90, bw - 40), x = cx(i) - w / 2, y = ytop(v);
      g.fillStyle = col; rr(g, x, y, w, base - y, 5); g.fill();
      this.text(`${(v * e).toFixed(1)} s`, cx(i), y - 7, { size: 12.5, w: 800, align: 'center' });
      this.text(name, cx(i), base + 17, { size: 11, w: 700, col: 'rgba(255,255,255,0.85)', align: 'center' });
    });
    // significance brackets: standard vs. low (p < .001), high vs. low (p < .012)
    const sig = Math.max(0, Math.min(1, (t - this.t0 - 1.1) / 0.4));
    if (sig > 0) {
      g.globalAlpha = sig;
      const br = (a, b, y, mark) => {
        g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath();
        g.moveTo(cx(a), y + 6); g.lineTo(cx(a), y); g.lineTo(cx(b), y); g.lineTo(cx(b), y + 6); g.stroke();
        this.text(mark, (cx(a) + cx(b)) / 2, y - 4, { size: 14, w: 900, col: GOLD, align: 'center' });
      };
      const yl = ytop(34.33) - 26;
      br(1, 2, yl, '*');
      br(0, 2, yl - 22, '***');
      g.globalAlpha = 1;
      this.text('* p < .05   *** p < .001', R, 20, { size: 10.5, w: 700, col: 'rgba(255,255,255,0.55)', align: 'right' });
    }
  }
}

// Music-aware voice agent (UIST '24): word error rate of the sung message, transcribed by ASR,
// with and without prosody conditioning (as reported on the poster).
export class WerFig extends AnimFig {
  draw(t) {
    this.fit();
    const g = this.g, W = this.w, H = this.h;
    if (this.t0 == null) this.t0 = t;
    const k = Math.min(1, (t - this.t0) / 1.0), e = 1 - Math.pow(1 - k, 3);
    this.text('WORD ERROR RATE', 14, 20, { size: 10, mono: true, col: 'rgba(255,255,255,0.55)' });
    this.text('of the sung message, transcribed by speech recognition · lower is better', 14, 34, { size: 10.5, w: 600, col: 'rgba(255,255,255,0.45)' });
    // an illustrative transcript of “New calendar invite from Alex” under each; misheard words in red
    const cols = [
      ['Without prosody conditioning', 15, BAD, [['New', 1], ['Kelly', 0], ['and her', 0], ['invite', 1], ['from', 1], ['a lake', 0]]],
      ['With prosody conditioning', 2, GOOD, [['New', 1], ['calendar', 1], ['invite', 1], ['from', 1], ['Alex', 1]]],
    ];
    const show = Math.max(0, Math.min(1, (t - this.t0 - 1.1) / 0.5));
    cols.forEach(([name, v, col, words], i) => {
      const cx = W * (0.26 + i * 0.48);
      this.text(`${Math.round(v * e)}%`, cx, 112, { size: 58, w: 900, col, align: 'center' });
      this.text(name, cx, 138, { size: 12.5, w: 800, align: 'center' });
      if (!show) return;
      g.globalAlpha = show;
      this.text('heard as', cx, 172, { size: 10, mono: true, col: 'rgba(255,255,255,0.45)', align: 'center' });
      g.font = '700 14px Inter, system-ui, sans-serif';
      const parts = words.map(([w2]) => w2), widths = parts.map((p2) => g.measureText(p2).width), gap = 6;
      let x = cx - (widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1)) / 2 - 6;
      this.text('“', x, 196, { size: 14, w: 700, col: 'rgba(255,255,255,0.6)' }); x += 6;
      words.forEach(([w2, ok], n) => {
        this.text(w2, x, 196, { size: 14, w: 700, col: ok ? '#fff' : BAD });
        if (!ok) { g.fillStyle = BAD; g.fillRect(x, 199, widths[n], 1.5); }
        x += widths[n] + gap;
      });
      this.text('”', x - gap, 196, { size: 14, w: 700, col: 'rgba(255,255,255,0.6)' });
      g.globalAlpha = 1;
    });
    if (show) this.text('Example transcripts are illustrative', W - 14, H - 10, { size: 10, w: 600, col: 'rgba(255,255,255,0.35)', align: 'right' });
  }
}

// RISE skip showcase: the same stretch of song twice, as written (top) and with RISE's skip
// (bottom, the skipped stretch hatched under an arc). Each lane has its own play button.
export class SkipFig extends AnimFig {
  draw(t, o) {
    this.fit();
    const g = this.g, W = this.w, H = this.h, L = 150, R = W - 14;
    const X = (s) => L + ((s - o.from) / (o.to - o.from)) * (R - L);
    const lanes = [{ y: 46, name: 'As written', sub: `energy back after ${(o.hiAt - o.start).toFixed(0)} s` }, { y: 150, name: 'With RISE skip', sub: `energy back after ${(o.hiAt - o.start - (o.cut.dest - o.cut.orig)).toFixed(0)} s` }];
    const h = 46;
    lanes.forEach((ln, li) => {
      for (const sg of o.segs) {
        const x0 = Math.max(L, X(sg.start)), x1 = Math.min(R, X(sg.end)); if (x1 <= x0) continue;
        const grd = g.createLinearGradient(0, ln.y, 0, ln.y + h);
        if (sg.high) { grd.addColorStop(0, '#ff8a3d'); grd.addColorStop(1, '#a3183a'); } else { grd.addColorStop(0, '#1b2f55'); grd.addColorStop(1, '#0c1630'); }
        g.fillStyle = grd; g.fillRect(x0, ln.y, x1 - x0, h);
        if (x1 - x0 > 70) this.text(sg.high ? '🔥 HIGH ENERGY' : '〰 calm', x0 + 6, ln.y + h - 7, { size: 10.5, w: 800, col: sg.high ? '#fff' : 'rgba(170,205,255,0.9)' });
      }
      // start of the comparison
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(X(o.start) - 0.5, ln.y - 4, 1, h + 8);
      if (li === 1) {
        // the skipped stretch: hatched, with an arc over it
        const xa = X(o.cut.orig), xb = X(o.cut.dest);
        g.save(); g.beginPath(); g.rect(xa, ln.y, xb - xa, h); g.clip();
        g.fillStyle = 'rgba(14,14,23,0.7)'; g.fillRect(xa, ln.y, xb - xa, h);
        g.strokeStyle = 'rgba(92,200,255,0.55)'; g.lineWidth = 1.5;
        for (let x = xa - h; x < xb; x += 7) { g.beginPath(); g.moveTo(x, ln.y + h); g.lineTo(x + h, ln.y); g.stroke(); }
        g.restore();
        g.strokeStyle = SKIPC; g.lineWidth = 2.5; g.beginPath(); g.moveTo(xa, ln.y - 2); g.bezierCurveTo(xa, ln.y - 30, xb, ln.y - 30, xb, ln.y - 2); g.stroke();
        g.fillStyle = SKIPC; g.beginPath(); g.moveTo(xb, ln.y); g.lineTo(xb - 6, ln.y - 9); g.lineTo(xb + 6, ln.y - 9); g.fill();
        this.text(`⤼ skip +${(o.cut.dest - o.cut.orig).toFixed(1)} s`, (xa + xb) / 2, ln.y - 26, { size: 11, w: 800, col: SKIPC, align: 'center' });
      }
      this.text(ln.sub, R, ln.y + h + 16, { size: 11, w: 700, col: li ? SKIPC : 'rgba(255,255,255,0.6)', align: 'right' });
      // playhead for the lane being played
      if (o.play && o.play.lane === li && o.pos != null) {
        const x = X(o.pos);
        g.fillStyle = '#fff'; g.fillRect(x - 1.5, ln.y - 6, 3, h + 12); g.beginPath(); g.arc(x, ln.y + h / 2, 6, 0, Math.PI * 2); g.fill();
      }
    });
  }
}


// RISE cutpoints, played for real: the drop of a song split at two matching beats into A | B | C.
// Loop jumps back from the end of B to its start (A B B C); skip jumps over B (A C).
export class CutPlayFig extends AnimFig {
  draw(t, o) {
    this.fit();
    const g = this.g, W = this.w, H = this.h, L = 150, R = W - 14, D = o.drop;
    const from = D.start - 2, to = D.end + 3, X = (s) => L + ((s - from) / (to - from)) * (R - L), h = 34, ph = 22;
    const A = D.x - D.start, Bl = D.y - D.x, C = D.end - D.y;
    const SC = (R - L) / (A + 2 * Bl + C);   // one scale for both "played" tracks, so lengths compare
    const block = (x, w, y, hh, k, col, alpha = 1) => {
      g.globalAlpha = alpha;
      const grd = g.createLinearGradient(0, y, 0, y + hh);
      if (col) { grd.addColorStop(0, col); grd.addColorStop(1, col); } else { grd.addColorStop(0, '#ff8a3d'); grd.addColorStop(1, '#a3183a'); }
      g.fillStyle = grd; rr(g, x + 1, y, Math.max(2, w - 2), hh, 4); g.fill(); g.globalAlpha = 1;
      if (w > 18) this.text(k, x + w / 2, y + hh / 2 + 5, { size: hh > 26 ? 16 : 13, w: 900, align: 'center', col: alpha < 1 ? 'rgba(255,255,255,0.5)' : '#fff' });
    };
    const lanes = [{ y: 52, loop: true, cap: 'Loop: drop extended', col: LOOPC }, { y: 196, loop: false, cap: 'Skip: drop shortened', col: SKIPC }];
    lanes.forEach((ln, li) => {
      const playing = o.play && o.play.lane === li + 2 && o.pos != null;
      // the song: calm, then the drop split into A B C
      g.fillStyle = '#13213f'; g.fillRect(X(from), ln.y, X(to) - X(from), h);
      for (const [k, a, b] of [['A', D.start, D.x], ['B', D.x, D.y], ['C', D.y, D.end]]) block(X(a), X(b) - X(a), ln.y, h, k, null, k === 'B' && !ln.loop ? 0.35 : 1);
      const xa = X(D.x), xb = X(D.y);
      g.strokeStyle = ln.col; g.lineWidth = 2.5; g.beginPath(); g.moveTo(ln.loop ? xb : xa, ln.y - 2); g.bezierCurveTo(ln.loop ? xb : xa, ln.y - 26, ln.loop ? xa : xb, ln.y - 26, ln.loop ? xa : xb, ln.y - 2); g.stroke();
      const xh = ln.loop ? xa : xb; g.fillStyle = ln.col; g.beginPath(); g.moveTo(xh, ln.y); g.lineTo(xh - 6, ln.y - 9); g.lineTo(xh + 6, ln.y - 9); g.fill();
      this.text(ln.loop ? `↺ back ${Bl.toFixed(1)} s` : `⤼ ahead ${Bl.toFixed(1)} s`, (xa + xb) / 2, ln.y - 22, { size: 11, w: 800, col: ln.col, align: 'center' });
      if (playing) { const x = X(o.pos); g.fillStyle = '#fff'; g.fillRect(x - 1.5, ln.y - 5, 3, h + 10); }
      // what is actually heard: A B B C (second B in purple) or A C
      const py = ln.y + h + 26;
      this.text('played', L - 8, py + 15, { size: 10, mono: true, col: 'rgba(255,255,255,0.5)', align: 'right' });
      const seq = ln.loop ? [['A', A, null], ['B', Bl, null], ['B', Bl, '#b04ad6'], ['C', C, null]] : [['A', A, null], ['C', C, null]];
      let x = L;
      for (const [k, len, col] of seq) { block(x, len * SC, py, ph, k, col); x += len * SC; }
      this.text(`${ln.cap} · ${(seq.reduce((a, q) => a + q[1], 0)).toFixed(0)} s`, R, py + ph + 15, { size: 11, w: 700, col: 'rgba(255,255,255,0.7)', align: 'right' });
      if (playing) {
        // position along the played track
        const st = o.jumped ? (ln.loop ? (D.y - D.start) + (o.pos - D.x) : (D.x - D.start) + (o.pos - D.y)) : o.pos - D.start;
        const xp = L + Math.max(0, st) * SC;
        g.fillStyle = '#fff'; g.fillRect(xp - 1.5, py - 5, 3, ph + 10); g.beginPath(); g.arc(xp, py + ph / 2, 5, 0, Math.PI * 2); g.fill();
      }
    });
  }
}

// MultiVerse, as a pipeline (after the UIST '26 talk): a listener's profile and the creator's C³
// controls go into generation, and the adapted lyric comes out. Readers can switch listeners and
// turn controls on or off; each combination we have a recording for plays.
const MV_PERSONAS = {
  anna: { name: 'Anna', tag: '25 · grad student, music & CS', facts: [['Right now', 'Waiting for her flight to San Jose, starting a new job'], ['Recent hardship', 'A paper rejection with harsh reviews from R2, and her CHI paper ADR’d']] },
  elena: { name: 'Elena', tag: 'indie game developer · Berlin', facts: [['Right now', 'Late nights finishing her game'], ['Recent hardship', 'Fell out with her collaborators; on bad terms with the Discord moderator']] },
  david: { name: 'David', tag: 'working out at home', facts: [['Right now', 'In his living room, between sets'], ['Recent hardship', 'The drop ended in the middle of his set']] },
};
const MV_CTRL = [
  ['content', 'Content', 'Last two words should rhyme'],
  ['creator', 'Creator', 'Evoke isolation; keep “hates me”'],
  ['context', 'Context', 'Base it on the listener’s recent hardship'],
];
// output per listener and number of controls on (0 = none … 3 = all)
const MV_OUT = {
  anna: [
    { clip: 'nocontrol', lines: ['Anna bends sound into code cha-', 'sing music that learns to listen'], note: 'No control: the theme and the rhyme are gone.' },
    { clip: 'structure', lines: ['Anna codes songs with heart and <mark>art</mark>', 'she builds new systems from the <mark>start</mark>'], note: 'Rhyme kept, but the sad theme is lost.' },
    { clip: 'intent', lines: ['The system I built now <mark>hates me</mark>', 'and lock me in this frequen<mark>cy</mark>'], note: 'Isolation and “hates me” kept, but it isn’t about Anna.' },
    { clip: 'context', lines: ['My <u>paper died</u>, my <u>lab</u> <mark>hates me</mark>', 'reviewer writes with cruel<mark>ty</mark>'], note: 'All three: it’s Anna’s story, in the songwriter’s voice.' },
  ],
  elena: { clip: 'elena', lines: ['My <u>co-dev left</u>, my <u>mod</u> <mark>hates me</mark>', 'late nights alone, streets feel emp<mark>ty</mark>'], note: 'Same controls, a different listener.' },
  david: { clip: 'david', lines: ['My <u>set got cut</u>, the <u>drop</u> <mark>hates me</mark>', 'I lift alone in mise<mark>ry</mark>'], note: 'Same controls, for David.' },
};
export class MvPipe {
  constructor(root, onPlay) {
    this.root = root; this.onPlay = onPlay;
    this.state = { who: 'anna', level: 3 };
    root.innerHTML = `
      <div class="mp-in">
        <div class="mp-box mp-profile"><div class="mp-h">Listener profile</div><div class="mp-tabs"></div><div class="mp-pf"></div></div>
        <div class="mp-box mp-ctl"><div class="mp-h">Creator’s controls <span class="mp-hint">click to toggle</span></div><div class="mp-chips"></div></div>
      </div>
      <div class="mp-gen"><div class="mp-arrow"></div><div class="mp-engine">✦ Generate<small>LLM rewrite<br>+ rule checks</small></div><div class="mp-arrow"></div></div>
      <div class="mp-box mp-out"><div class="mp-h">Adapted lyrics <button class="mp-play" aria-label="Play">▶</button></div>
        <button class="mp-orig">▶ Original: “My dog just died, my friend hates me / I saw myself on MTV”</button>
        <div class="mp-lines"></div><div class="mp-note"></div></div>`;
    const tabs = root.querySelector('.mp-tabs');
    for (const [id, p] of Object.entries(MV_PERSONAS)) { const b = document.createElement('button'); b.dataset.who = id; b.textContent = p.name; tabs.append(b); }
    const chips = root.querySelector('.mp-chips');
    MV_CTRL.forEach(([id, name, text], i) => { const b = document.createElement('button'); b.className = `mp-chip c-${id}`; b.dataset.i = i; b.innerHTML = `<b>${name}</b><span>${text}</span>`; chips.append(b); });
    tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; this.set({ who: b.dataset.who, level: 3 }, true); });
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.mp-chip'); if (!b || this.state.who !== 'anna') return;
      const i = +b.dataset.i;
      // controls build on each other: clicking one turns on everything up to it, or off from it
      this.set({ who: 'anna', level: this.state.level > i ? i : i + 1 }, true);
    });
    root.querySelector('.mp-play').addEventListener('click', () => this.onPlay(this.out().clip, true));
    root.querySelector('.mp-orig').addEventListener('click', () => this.onPlay('original', true));
    this.render();
  }
  out() { const s = this.state; return s.who === 'anna' ? MV_OUT.anna[s.level] : MV_OUT[s.who]; }
  set(st, play = false) {
    this.state = { ...this.state, ...st };
    this.render(true);
    if (play) this.onPlay(this.out().clip, true);
  }
  render(anim = false) {
    const s = this.state, P = MV_PERSONAS[s.who], o = this.out(), q = (x) => this.root.querySelector(x);
    for (const b of this.root.querySelectorAll('.mp-tabs button')) b.classList.toggle('on', b.dataset.who === s.who);
    q('.mp-pf').innerHTML = `<div class="mp-tag">${P.tag}</div>` + P.facts.map(([k, v]) => `<div class="mp-fact"><i>${k}</i>${v}</div>`).join('');
    for (const b of this.root.querySelectorAll('.mp-chip')) { b.classList.toggle('on', +b.dataset.i < s.level); b.classList.toggle('locked', s.who !== 'anna'); }
    q('.mp-hint').textContent = s.who === 'anna' ? 'click to toggle' : 'same controls';
    q('.mp-lines').innerHTML = o.lines.map((l) => `<div>${l}</div>`).join('');
    q('.mp-note').textContent = o.note;
    q('.mp-out').classList.toggle('bad', s.who === 'anna' && s.level === 0);
    if (anim) { this.root.querySelector('.mp-engine').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)', boxShadow: '0 0 18px rgba(255,209,102,0.8)' }, { transform: 'scale(1)' }], { duration: 500 }); q('.mp-lines').animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 180, fill: 'backwards' }); }
  }
}
