// Liminality, a small web version of Alex's 2021 five-lane rhythm game, played on David's phone.
// One continuous journey (Floating → Error Code: Pse → Afterburn), like the original. Audio and
// chart come from the restored Unity project: each cue there is the moment a note *spawns*; it
// reaches the pads 8 beats later (cueBeatOffset), which is when it should be hit. The long intro
// is trimmed to just before the opening flash.

const KEYS = ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'];
const KEY_LABEL = ['D', 'F', '␣', 'J', 'K'];
const WIN = { perfect: 0.06, good: 0.11, ok: 0.16 };
const APPROACH = 1.6;   // seconds a note is on screen before it reaches the pads
// playtest mode (story.html?dev): drag the timeline to scrub, never fail, A toggles autoplay
export const DEV = new URLSearchParams(location.search).has('dev');
const MISS_LIMIT = DEV ? Infinity : 10;
const END_FADE = [537, 541]; // the ending bell has rung out by ~540 s: fade, then show the results  // misses in a row before offering a restart
export const LIM_FILE = 'audio/liminality/journey.mp3';
export const LIM_SONGS = {
  floating: { title: 'Floating', from: 2.0, to: 158.0 },
  errorcode: { title: 'Error Code: Pse', from: 158.0, to: 362.0 },
  afterburn: { title: 'Afterburn', from: 362.0, to: 541 },
};
let dataP = null;
export const loadData = (ctx) => (dataP = dataP || Promise.all([
  fetch('audio/liminality/charts.json').then((r) => r.json()),
  fetch(LIM_FILE).then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a)),
]));

const now = () => performance.now() / 1000;
export class Liminality {
  constructor(root, ctx, out) {
    this.root = root; this.ctx = ctx; this.out = out;
    root.innerHTML = `<div class="lm-phone"><canvas></canvas>
      <div class="lm-hud"><div class="lm-score"><b>0</b><span>SCORE</span></div><div class="lm-combo"></div><div class="lm-acc">100%</div></div>
      <div class="lm-title"></div><div class="lm-judge"></div>
      <div class="lm-pads">${KEY_LABEL.map((k, i) => `<button data-l="${i}">${k}</button>`).join('')}</div>
      <div class="lm-bar"></div>
      <div class="lm-end" hidden></div>
      <button class="lm-pause" aria-label="Pause">❚❚</button><button class="lm-quit" aria-label="Quit">✕</button></div>`;
    this.c = root.querySelector('canvas'); this.g = this.c.getContext('2d');
    this.keyDown = (e) => { if (this.root.hidden) return; if (DEV && e.code === 'KeyA') { this.auto = !this.auto; this.judge(this.auto ? 'AUTOPLAY ON' : 'AUTOPLAY OFF'); return; } if (['Space', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(e.code)) { e.preventDefault(); e.stopPropagation(); } if (e.code === 'Escape' && this.run) { e.preventDefault(); e.stopPropagation(); this.userPaused ? this.resume() : this.pause(); return; } const l = KEYS.indexOf(e.code); if (l < 0 || e.repeat || !this.run) return; e.preventDefault(); e.stopPropagation(); this.hit(l); };
    root.querySelector('.lm-pads').addEventListener('pointerdown', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); this.hit(+b.dataset.l); } });
    root.querySelector('.lm-quit').addEventListener('click', () => this.close());
    if (DEV) {
      // scrub: click or drag the timeline to jump anywhere
      const bar = root.querySelector('.lm-bar');
      bar.classList.add('dev');
      const at = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.total(); };
      let drag = false;
      bar.addEventListener('pointerdown', (e) => { drag = true; bar.setPointerCapture(e.pointerId); this.seek(at(e)); });
      bar.addEventListener('pointermove', (e) => { if (drag && e.buttons) this.seek(at(e)); });
      bar.addEventListener('pointerup', () => { drag = false; });
    }
    root.querySelector('.lm-pause').addEventListener('click', () => (this.userPaused ? this.resume() : this.pause()));
    this.particles = [];
    this.motes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, ph: Math.random() * 6 }));
  }
  // onCleared(songId) fires as each song is finished; onClose() when the reader leaves
  async open({ onCleared, onClose }) {
    this.onCleared = onCleared; this.onClose = onClose;
    this.root.hidden = false;
    this.root.querySelector('.lm-end').hidden = true;
    this.judge('Loading…');
    const [data, buf] = await loadData(this.ctx);
    this.data = data; this.buf = buf;
    this.root.querySelector('.lm-bar').innerHTML = '<i></i>' + data.checkpoints.map((c) => `<span data-id="${c.id}" style="left:${(c.t / this.total()) * 100}%"></span>`).join('') + '<span class="end" style="left:100%"></span>';
    window.addEventListener('keydown', this.keyDown, true);
    this.retry = false;
    this.start(0);
  }
  // start (or restart) from a checkpoint: a few seconds of fade-in before it, notes from it on
  start(ci) {
    this.stopAudio();
    const cp = this.data.checkpoints[ci];
    this.ci = ci; this.cleared = new Set(this.cleared || []);
    this.notes = this.data.notes.filter(([, t]) => t >= cp.t - 0.05).map(([l, t]) => ({ l, t, done: false }));
    this.score = 0; this.combo = 0; this.best = 0; this.earned = 0; this.resolved = 0; this.missRun = 0;
    this.counts = { perfect: 0, good: 0, ok: 0, miss: 0 };
    // the first run plays the intro; any retry starts ~3 s before that song's first note
    const first = this.notes.length ? this.notes[0].t : cp.t;
    const from = this.retry ? Math.max(0, first - 3) : Math.max(0, cp.t - 2);
    this.playAudio(from, this.retry ? 1.5 : 1);
    this.retry = true;
    this.root.querySelector('.lm-end').hidden = true;
    this.judge(ci ? `Checkpoint · ${cp.title}` : '');
    this.run = true; this.finished = false; this.paused = false; this.userPaused = false; this.pausedAt = null; this.ending = false; this.c.style.opacity = '1';
    this.root.querySelector('.lm-pause').textContent = '❚❚';
    const loop = () => { if (!this.run) return; this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  playAudio(from, fade) {
    this.t0 = this.ctx.currentTime + 0.25 - from;
    this.src = this.ctx.createBufferSource(); this.src.buffer = this.buf;
    this.gain = this.ctx.createGain();
    this.gain.gain.setValueAtTime(0, this.ctx.currentTime); this.gain.gain.linearRampToValueAtTime(0.9, this.ctx.currentTime + 0.25 + fade);
    this.src.connect(this.gain).connect(this.out);
    this.ana = this.ana || this.ctx.createAnalyser(); this.ana.fftSize = 1024; this.abuf = this.abuf || new Float32Array(1024);
    this.gain.connect(this.ana);
    this.src.start(this.ctx.currentTime + 0.25, from);
    this.src.onended = () => { if (this.run && !this.paused) this.finish(); };
  }
  // playtest: jump to any time; notes before it are skipped, notes after it are live again
  seek(at) {
    if (!this.buf) return;
    at = Math.max(0, Math.min(this.total() - 1, at));
    this.stopAudio();
    this.notes = this.data.notes.map(([l, t]) => ({ l, t, done: t < at }));
    this.missRun = 0; this.ending = false; this.c.style.opacity = '1';
    if (this.paused) { this.pausedAt = at; this.root.querySelector('.lm-end').hidden = true; this.paused = this.userPaused = false; this.root.querySelector('.lm-pause').textContent = '❚❚'; }
    this.playAudio(at, 0.15);
    if (!this.run) { this.run = true; this.finished = false; const loop = () => { if (!this.run) return; this.draw(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  }
  pause() {
    if (this.paused || !this.run) return;
    this.pausedAt = this.time(); this.paused = this.userPaused = true; this.stopAudio();
    this.root.querySelector('.lm-pause').textContent = '▶';
    const end = this.root.querySelector('.lm-end'); end.hidden = false;
    end.innerHTML = `<b>Paused</b><div><button data-a="resume" class="pri">▶ Resume</button><button data-a="restart">↺ Restart this song</button></div>`;
    end.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.a === 'resume') this.resume(); else { this.userPaused = false; this.start(this.section(this.pausedAt)); } };
  }
  resume() {
    if (!this.userPaused) return;
    this.root.querySelector('.lm-end').hidden = true;
    this.root.querySelector('.lm-pause').textContent = '❚❚';
    // rewind a beat so the reader can find the groove again
    const at = Math.max(0, this.pausedAt - 1.2);
    for (const n of this.notes) if (n.t > at && n.t < this.pausedAt) n.done = false;
    this.playAudio(at, 0.3);
    this.paused = this.userPaused = false; this.pausedAt = null;
  }
  stopAudio() { try { this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); this.src.onended = null; this.src.stop(this.ctx.currentTime + 0.4); } catch {} }
  // the journey ends when the bell has rung out, not at the end of the file
  total() { return Math.min(END_FADE[1], this.buf ? this.buf.duration : END_FADE[1]); }
  time() { return this.ctx.currentTime - this.t0; }
  section(t) { let k = 0; this.data.checkpoints.forEach((c, i) => { if (t >= c.t) k = i; }); return k; }
  hit(l) {
    const pad = this.root.querySelectorAll('.lm-pads button')[l];
    pad.classList.remove('press'); void pad.offsetWidth; pad.classList.add('press');
    if (this.paused) return;
    const t = this.time();
    let best = null;
    for (const n of this.notes) { if (n.done || n.l !== l) continue; const d = Math.abs(n.t - t); if (d <= WIN.ok && (!best || d < Math.abs(best.t - t))) best = n; if (n.t > t + WIN.ok) break; }
    if (!best) return;
    const d = Math.abs(best.t - t), kind = d <= WIN.perfect ? 'perfect' : d <= WIN.good ? 'good' : 'ok';
    best.done = true; this.resolve(kind, best.l);
  }
  resolve(kind, lane) {
    this.counts[kind]++; this.resolved++;
    const pts = { perfect: 3, good: 2, ok: 1, miss: 0 }[kind];
    this.earned += pts; this.score += pts * (1 + Math.min(this.combo, 50) / 50);
    if (kind === 'miss') { this.combo = 0; this.missRun++; if (this.missRun >= MISS_LIMIT) this.stuck(); }
    else { this.combo++; this.missRun = 0; this.best = Math.max(this.best, this.combo); this.burst(lane, kind); }
    this.judge(kind.toUpperCase(), kind);
  }
  judge(text, kind = '') {
    const el = this.root.querySelector('.lm-judge');
    el.textContent = text; el.className = `lm-judge ${kind}`; void el.offsetWidth; el.classList.add('pop');
  }
  burst(lane, kind) {
    const n = kind === 'perfect' ? 14 : 8;
    for (let i = 0; i < n; i++) this.particles.push({ lane, a: Math.random() * Math.PI * 2, v: 60 + Math.random() * 130, life: 0, max: 0.45 + Math.random() * 0.3, gold: kind === 'perfect' });
    this.ripple = { lane, t: performance.now() };
  }
  // The original's choreography (alex/animationmanager.cs, AfterburnChoreography.cs), as windows of
  // song beats: calm → build → drop. Floating and PSE count 160-BPM beats from the start of their
  // file (beat b at (b-1)·0.375 s, 14.5 s before game time 0); Afterburn uses its clip's seconds.
  mood(t) {
    const B = (b) => (b - 1) * 0.375 - 14.5, beat = Math.floor((t + 14.5) / 0.375) + 1, ph = (((t + 14.5) / 0.375) % 1 + 1) % 1;
    const ramp = (a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
    const inB = (a, b) => t >= B(a) && t < B(b);
    const sec = this.section(t);
    if (sec === 0) {
      if (inB(168, 197)) return { sec, mode: 'build', I: 0.2 + 0.5 * ramp(B(168), B(197)), beat, ph };
      if (inB(197, 205)) return { sec, mode: 'build', I: 0.8, beat, ph };
      if (inB(205, 237) || inB(245, 268)) return { sec, mode: 'drop', I: 1, beat, ph };
      if (inB(237, 245)) return { sec, mode: 'blackout', I: 0.1, beat, ph };
      if (inB(268, 300)) return { sec, mode: 'drift', I: 0.45, beat, ph };
      return { sec, mode: 'calm', I: 0.15, beat, ph };
    }
    if (sec === 1) {
      for (const o of [0, 224, 288]) {
        if (inB(493 + o, 509 + o)) return { sec, mode: 'build', I: 0.3 + 0.3 * ramp(B(493 + o), B(509 + o)), half: true, beat, ph };
        if (inB(509 + o, 521 + o)) return { sec, mode: 'build', I: 0.6 + 0.3 * ramp(B(509 + o), B(521 + o)), quarter: true, hueJitter: beat >= 517 + o, beat, ph };
        if (inB(521 + o, 525 + o)) return { sec, mode: 'blackout', I: 0, beat, ph };
        if (inB(525 + o, 541 + o) || inB(543 + o, 549 + o) || inB(551 + o, 589 + o)) return { sec, mode: 'drop', I: 1, beat, ph };
      }
      return { sec, mode: 'calm', I: 0.1, beat, ph };
    }
    const c = t - 374.3, q = 0.4, qb = Math.floor(c / q), qph = ((c / q) % 1 + 1) % 1;
    if (c >= 38.4 && c < 51.22) return { sec, mode: 'build', I: 0.25 + 0.65 * ramp(374.3 + 38.4, 374.3 + 51.22), beat: qb, ph: qph };
    if ((c >= 51.22 && c < 62.42) || (c >= 64.02 && c < 89.6)) return { sec, mode: 'drop', I: 1, beat: qb, ph: qph };
    if (c >= 62.42 && c < 64.02) return { sec, mode: 'blackout', I: 0.1, beat: qb, ph: qph };
    if (c >= 89.6 && c < 102.4) return { sec, mode: 'release', I: 1 - ramp(374.3 + 89.6, 374.3 + 102.4) * 0.8, beat: qb, ph: qph };
    return { sec, mode: 'calm', I: 0.18, beat: qb, ph: qph };
  }
  // colours for the moment: a base look per song, pushed by the choreography
  // the chart note most recently due at time t: how long ago, and how many landed together
  lastNote(t) {
    const N = this.data.notes; let lo = 0, hi = N.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (N[m][1] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0) return { age: 99, chord: 0 };
    let chord = 1; while (k - chord >= 0 && N[k][1] - N[k - chord][1] < 0.03) chord++;
    return { age: t - N[k][1], chord };
  }
  theme(sec, prog, t) {
    const m = this.mood(t), mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hit = Math.exp(-m.ph * 7); // a quick pulse at each beat
    let th;
    if (sec === 0) {
      // Floating: teal sinking into the deep sea; colourful sparkles; the drops glow on every other beat
      const k = Math.min(1, prog * 1.1);
      th = { kind: 'float', top: mix([10, 61, 68], [2, 6, 14], k), mid: mix([14, 106, 114], [4, 18, 34], k), bot: mix([11, 79, 87], [1, 4, 10], k), rays: 0.04 * (1 - k) * (0.4 + m.I),
        line: '60,170,235', lineA: (1 - 0.4 * k) * (0.5 + 0.5 * m.I), plate: 'rgba(226,178,58,0.9)', note: '255,225,150', spark: '150,240,255', flash: 0, flashCol: '0,0,0' };
      if (m.mode === 'build') { th.fog = 0.18 * m.I; }
      if (m.mode === 'drop' && m.beat % 2 === 0) th.glow = hit;
      if (m.mode === 'blackout') { th.flash = 0.75; th.flashCol = '0,0,0'; }
    } else if (sec === 1) {
      // Error Code: Pse: pitch black; the build glows on half then quarter notes; the drop strobes
      // purple on odd beats with the hue thrown around
      th = { kind: 'pse', top: [0, 0, 0], mid: [6, 2, 12], bot: [0, 0, 0], rays: 0, line: '170,90,255', lineA: 0.35 + 0.4 * m.I, plate: 'rgba(150,80,230,0.85)', note: '215,160,255', spark: '200,120,255', flash: 0, flashCol: '150,40,255' };
      if (m.mode === 'build') { th.fog = 0.22 * m.I; if ((m.half && m.beat % 2 === 1) || m.quarter) th.glow = hit * 0.8; if (m.hueJitter && !reduce) th.hue = (m.beat * 47) % 120 - 60; if (!reduce && this.lastNote(t).age < 0.07) th.glitch = 'hint'; }
      if (m.mode === 'blackout') { th.flash = 0.9; th.flashCol = '0,0,0'; th.lineA = 0.1; }
      if (m.mode === 'drop' && !reduce) {
        // every note fires a burst; chords hit harder; silence between notes stays clean
        const ln = this.lastNote(t), burst = ln.age < 0.16 ? Math.exp(-ln.age * 18) * Math.min(1.6, 0.6 + 0.4 * ln.chord) : 0;
        if (burst > 0.05) {
          th.flash = 0.6 * Math.min(1, burst); th.flashCol = ['150,40,255', '255,255,255', '255,0,140', '60,0,255'][Math.floor(now() * 12) % 4];
          th.hue = Math.floor(Math.random() * 360); th.glitch = 'chaos'; th.glitchAmt = Math.min(1, burst); th.shake = 7 * burst;
        }
        th.glow = hit;
      }
    } else {
      // Afterburn: grey, brown, gold and amber; embers race up during the drops
      th = { kind: 'burn', top: [24, 20, 18], mid: mix([46, 36, 28], [96, 62, 26], m.I), bot: [18, 14, 12], rays: 0.015 + 0.03 * m.I,
        line: '230,170,90', lineA: 0.5 + 0.5 * m.I, plate: 'rgba(240,170,60,0.92)', note: '255,190,90', spark: '255,150,60', flash: 0, flashCol: '255,170,80' };
      if (m.mode === 'build') th.glow = hit * 0.5 * m.I;
      if (m.mode === 'drop') { th.glow = hit; th.flash = 0.1 * hit; }
      if (m.mode === 'blackout') { th.flash = 0.7; th.flashCol = '10,6,4'; }
    }
    th.mode = m.mode; th.I = m.I; th.bar = Math.floor((m.beat - 1) / 4); th.beatPh = m.ph;
    return th;
  }
  drawWorld(g, W, H, th, t) {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, `rgb(${th.top})`); bg.addColorStop(0.55, `rgb(${th.mid})`); bg.addColorStop(1, `rgb(${th.bot})`);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const now = performance.now(), dt = Math.min(0.05, (now - (this.lastNow || now)) / 1000); this.lastNow = now;
    g.save(); g.globalCompositeOperation = 'lighter';
    if (th.rays > 0.002) for (let i = 0; i < 4; i++) { const x = W * (0.15 + i * 0.25) + Math.sin(now / 3000 + i) * 20; g.fillStyle = th.kind === 'burn' ? `rgba(255,190,110,${th.rays})` : `rgba(120,230,240,${th.rays})`; g.beginPath(); g.moveTo(x - 20, 0); g.lineTo(x + 20, 0); g.lineTo(x + 90, H); g.lineTo(x - 50, H); g.fill(); }
    // particles: sparse and slow when calm
    const cols = th.kind === 'float' ? ['150,240,255', '255,140,210', '255,220,120', '170,140,255', '120,255,190'] : th.kind === 'pse' ? ['170,110,255', '220,180,255'] : ['255,170,70', '255,210,120', '230,120,50'];
    const drop = th.mode === 'drop';
    const active = Math.round(this.motes.length * (th.kind === 'pse' ? 0.15 : th.kind === 'float' && drop ? 0.15 : 0.18 + 0.82 * Math.min(th.I, drop ? 0.5 : 1)));
    this.motes.forEach((m, i) => {
      if (i >= active) return;
      const speed = (th.kind === 'burn' ? 0.09 : 0.04) * (0.4 + th.I) * m.z;
      m.y -= speed * dt; if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
      const x = (m.x + Math.sin(now / 1500 + m.ph) * 0.012) * W, y = m.y * H, col = cols[i % cols.length];
      const tw = 0.5 + 0.5 * Math.sin(now / 400 + m.ph * 3);
      g.fillStyle = `rgba(${col},${(th.kind === 'pse' ? 0.15 : 0.2 + 0.5 * tw) * m.z})`;
      g.beginPath(); g.arc(x, y, 0.8 + (th.kind === 'float' ? 1.8 * tw : 1.2) * m.z, 0, Math.PI * 2); g.fill();
      if (th.kind === 'float' && tw > 0.9) { g.fillRect(x - 5 * m.z, y - 0.5, 10 * m.z, 1); g.fillRect(x - 0.5, y - 5 * m.z, 1, 10 * m.z); }
    });
    // Floating drop: the sparkles rush toward the camera from the vanishing point, out to the sides
    // and up, never down through the note lanes
    if (th.kind === 'float' && drop) {
      this.warp = this.warp || [];
      const vx = W / 2, vy = H * 0.18;
      while (this.warp.length < 90) {
        // angles: up and to the sides only (the highway fans out below the vanishing point)
        let a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.45;
        this.warp.push({ a, r: 4 + Math.random() * 30, v: 0.6 + Math.random() * 1.4, col: cols[Math.floor(Math.random() * cols.length)] });
      }
      for (const w of this.warp) {
        const r0 = w.r; w.r *= 1 + w.v * 2.2 * dt; w.r += 30 * w.v * dt;
        const x0 = vx + Math.cos(w.a) * r0, y0 = vy + Math.sin(w.a) * r0, x1 = vx + Math.cos(w.a) * w.r, y1 = vy + Math.sin(w.a) * w.r;
        if (x1 < -20 || x1 > W + 20 || y1 < -20 || y1 > H + 20) { w.r = 4 + Math.random() * 20; w.a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.45; continue; }
        const k = Math.min(1, w.r / (W * 0.6)), tail = 0.45;
        const gr = g.createLinearGradient(x1, y1, x1 - (x1 - x0) * 6 * tail, y1 - (y1 - y0) * 6 * tail);
        gr.addColorStop(0, `rgba(${w.col},${0.95 * k})`); gr.addColorStop(1, `rgba(${w.col},0)`);
        g.strokeStyle = gr; g.lineWidth = 0.6 + 2.6 * k; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - (x1 - x0) * 6 * tail, y1 - (y1 - y0) * 6 * tail); g.stroke();
      }
    } else this.warp = null;
    // Afterburn drop: real fire, licking up from the bottom and the sides (clear of the lanes' middle)
    if (th.kind === 'burn') {
      this.fire = this.fire || [];
      const heat = drop ? 1 : th.mode === 'build' ? 0.3 * th.I : 0;
      const spawn = Math.round(heat * 9);
      for (let n = 0; n < spawn; n++) {
        const edge = Math.random();
        const x = edge < 0.6 ? Math.random() * W : edge < 0.8 ? Math.random() * W * 0.12 : W - Math.random() * W * 0.12;
        this.fire.push({ x, y: H + 10, vx: (Math.random() - 0.5) * 20, vy: -(70 + Math.random() * 140) * (edge < 0.6 ? 0.55 : 1.2), r: 10 + Math.random() * 22, life: 0, max: 0.6 + Math.random() * 0.7 });
      }
      for (let n = this.fire.length - 1; n >= 0; n--) {
        const f = this.fire[n]; f.life += dt; if (f.life > f.max) { this.fire.splice(n, 1); continue; }
        const k = f.life / f.max; f.x += (f.vx + Math.sin(now / 160 + f.r) * 40) * dt; f.y += f.vy * dt;
        // a flame tongue: a tall teardrop, white-gold at the core, orange then red as it rises
        const w = f.r * (1 - k * 0.6), h = w * (2.6 + 1.4 * k), col = k < 0.3 ? '255,235,170' : k < 0.6 ? '255,160,40' : k < 0.85 ? '220,70,15' : '70,35,25';
        const gr = g.createRadialGradient(f.x, f.y, 0, f.x, f.y - h * 0.3, h);
        gr.addColorStop(0, `rgba(${col},${0.4 * (1 - k)})`); gr.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = gr; g.beginPath(); g.moveTo(f.x - w, f.y); g.quadraticCurveTo(f.x - w * 0.8, f.y - h * 0.6, f.x + Math.sin(now / 120 + f.r) * w * 0.4, f.y - h); g.quadraticCurveTo(f.x + w * 0.8, f.y - h * 0.6, f.x + w, f.y); g.quadraticCurveTo(f.x, f.y + w * 0.6, f.x - w, f.y); g.fill();
      }
      // embers thrown up by the fire, short bright streaks
      if (heat > 0.5) for (let n = 0; n < 2; n++) this.fire.push({ ember: true, x: Math.random() * W, y: H, vx: (Math.random() - 0.5) * 40, vy: -(260 + Math.random() * 260), r: 1, life: 0, max: 0.9 + Math.random() * 0.8 });
      for (const f of this.fire) if (f.ember) { const k = f.life / f.max; g.strokeStyle = `rgba(255,${190 - 80 * k},70,${0.9 * (1 - k)})`; g.lineWidth = 1.6; g.beginPath(); g.moveTo(f.x, f.y); g.lineTo(f.x - f.vx * 0.04, f.y - f.vy * 0.04); g.stroke(); }
      if (heat > 0) { const hg = g.createLinearGradient(0, H, 0, H * 0.7); hg.addColorStop(0, `rgba(255,120,30,${0.35 * heat})`); hg.addColorStop(1, 'rgba(255,120,30,0)'); g.fillStyle = hg; g.fillRect(0, 0, W, H); }
    }
    // beat glow from the bottom (the original's glowing walls)
    if (th.glow > 0.02) { const gg = g.createLinearGradient(0, H, 0, H * 0.35); gg.addColorStop(0, `rgba(${th.kind === 'pse' ? '170,90,255' : th.kind === 'burn' ? '255,170,70' : '120,230,255'},${0.35 * th.glow})`); gg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gg; g.fillRect(0, 0, W, H); }
    g.restore();
    if (th.fog > 0.01) { g.fillStyle = `rgba(230,235,240,${th.fog})`; g.fillRect(0, 0, W, H); }
    // PSE glitch: a hint before the drop, chaos during it. Each bar picks its own pair of glitch
    // styles and palette, so it never settles into one repeating pattern.
    if (th.glitch) {
      const chaos = th.glitch === 'chaos', bar = th.bar || 0, rnd = (k) => { const x = Math.sin((bar + 1) * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
      const STYLES = ['bands', 'vertical', 'blocks', 'rgb', 'scan', 'pixel', 'tear', 'invert'];
      const pick = chaos ? [STYLES[Math.floor(rnd(1) * STYLES.length)], STYLES[Math.floor(rnd(2) * STYLES.length)]] : ['bands'];
      const PALS = [['190,60,255', '255,255,255'], ['0,255,230', '255,0,120'], ['255,255,255', '120,120,140'], ['255,40,90', '60,0,255'], ['170,255,60', '190,60,255']];
      const pal = PALS[Math.floor(rnd(3) * PALS.length)], amt = chaos ? (0.4 + 0.6 * rnd(4)) * (th.glitchAmt ?? 1) : 0.2;
      const scale = this.c.width / W, src = (x, y, w, h) => [x * scale, y * scale, w * scale, h * scale];
      for (const st of pick) {
        if (st === 'bands') {
          // horizontal bands smeared sideways
          for (let i = 0; i < (chaos ? 6 + 10 * amt : 1); i++) { const y = Math.random() * H, h = (chaos ? 3 : 1) + Math.random() * (chaos ? 30 : 4), off = (Math.random() - 0.5) * (chaos ? 120 : 16) * amt; try { g.drawImage(this.c, ...src(0, y, W, h), off, y, W, h); } catch {} if (chaos) { g.fillStyle = `rgba(${pal[i % 2]},${0.1 + Math.random() * 0.25})`; g.fillRect(off * 0.5, y, W, Math.max(1, h * 0.3)); } }
        } else if (st === 'vertical') {
          // tall slices dropped up or down
          for (let i = 0; i < 5 + 6 * amt; i++) { const x = Math.random() * W, w = 4 + Math.random() * 40, off = (Math.random() - 0.5) * 140 * amt; try { g.drawImage(this.c, ...src(x, 0, w, H), x, off, w, H); } catch {} }
        } else if (st === 'blocks') {
          // datamosh: copied blocks out of place
          for (let i = 0; i < 8 + 10 * amt; i++) { const bw = 16 + Math.random() * 60, bh = 8 + Math.random() * 40, sx = Math.random() * (W - bw), sy = Math.random() * (H - bh); try { g.drawImage(this.c, ...src(sx, sy, bw, bh), sx + (Math.random() - 0.5) * 80, sy + (Math.random() - 0.5) * 40, bw, bh); } catch {} }
          for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(${pal[i % 2]},0.45)`; g.fillRect(Math.random() * W, Math.random() * H, 4 + Math.random() * 30, 2 + Math.random() * 10); }
        } else if (st === 'rgb') {
          // split colour channels
          g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.3 + 0.2 * amt;
          try { g.drawImage(this.c, 0, 0, this.c.width, this.c.height, (8 + 10 * Math.random()) * amt, 0, W, H); g.drawImage(this.c, 0, 0, this.c.width, this.c.height, -(8 + 10 * Math.random()) * amt, 2, W, H); } catch {}
          g.restore();
        } else if (st === 'scan') {
          // a rolling scan bar and interlace lines
          const yy = ((performance.now() / 6) % (H + 80)) - 40; g.fillStyle = `rgba(${pal[0]},0.28)`; g.fillRect(0, yy, W, 26 + 30 * amt);
          g.fillStyle = 'rgba(0,0,0,0.35)'; for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
        } else if (st === 'pixel') {
          // the frame drops to a coarse resolution for an instant
          const k = 0.06 + 0.06 * Math.random(); g.save(); g.imageSmoothingEnabled = false;
          try { g.drawImage(this.c, 0, 0, this.c.width, this.c.height, 0, 0, W * k, H * k); g.drawImage(this.c, 0, 0, W * k * scale, H * k * scale, 0, 0, W, H); } catch {}
          g.restore();
        } else if (st === 'tear') {
          // the whole frame tears at one line and slides
          const y = H * (0.2 + 0.6 * Math.random()), off = (Math.random() - 0.5) * 90 * amt;
          try { g.drawImage(this.c, ...src(0, y, W, H - y), off, y, W, H - y); } catch {}
          g.fillStyle = `rgba(${pal[1]},0.6)`; g.fillRect(0, y - 1, W, 2);
        } else if (st === 'invert' && th.beatPh < 0.18) {
          g.save(); g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.restore();
        }
      }
    }
  }
  accuracy() { return this.resolved ? this.earned / (this.resolved * 3) : 1; }
  // 10 misses in a row: pause and offer the latest checkpoint (or the very start)
  stuck() {
    this.pausedAt = this.time(); this.paused = true; this.stopAudio();
    const cp = this.data.checkpoints[this.section(this.time())];
    const end = this.root.querySelector('.lm-end'); end.hidden = false;
    end.innerHTML = `<b>Lost the beat…</b><span>${MISS_LIMIT} misses in a row</span>
      <div><button data-a="cp" class="pri">↺ Restart ${cp.title}</button><button data-a="start">From the beginning</button></div>`;
    end.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; this.start(b.dataset.a === 'cp' ? this.data.checkpoints.indexOf(cp) : 0); };
  }
  draw() {
    const c = this.c, r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); }
    const g = this.g, W = r.width, H = r.height; g.setTransform(d, 0, 0, d, 0, 0);
    const t = this.paused ? this.pausedAt : this.time();
    if (!this.paused && t > END_FADE[0] && this.run) {
      // the music has rung out: fade picture and sound, then the results
      if (!this.ending) { this.ending = true; this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, (END_FADE[1] - END_FADE[0]) / 3); }
      this.c.style.opacity = String(Math.max(0, 1 - (t - END_FADE[0]) / (END_FADE[1] - END_FADE[0])));
      if (t >= END_FADE[1]) { this.finish(); return; }
    }
    if (!this.paused && this.auto) for (const n of this.notes) { if (n.done) continue; if (n.t > t + 0.01) break; if (n.t <= t) this.hit(n.l); }
    if (!this.paused) {
      for (const n of this.notes) { if (n.done) continue; if (n.t < t - WIN.ok) { n.done = true; this.resolve('miss', n.l); if (this.paused) break; } else if (n.t > t) break; }
      // a song is cleared when the journey passes into the next one
      const k = this.section(t);
      for (let i = 0; i < k; i++) { const id = this.data.checkpoints[i].id; if (!this.cleared.has(id)) { this.cleared.add(id); this.onCleared && this.onCleared(id); this.judge(`🔓 ${this.data.checkpoints[i].title} unlocked`, 'unlock'); } }
      this.root.querySelector('.lm-title').textContent = this.data.checkpoints[k].title;
    }
    const sec = this.section(t), cp = this.data.checkpoints[sec], bpm = cp.bpm;
    const nextT = this.data.checkpoints[sec + 1] ? this.data.checkpoints[sec + 1].t : this.total();
    const prog = Math.max(0, Math.min(1, (t - cp.t) / (nextT - cp.t)));
    // the beat grid: Floating and PSE count from the original file's start (14.5 s before game
    // time 0); Afterburn from where its clip comes in
    const origin = sec < 2 ? -14.5 : 374.3;
    // loudness drives the flashes and the glow
    let lvl = 0; if (this.ana && !this.paused) { this.ana.getFloatTimeDomainData(this.abuf); let q = 0; for (const v of this.abuf) q += v * v; lvl = Math.sqrt(q / this.abuf.length); }
    this.lvlAvg = (this.lvlAvg || lvl) * 0.985 + lvl * 0.015;
    const surge = Math.max(0, lvl / (this.lvlAvg + 1e-4) - 1);
    const theme = this.theme(sec, prog, t);
    // background layer (shakes, flashes, hue jumps, glitches); the highway sits on its own layer on top
    g.save(); if (theme.shake) g.translate((Math.random() - 0.5) * theme.shake, (Math.random() - 0.5) * theme.shake);
    if (theme.hue) g.filter = `hue-rotate(${theme.hue}deg)`;
    this.drawWorld(g, W, H, theme, t);
    if (theme.flash > 0.01) { g.fillStyle = `rgba(${theme.flashCol},${theme.flash})`; g.fillRect(0, 0, W, H); }
    g.filter = 'none';
    g.restore();
    // highway: five lanes converging toward a horizon; f is depth (0 far, 1 at the pads)
    const hy = H * 0.18, py = H * 0.8, cx = W / 2, topW = W * 0.16, botW = W * 0.92;
    {
      // the highway surface: dark tinted glass with lit edges, so the notes always read clearly
      // in front of whatever the background is doing
      const sg = g.createLinearGradient(0, hy, 0, py);
      sg.addColorStop(0, 'rgba(4,6,10,0.2)'); sg.addColorStop(1, 'rgba(4,6,10,0.74)');
      g.fillStyle = sg; g.beginPath(); g.moveTo(cx - topW / 2, hy); g.lineTo(cx + topW / 2, hy); g.lineTo(cx + botW / 2 + 22, py + 12); g.lineTo(cx - botW / 2 - 22, py + 12); g.closePath(); g.fill();
      g.strokeStyle = `rgba(${theme.line},0.6)`; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - topW / 2, hy); g.lineTo(cx - botW / 2 - 22, py + 12); g.moveTo(cx + topW / 2, hy); g.lineTo(cx + botW / 2 + 22, py + 12); g.stroke();
    }
    const P = (lane, f) => { const w = topW + (botW - topW) * f; return { x: cx - w / 2 + (lane + 0.5) * (w / 5), y: hy + (py - hy) * f, s: 0.25 + 0.75 * f, w: w / 5 }; };
    const depth = (dt) => { const u = 1 - dt / APPROACH; return u <= 0 ? 0 : u * u; }; // dt: seconds until the pads
    // beat lines, locked to the song's beats so they arrive at the pads on the beat
    const spb = 60 / bpm, phase = (((t - origin) % spb) + spb) % spb;
    for (let k = 0; k * spb < APPROACH + spb; k++) {
      const f = depth(k * spb + (spb - phase)); if (f <= 0 || f > 1) continue;
      const a = P(0, f), b = P(4, f);
      g.strokeStyle = `rgba(${theme.line},${(0.2 + 0.6 * f) * theme.lineA})`; g.lineWidth = 1 + 3 * f;
      g.beginPath(); g.moveTo(a.x - a.w / 2, a.y); g.lineTo(b.x + b.w / 2, b.y); g.stroke();
    }
    for (let l = 0; l <= 5; l++) { g.strokeStyle = `rgba(${theme.line},0.14)`; g.lineWidth = 1; g.beginPath(); g.moveTo(cx - topW / 2 + l * topW / 5, hy); g.lineTo(cx - botW / 2 + l * botW / 5, py); g.stroke(); }
    // the gold strike line where notes must be hit
    g.fillStyle = theme.plate; g.beginPath(); g.moveTo(cx - botW / 2 - 6, py - 3); g.lineTo(cx + botW / 2 + 6, py - 3); g.lineTo(cx + botW / 2 + 22, py + 12); g.lineTo(cx - botW / 2 - 22, py + 12); g.fill();
    // notes: single glowing orbs, centred on the strike line exactly at their hit time
    g.save(); g.globalCompositeOperation = 'lighter';
    for (const n of this.notes) {
      if (n.done) continue; const dt = n.t - t; if (dt > APPROACH) break; if (dt < -0.12) continue;
      const f = dt >= 0 ? depth(dt) : 1 + (-dt) * 0.6, p = P(n.l, f), rad = 4 + 9 * Math.min(1, p.s);
      const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 1.8);
      gr.addColorStop(0, 'rgba(255,255,245,1)'); gr.addColorStop(0.45, `rgba(${theme.note},0.9)`); gr.addColorStop(1, `rgba(${theme.note},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, rad * 1.8, 0, Math.PI * 2); g.fill();
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i]; q.life += 1 / 60; if (q.life > q.max) { this.particles.splice(i, 1); continue; }
      const p = P(q.lane, 1), k = q.life / q.max, x = p.x + Math.cos(q.a) * q.v * q.life, y = p.y + Math.sin(q.a) * q.v * q.life * 0.6 - 40 * q.life;
      g.fillStyle = q.gold ? `rgba(${theme.note},${1 - k})` : `rgba(${theme.spark},${1 - k})`; g.beginPath(); g.arc(x, y, 2.6 * (1 - k) + 0.6, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    if (this.ripple) { const k = (performance.now() - this.ripple.t) / 600; if (k < 1) { const p = P(this.ripple.lane, 1); g.strokeStyle = `rgba(180,250,255,${0.7 * (1 - k)})`; g.lineWidth = 2; g.beginPath(); g.ellipse(p.x, p.y, 14 + 70 * k, 5 + 24 * k, 0, 0, Math.PI * 2); g.stroke(); } }

    // pads sit exactly on the strike line
    const pads = this.root.querySelector('.lm-pads'); pads.style.top = `${py - 24}px`;
    const q = (s) => this.root.querySelector(s);
    q('.lm-score b').textContent = Math.round(this.score);
    q('.lm-combo').textContent = this.combo > 2 ? `${this.combo} combo` : '';
    q('.lm-acc').textContent = `${(this.accuracy() * 100).toFixed(1)}%`;
    if (DEV) q('.lm-title').textContent = `${this.data.checkpoints[this.section(t)].title} · ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}${this.auto ? ' · AUTO' : ''}`;
    q('.lm-bar i').style.width = `${Math.max(0, Math.min(100, (t / this.total()) * 100))}%`;
    for (const sp of this.root.querySelectorAll('.lm-bar span[data-id]')) sp.classList.toggle('done', this.cleared.has(sp.dataset.id));
  }
  finish() {
    if (this.finished) return; this.finished = true;
    this.run = false; this.stopAudio();
    for (const c of this.data.checkpoints) if (!this.cleared.has(c.id)) { this.cleared.add(c.id); this.onCleared && this.onCleared(c.id); }
    const end = this.root.querySelector('.lm-end'); end.hidden = false; end.classList.remove('fadein'); void end.offsetWidth; end.classList.add('fadein');
    end.innerHTML = `<b>Journey complete!</b><span>${(this.accuracy() * 100).toFixed(1)}% · best combo ${this.best}</span>
      <span class="lm-counts">Perfect ${this.counts.perfect} · Good ${this.counts.good} · OK ${this.counts.ok} · Miss ${this.counts.miss}</span>
      <em>🔓 All three songs unlocked on David’s phone</em>
      <div><button data-a="again">↺ Play again</button><button data-a="close" class="pri">Back to the room</button></div>`;
    end.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.a === 'again') this.start(0); else this.close(); };
  }
  close() {
    this.run = false; window.removeEventListener('keydown', this.keyDown, true);
    this.stopAudio();
    this.root.hidden = true;
    const cleared = this.cleared ? [...this.cleared] : [];
    const cb = this.onClose; this.onClose = null;
    try { cb && cb(cleared); } finally { document.body.classList.remove('lim-on'); }
  }
}
