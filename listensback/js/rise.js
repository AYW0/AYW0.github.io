// RISE, interactive: you steer the song with precomputed cutpoints (loop the current section
// or skip ahead through it) and the athlete follows the music: squats on the beat while it is
// high energy, rests while it is calm, and counts reps out loud.
// Songs, beats, sections and cutpoints are precomputed offline
// (rise-assets → rise-unity/segmentation/Cutpoints/Assets/music). Only in-section cutpoints
// are used, as in AudioController.cs. The audio is never filtered or time-stretched.

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};
const fmt = (s) => { s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = { high: css('--high'), low: css('--low'), loop: css('--loop'), skip: css('--skip') };

let SONGS = [];
let actx = null, master = null;
function ctxReady() {
  if (actx) return actx;
  actx = new AudioContext({ latencyHint: 'interactive' });
  master = actx.createGain();
  master.gain.value = 0.9;
  master.connect(actx.destination); // no filter, no compressor: the audio is untouched
  return actx;
}
const engine = { get ctx() { return actx; } };
const state = { song: null, ana: null, mode: 'normal', p: { showCuts: true } };
let run = null;          // playback session
let player = null;
let pendingPlan = null;  // next cut the current mode will take (not yet locked in)
const bufCache = new Map();

// ---------------------------------------------------------------- player with seamless jumps
class Player {
  constructor(ctx, out, song) { this.ctx = ctx; this.out = out; this.song = song; this.voices = []; this.maps = []; }
  voice(pos, when, fade) {
    const g = this.ctx.createGain();
    g.connect(this.out);
    g.gain.setValueAtTime(0, Math.max(this.ctx.currentTime, when - 0.001));
    g.gain.linearRampToValueAtTime(1, when + fade);
    const srcs = [this.song.buf].map((b) => {
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(g);
      s.start(when, Math.max(0, pos));
      return s;
    });
    const v = { g, srcs };
    this.voices.push(v);
    return v;
  }
  start(pos, when) { this.stop(); this.maps = [{ c: when, p: pos }]; this.voice(pos, when, 0.6); }
  map(now = this.ctx.currentTime) { let m = this.maps[0]; for (const x of this.maps) if (x.c <= now) m = x; return m; }
  pos(now = this.ctx.currentTime) { const m = this.map(now); return m.p + (now - m.c); }
  ctxTimeOf(songPos) { const m = this.maps[this.maps.length - 1]; return m.c + (songPos - m.p); }
  // Cut from `orig` to `dest` (song seconds) with a short equal-time crossfade; returns ctx time.
  jump(orig, dest, xf = 0.025) {
    const c = this.ctxTimeOf(orig);
    const old = this.voices[this.voices.length - 1];
    old.g.gain.setValueAtTime(1, c - xf);
    old.g.gain.linearRampToValueAtTime(0, c + xf);
    old.srcs.forEach((s) => s.stop(c + xf + 0.02));
    this.voice(dest - xf, c - xf, 2 * xf);
    this.maps.push({ c, p: dest });
    if (this.maps.length > 6) this.maps.splice(0, this.maps.length - 6);
    if (this.voices.length > 4) this.voices.splice(0, this.voices.length - 4);
    return c;
  }
  // Jump the playhead to `pos` right now (user navigation), with a short crossfade.
  seek(pos, xf = 0.03) {
    const now = this.ctx.currentTime;
    for (const v of this.voices) { v.g.gain.cancelScheduledValues(0); v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.linearRampToValueAtTime(0, now + xf); v.srcs.forEach((s) => { try { s.stop(now + xf + 0.02); } catch {} }); }
    this.voices = [];
    const when = now + 0.01;
    this.maps = [{ c: when, p: pos }];
    this.voice(pos, when, xf);
  }
  stop() {
    const now = this.ctx.currentTime;
    for (const v of this.voices) { v.g.gain.cancelScheduledValues(0); v.g.gain.setTargetAtTime(0, now, 0.05); v.srcs.forEach((s) => { try { s.stop(now + 0.3); } catch {} }); }
    this.voices = [];
  }
}

// ---------------------------------------------------------------- modes
const LOOK = 0.3; // lock a cut in this close to its origin
const segIndexAt = (t) => { const s = state.ana.segments; for (let i = 0; i < s.length; i++) if (t < s[i].end) return i; return s.length - 1; };
const beatAt = (t) => { const b = state.song.beats; let lo = 0, hi = b.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= t) lo = m; else hi = m; } return lo; };

// Furthest-reaching forward cutpoint ahead of the playhead (FindBestSkipPoint).
function bestSkip(cands, cur) {
  let best = null;
  for (const c of cands) if (c.oi > cur && c.di > c.oi && (!best || c.di - c.oi > best.di - best.oi || (c.di - c.oi === best.di - best.oi && c.oi > best.oi))) best = c;
  return best;
}
// Longest backward cutpoint (FindBestLoopingPoint).
// hand-picked loops (verified by ear), used instead of the longest one when reachable
const PREFERRED_LOOP = { waves: [136.3, 108.8], lost: [72.0, 62.9], cruelsummer: [48.9, 37.6] };
function bestLoop(cands, cur) {
  let best = null;
  for (const c of cands) if (c.oi > cur && c.di < c.oi && (!best || c.oi - c.di > best.oi - best.di || (c.oi - c.di === best.oi - best.di && c.oi > best.oi))) best = c;
  return best;
}

function decide(pos) {
  const B = state.song.beats;
  const cur = beatAt(pos);
  // an auditioned cutpoint takes priority, once
  if (run && run.audition) {
    const c = run.audition;
    if (c.orig > pos + 0.12) return { ...c, kind: c.dest < c.orig ? 'loop' : 'skip', why: `Audition: ${fmt(c.orig)} → ${fmt(c.dest)}` };
    run.audition = null;
  }
  if (cur >= B.length - 3) return { kind: 'restart', oi: B.length - 2, di: 0, orig: B[B.length - 2], dest: B[0], why: 'Song ended, started again' };
  if (state.mode === 'normal') return null;
  const seg = state.ana.segments[segIndexAt(pos)];
  const cands = seg.cuts.filter((c) => !(c.oi < cur && c.di < cur) && c.orig > pos + 0.12);
  const name = seg.high ? 'high-energy section' : 'calm section';
  if (state.mode === 'loop') {
    const pref = PREFERRED_LOOP[state.song.id];
    const c = (pref && cands.find((x) => Math.abs(x.orig - pref[0]) < 0.15 && Math.abs(x.dest - pref[1]) < 0.15)) || bestLoop(cands, cur);
    return c && { ...c, kind: 'loop', why: `Loop: back ${(c.orig - c.dest).toFixed(1)} s to keep the ${name} going` };
  }
  const c = bestSkip(cands, cur);
  return c && { ...c, kind: 'skip', why: `Skip: ahead ${(c.dest - c.orig).toFixed(1)} s through the ${name}` };
}

function commit(plan) {
  const c = player.jump(plan.orig, plan.dest);
  const ev = { ...plan, c, t: c - run.ctx0, wall: performance.now() };
  run.pending = ev;
  run.jumps.push(ev);
  setTimeout(() => run && logEvent(ev.t, plan.kind === 'restart' ? 'ev' : plan.kind, `${plan.why} (${fmt(plan.orig)} → ${fmt(plan.dest)})`), Math.max(0, (c - actx.currentTime) * 1000));
}

// ---------------------------------------------------------------- the athlete follows the music
// One squat spans 2, 4, 8 or 16 beats, whichever is closest to a normal ~3 s rep (half time
// on fast songs). Reps are counted along the music actually played, so loops don't break them.
// Each rep shows its number in a speech bubble (text only, no audio).
const repBeats = () => [2, 4, 8, 16].reduce((m, k) => (Math.abs(Math.log((k * state.song.beatDur) / 3)) < Math.abs(Math.log((m * state.song.beatDur) / 3)) ? k : m));

function shout(n) {
  run.bubble = { n, t: performance.now() };
}

function step() {
  if (!run) return;
  const now = actx.currentTime, t = now - run.ctx0;
  if (t < 0) return;
  const pos = player.pos();
  if (run.pending && now > run.pending.c + 0.05) run.pending = null;
  pendingPlan = null;
  if (!run.pending) {
    const plan = decide(pos);
    if (plan) { if (plan.orig - pos < LOOK) commit(plan); else pendingPlan = plan; }
  }
  // what has actually played, for the trajectory plot
  if (!run.hist.length || t - run.hist[run.hist.length - 1].t >= 0.1) run.hist.push({ t, pos });
  // athlete
  const high = state.ana.segments[segIndexAt(pos)].high;
  const dt = Math.max(0, Math.min(0.1, now - (run.last || now)));
  run.last = now;
  if (high && !run.high) {
    run.set++; run.beats = 0; run.reps = 0;
    run.flash = performance.now();
    logEvent(t, 'ev', `🔥 Music went high: set ${run.set}, the athlete starts squatting`);
  } else if (!high && run.high && run.set) {
    logEvent(t, 'ev', `Music calmed down: set ${run.set} done after ${run.reps} reps, resting`);
  }
  run.high = high;
  if (high) {
    run.beats += dt / state.song.beatDur;
    const reps = Math.floor(run.beats / repBeats());
    if (reps > run.reps) { run.reps = reps; run.total++; shout(reps); }
  }
}

function logEvent(t, kind, text) {
  const log = $('#log');
  if (log.firstElementChild && log.firstElementChild.classList.contains('muted')) log.innerHTML = '';
  const ic = { loop: '↺', skip: '⤼', ev: '•' }[kind] || '•';
  log.prepend(el('li', { class: kind }, el('span', { class: 't' }, fmt(t)), el('span', { class: 'ic' }, ic), el('span', {}, text)));
  while (log.children.length > 60) log.lastElementChild.remove();
}

function startPlay(at = null) {
  const ctx = ctxReady();
  ctx.resume();
  stopPlay();
  player = new Player(ctx, master, state.song);
  const when = ctx.currentTime + 0.15;
  const from = at ?? state.song.beats[0];
  player.start(from, when);
  run = { ctx0: when, startPos: from, hist: [], jumps: [], pending: null, set: 0, reps: 0, total: 0, beats: 0, high: false, bubble: null, flash: 0 };
  $('#log').replaceChildren();
  logEvent(0, 'ev', `Playing “${state.song.title}”`);
  $('#startLabel').textContent = 'Stop';
  document.body.classList.add('playing');
}
// Navigate: click or drag on the track, the song map or the trajectory plot.
// Cutpoint explorer: every cutpoint in the section under the playhead, each one auditionable.
let cutSeg = -1;
function renderCuts() {
  if (!state.ana) return;
  const pos = player ? player.pos() : state.song.beats[0];
  // while auditioning, keep showing the section of the auditioned cut
  const si = run && run.audition ? segIndexAt(run.audition.orig - 0.05) : segIndexAt(pos);
  const on = run && run.audition;
  if (on !== renderCuts.on) { renderCuts.on = on; renderCuts.force = true; }
  if (si === cutSeg && !renderCuts.force) return;
  renderCuts.force = false; cutSeg = si;
  const seg = state.ana.segments[si];
  const cuts = [...seg.cuts].sort((a, b) => a.orig - b.orig || a.dest - b.dest);
  $('#cutNote').textContent = `${seg.high ? 'high energy' : 'calm'} · ${fmt(seg.start)}–${fmt(seg.end)} · ${cuts.length}`;
  $('#cutList').replaceChildren(...cuts.map((c) => {
    const loop = c.dest < c.orig;
    const active = on && on.orig === c.orig && on.dest === c.dest;
    return el('div', { class: `cutrow ${loop ? 'loop' : 'skip'}${active ? ' on' : ''}` },
      el('span', { class: 'k' }, loop ? '↺' : '⤼'),
      el('span', {}, `${fmt(c.orig)}.${String(Math.floor((c.orig % 1) * 10))} → ${fmt(c.dest)}.${String(Math.floor((c.dest % 1) * 10))}  (${loop ? '−' : '+'}${Math.abs(c.dest - c.orig).toFixed(1)} s)`),
      el('button', { onclick: () => audition(c) }, '▶ Audition'));
  }));
}
function audition(c) {
  setMode('normal');
  seekTo(Math.max(0, c.orig - 4));
  run.audition = c;
  logEvent(actx.currentTime - run.ctx0, 'ev', `Auditioning ${fmt(c.orig)} → ${fmt(c.dest)}`);
}

function seekTo(pos) {
  if (!state.ana) return;
  pos = Math.max(0, Math.min(state.song.duration - 1, pos));
  // snap to the nearest beat so the music stays on the grid
  const B = state.song.beats, i = beatAt(pos);
  pos = i + 1 < B.length && B[i + 1] - pos < pos - B[i] ? B[i + 1] : B[i];
  if (!run) { startPlay(pos); return; }
  player.seek(pos);
  run.pending = null; pendingPlan = null;
  run.hist.push({ t: actx.currentTime - run.ctx0, pos, seek: true });
  logEvent(actx.currentTime - run.ctx0, 'ev', `Jumped to ${fmt(pos)}`);
}
function makeScrubbable(canvas, toSongTime) {
  let dragging = false;
  const at = (e) => { const r = canvas.getBoundingClientRect(); return toSongTime(e.clientX - r.left, r.width); };
  canvas.style.cursor = 'pointer';
  canvas.addEventListener('pointerdown', (e) => { const t = at(e); if (t == null) return; dragging = true; canvas.setPointerCapture(e.pointerId); seekTo(t); });
  canvas.addEventListener('pointermove', (e) => { hover = { canvas, t: at(e) }; if (dragging && e.buttons) { const t = at(e); if (t != null && Math.abs(t - player.pos()) > 0.4) seekTo(t); } });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointerleave', () => { hover = null; });
}
let hover = null;

function stopPlay() {
  if (player) player.stop();
  run = null; player = null; pendingPlan = null;
  $('#startLabel').textContent = 'Play';
  document.body.classList.remove('playing');
}

// ---------------------------------------------------------------- drawing
function fitCanvas(c) {
  const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  return { g, W: r.width, H: r.height };
}
const font = (w, s) => `${w} ${s}px ui-sans-serif, system-ui, sans-serif`;
function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function beatPhase(pos) {
  const b = state.song.beats;
  let lo = 0, hi = b.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= pos) lo = m; else hi = m; }
  return lo + Math.min(1, Math.max(0, (pos - b[lo]) / ((b[lo + 1] ?? b[lo] + 0.5) - b[lo])));
}

function drawAthlete() {
  const { g, W, H } = fitCanvas($('#athlete'));
  g.clearRect(0, 0, W, H);
  const pos = player ? player.pos() : 0;
  const high = run && state.ana ? state.ana.segments[segIndexAt(pos)].high : false;
  const bp = run ? beatPhase(pos) : performance.now() / 600;
  const pulse = Math.pow(1 - (bp % 1), 3);
  if (run) {
    const grd = g.createRadialGradient(W / 2, H * 0.55, 10, W / 2, H * 0.55, Math.max(W, H) * 0.6);
    grd.addColorStop(0, (high ? COL.high : COL.low) + (high ? '55' : '30'));
    grd.addColorStop(1, 'transparent');
    g.globalAlpha = 0.5 + 0.5 * pulse * (high ? 1 : 0.4);
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
  }
  const gy = H - 30, cx = W / 2;
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(cx - 140, gy, 280, 3);
  const s = Math.min(1.15, H / 250);
  g.strokeStyle = '#ececf4'; g.lineCap = 'round'; g.lineJoin = 'round';
  const line = (x1, y1, x2, y2, w = 6) => { g.lineWidth = w * s; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  const plate = (x, y, glow) => {
    g.fillStyle = '#2a2a3d'; g.strokeStyle = glow ? COL.high : '#9a9ab3'; g.lineWidth = 3 * s;
    g.beginPath(); g.arc(x, y, 24 * s, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#9a9ab3'; g.beginPath(); g.arc(x, y, 4 * s, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ececf4';
  };
  const rackX = cx + 80 * s;
  line(rackX, gy, rackX, gy - 150 * s, 4); line(rackX - 12 * s, gy - 112 * s, rackX + 2 * s, gy - 112 * s, 4);
  const work = high;
  let head;
  if (work) {
    // squat depth follows the reps counted along the music: down on the first half, up on the second
    const d = run ? 0.5 - 0.5 * Math.cos(2 * Math.PI * ((run.beats / repBeats()) % 1)) : 0;
    const fx = cx - 6 * s;
    const hip = [fx - 22 * s * d, gy - 74 * s + 36 * s * d];
    const knee = [fx + 16 * s * d, gy - 38 * s + 4 * s * d];
    const lean = 0.08 + 0.55 * d;
    const sh = [hip[0] + Math.sin(lean) * 62 * s, hip[1] - Math.cos(lean) * 62 * s];
    head = [sh[0] + Math.sin(lean) * 22 * s, sh[1] - Math.cos(lean) * 22 * s];
    line(fx, gy, knee[0], knee[1]); line(knee[0], knee[1], hip[0], hip[1]);
    line(fx, gy, fx + 16 * s, gy, 5);
    line(hip[0], hip[1], sh[0], sh[1], 7);
    line(sh[0], sh[1], sh[0] - 14 * s, sh[1] + 16 * s, 5); line(sh[0] - 14 * s, sh[1] + 16 * s, sh[0] - 4 * s, sh[1] - 4 * s, 5);
    plate(sh[0] - 6 * s, sh[1] - 6 * s, true);
  } else {
    // sitting on a bench, elbows on knees, breathing slowly; the bar waits on the rack
    plate(rackX - 4 * s, gy - 120 * s, false);
    const bx = cx - 70 * s, seatY = gy - 40 * s;
    g.fillStyle = '#2a2a3d'; g.fillRect(bx - 34 * s, seatY, 68 * s, 8 * s);
    g.fillRect(bx - 28 * s, seatY + 8 * s, 6 * s, gy - seatY - 8 * s); g.fillRect(bx + 22 * s, seatY + 8 * s, 6 * s, gy - seatY - 8 * s);
    const br = Math.sin(performance.now() / 900);
    const hip = [bx, seatY - 4 * s];
    const knee = [bx + 36 * s, seatY - 6 * s];
    const foot = [bx + 40 * s, gy];
    const lean = 0.42 + 0.03 * br;
    const sh = [hip[0] + Math.sin(lean) * 58 * s, hip[1] - Math.cos(lean) * 58 * s + 1.5 * s * br];
    head = [sh[0] + Math.sin(lean + 0.2) * 22 * s, sh[1] - Math.cos(lean + 0.2) * 22 * s];
    line(hip[0], hip[1], knee[0], knee[1]); line(knee[0], knee[1], foot[0], foot[1]); line(foot[0], foot[1], foot[0] + 14 * s, gy, 5);
    line(hip[0], hip[1], sh[0], sh[1], 7);
    line(sh[0], sh[1], knee[0] - 4 * s, knee[1] - 4 * s, 5); line(knee[0] - 4 * s, knee[1] - 4 * s, knee[0] + 8 * s, knee[1] - 20 * s, 5);
    // breath puffs
    if (run) {
      const k = (performance.now() / 1800) % 1;
      g.globalAlpha = 0.35 * (1 - k); g.fillStyle = '#9fd0ff';
      g.beginPath(); g.arc(head[0] + 20 * s + k * 18 * s, head[1] + 2 * s - k * 6 * s, (3 + k * 5) * s, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  }
  g.fillStyle = '#ececf4';
  g.beginPath(); g.arc(head[0], head[1], 14 * s, 0, Math.PI * 2); g.fill();
  // rep shout: a speech bubble with the count
  if (run && run.bubble) {
    const k = (performance.now() - run.bubble.t) / 900;
    if (k < 1) {
      const bx = head[0] - 70 * s, by = head[1] - 46 * s, sc = 1 + 0.35 * Math.max(0, 1 - k * 4);
      g.globalAlpha = 1 - Math.max(0, k - 0.6) / 0.4;
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(bx, by, 30 * sc, 22 * sc, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(bx + 14, by + 14); g.lineTo(head[0] - 14 * s, head[1] - 8 * s); g.lineTo(bx + 24, by + 6); g.fill();
      g.fillStyle = '#0b0b12'; g.font = font(900, 24 * sc); g.textAlign = 'center';
      g.fillText(`${run.bubble.n}!`, bx, by + 8 * sc);
      g.textAlign = 'start'; g.globalAlpha = 1;
    }
  }
  // HUD
  g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = font(700, 10);
  g.fillText(!run ? 'PRESS PLAY' : work ? `BACK SQUATS · 1 REP PER ${repBeats()} BEATS` : 'RESTING · WAITING FOR THE MUSIC', 14, 22);
  if (run) {
    g.textAlign = 'right';
    g.font = font(900, 13); g.fillStyle = '#fff';
    g.fillText(run.set ? `SET ${run.set} · REP ${run.reps}` : 'WARMING UP', W - 14, 22);
    g.font = font(700, 10); g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText(`${run.total} REPS TOTAL`, W - 14, 38);
    g.textAlign = 'start';
    if (high) { g.globalAlpha = 0.5 * pulse; g.fillStyle = COL.high; g.fillRect(cx - 140, gy - 1, 280, 5); g.globalAlpha = 1; }
    const k = (performance.now() - run.flash) / 1100;
    if (k < 1) {
      g.globalAlpha = 1 - k; g.font = font(900, 30 + 12 * (1 - k)); g.textAlign = 'center'; g.fillStyle = '#fff';
      g.shadowColor = COL.high; g.shadowBlur = 20;
      g.fillText("LET'S GO!", W / 2, 70 - k * 14);
      g.shadowBlur = 0; g.textAlign = 'start'; g.globalAlpha = 1;
    }
  }
}

function drawMap() {
  const { g, W, H } = fitCanvas($('#map'));
  g.clearRect(0, 0, W, H);
  if (!state.ana) {
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = font(500, 13); g.textAlign = 'center';
    g.fillText(state.song ? 'Loading…' : 'Pick a song to see its sections and cutpoints', W / 2, H / 2); g.textAlign = 'start';
    return;
  }
  const dur = state.song.duration, pad = 10;
  const X = (t) => pad + (t / dur) * (W - 2 * pad);
  if (hover && hover.canvas.id === 'map' && hover.t != null) { g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(X(hover.t), 0, 1, H); g.font = font(700, 10); g.fillStyle = '#fff'; g.fillText(fmt(hover.t), X(hover.t) + 4, H - 16); }
  const mid = H / 2;
  // cutpoint arcs: skips above, loops below
  const arc = (a, b, up, color, alpha, width) => {
    const x1 = X(a), x2 = X(b), h = Math.min(mid - 14, 10 + Math.abs(x2 - x1) * 0.45);
    g.strokeStyle = color; g.globalAlpha = alpha; g.lineWidth = width;
    g.beginPath(); g.moveTo(x1, mid + (up ? -12 : 12));
    g.bezierCurveTo(x1, mid + (up ? -h : h), x2, mid + (up ? -h : h), x2, mid + (up ? -12 : 12));
    g.stroke(); g.globalAlpha = 1;
  };
  if (state.p.showCuts) for (const c of state.ana.cutpoints) arc(c.orig, c.dest, c.dest > c.orig, c.dest > c.orig ? COL.skip : COL.loop, 0.09, 1);
  // segments
  for (const s of state.ana.segments) {
    const h = s.high ? 22 : 12;
    g.fillStyle = s.high ? COL.high : COL.low;
    g.globalAlpha = s.high ? 0.9 : 0.55;
    rr(g, X(s.start) + 1, mid - h / 2, Math.max(2, X(s.end) - X(s.start) - 2), h, 4); g.fill();
  }
  g.globalAlpha = 1;
  drawEdited(g, X, mid - 13, 26, true);
  // taken jumps
  if (run) {
    const now = engine.ctx.currentTime;
    const colOf = (j) => (j.dest < j.orig ? COL.loop : COL.skip);
    for (const j of run.jumps) {
      if (j.kind === 'restart') continue;
      const age = now - j.c;
      if (age < 0) { // locked in, not yet taken
        g.setLineDash([5, 4]); arc(j.orig, j.dest, j.dest > j.orig, colOf(j), 0.9, 2); g.setLineDash([]);
        continue;
      }
      const fresh = Math.max(0, 1 - age / 8);
      arc(j.orig, j.dest, j.dest > j.orig, colOf(j), 0.25 + 0.75 * fresh, 1.5 + 2.5 * fresh);
      // a comet travelling along the arc right after the jump
      if (age < 0.9) {
        const k = age / 0.9, up = j.dest > j.orig;
        const x1 = X(j.orig), x2 = X(j.dest), h = Math.min(mid - 14, 10 + Math.abs(x2 - x1) * 0.45);
        const y0 = mid + (up ? -12 : 12), yc = mid + (up ? -h : h);
        const bz = (a, b, c2, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c2 + t ** 3 * d;
        g.fillStyle = colOf(j); g.shadowColor = colOf(j); g.shadowBlur = 16;
        for (let q = 0; q < 6; q++) {
          const tt = Math.max(0, k - q * 0.04);
          g.globalAlpha = 1 - q / 6;
          g.beginPath(); g.arc(bz(x1, x1, x2, x2, tt), bz(y0, yc, yc, y0, tt), 5 - q * 0.6, 0, Math.PI * 2); g.fill();
        }
        g.globalAlpha = 1; g.shadowBlur = 0;
      }
    }
    if (pendingPlan) {
      g.setLineDash([3, 5]);
      arc(pendingPlan.orig, pendingPlan.dest, pendingPlan.dest > pendingPlan.orig, colOf(pendingPlan), 0.6, 1.5);
      g.setLineDash([]);
    }
    const x = X(player.pos());
    g.fillStyle = '#fff'; g.fillRect(x - 1, 6, 2, H - 12);
    g.beginPath(); g.arc(x, 6, 4, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = font(500, 10);
  g.fillText('0:00', pad, H - 4);
  g.textAlign = 'right'; g.fillText(fmt(dur), W - pad, H - 4); g.textAlign = 'start';
  g.fillText('SKIPS ↑', pad, 12); g.fillText('LOOPS ↓', pad + 52, 12);
}

// Played so far, as two aligned timelines: the original song (top, song time) and what was
// actually played (bottom, playing time). A band links each stretch of music to where it was
// played, so a skipped chunk has no band (hatched on top) and a looped chunk has two (marked
// "again" below).
function playedPieces() {
  const out = [];
  if (!run) return out;
  let cur = null;
  for (const h of run.hist) {
    if (cur && !h.seek && Math.abs(h.pos - cur.p1 - (h.t - cur.t1)) < 0.3) { cur.t1 = h.t; cur.p1 = h.pos; continue; }
    // cut or seek: close the piece at the cut time, start a new one
    if (cur) {
      const j = run.jumps.find((x) => x.t > cur.t1 - 0.01 && x.t <= h.t + 0.01);
      if (j) { cur.p1 = j.orig; cur.t1 = j.t; out.push(cur); cur = { t0: j.t, t1: h.t, p0: j.dest, p1: h.pos, kind: j.kind }; continue; }
      out.push(cur);
    }
    cur = { t0: h.t, t1: h.t, p0: h.pos, p1: h.pos, kind: h.seek ? 'seek' : null };
  }
  if (cur) out.push(cur);
  return out;
}
function drawTraj() {
  const { g, W, H } = fitCanvas($('#traj'));
  g.clearRect(0, 0, W, H);
  if (!state.ana) return;
  const dur = state.song.duration, segs = state.ana.segments;
  const L = 96, R = W - 12, y1 = 18, h1 = 30, y2 = H - 48, h2 = 30;
  const XS = (p) => L + (p / dur) * (R - L);
  const pieces = playedPieces();
  const tEnd = pieces.length ? pieces[pieces.length - 1].t1 : 0;
  const span = Math.max(dur, tEnd * 1.05);
  const XT = (t) => L + (t / span) * (R - L);
  g.font = font(700, 11); g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fillText('Original song', 8, y1 + 19); g.fillText('As played', 8, y2 + 19);
  // top: the song as written
  for (const sg of segs) { g.fillStyle = sg.high ? COL.high : COL.low; g.globalAlpha = sg.high ? 0.85 : 0.45; g.fillRect(XS(sg.start), y1, XS(sg.end) - XS(sg.start) - 1, h1); }
  g.globalAlpha = 1;
  if (!run) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = font(500, 12); g.fillText('Press Play: every skipped or looped chunk shows up here.', L, (y1 + y2) / 2 + 10); return; }
  // how often each part of the song has played
  const cover = new Float32Array(Math.ceil(dur * 4) + 1);
  for (const pc of pieces) for (let u = Math.floor(pc.p0 * 4); u < Math.floor(pc.p1 * 4); u++) if (u >= 0 && u < cover.length) cover[u]++;
  // bands linking song time → playing time
  for (const pc of pieces) {
    if (pc.p1 - pc.p0 < 0.05) continue;
    const hi = segs[segIndexAt((pc.p0 + pc.p1) / 2)].high;
    g.fillStyle = hi ? COL.high : COL.low; g.globalAlpha = 0.18;
    g.beginPath();
    g.moveTo(XS(pc.p0), y1 + h1); g.lineTo(XS(pc.p1), y1 + h1);
    g.bezierCurveTo(XS(pc.p1), (y1 + y2) / 2, XT(pc.t1), (y1 + y2) / 2, XT(pc.t1), y2);
    g.lineTo(XT(pc.t0), y2);
    g.bezierCurveTo(XT(pc.t0), (y1 + y2) / 2, XS(pc.p0), (y1 + y2) / 2, XS(pc.p0), y1 + h1);
    g.fill(); g.globalAlpha = 1;
  }
  // top markings: skipped chunks (never played) and chunks played more than once
  for (let u = 0; u < cover.length; ) {
    const p0 = u / 4;
    if (p0 >= tEnd + run.startPos && p0 > Math.max(...pieces.map((x) => x.p1))) break;
    const c = cover[u];
    let v = u; while (v < cover.length && cover[v] === c) v++;
    const a = XS(u / 4), b = XS(v / 4);
    if (c === 0 && b - a > 2) {
      const before = pieces.some((x) => x.p1 > v / 4) || false;
      if (before) {
        g.save(); g.beginPath(); g.rect(a, y1, b - a, h1); g.clip();
        g.fillStyle = 'rgba(7,7,13,0.75)'; g.fillRect(a, y1, b - a, h1);
        g.strokeStyle = COL.skip; g.lineWidth = 1.5;
        for (let x = a - h1; x < b; x += 7) { g.beginPath(); g.moveTo(x, y1 + h1); g.lineTo(x + h1, y1); g.stroke(); }
        g.restore(); g.strokeStyle = COL.skip; g.strokeRect(a, y1, b - a, h1);
        if (b - a > 46) { g.font = font(800, 10); g.fillStyle = COL.skip; g.fillText('SKIPPED', a + 4, y1 - 4); }
      }
    } else if (c > 1 && b - a > 2) {
      g.strokeStyle = COL.loop; g.lineWidth = 2; g.strokeRect(a, y1, b - a, h1);
      g.fillStyle = COL.loop; g.globalAlpha = 0.35; g.fillRect(a, y1, b - a, h1); g.globalAlpha = 1;
      g.font = font(900, 11); g.fillStyle = COL.loop; g.fillText(`×${c}`, a + 3, y1 - 4);
    }
    u = v;
  }
  // bottom: what was played, in order, coloured by intensity; repeats outlined in yellow
  const seen = new Float32Array(cover.length);
  for (const pc of pieces) {
    for (let u = Math.floor(pc.p0 * 4); u < Math.floor(pc.p1 * 4); u++) {
      if (u < 0 || u >= cover.length) continue;
      const t = pc.t0 + (u / 4 - pc.p0);
      const hi = segs[segIndexAt(u / 4)].high;
      g.fillStyle = hi ? COL.high : COL.low; g.globalAlpha = hi ? 0.85 : 0.45;
      g.fillRect(XT(t), y2, Math.max(1, XT(t + 0.25) - XT(t)), h2);
      g.globalAlpha = 1;
      if (seen[u]++ >= 1) { g.fillStyle = COL.loop; g.globalAlpha = 0.5; g.fillRect(XT(t), y2 + h2 - 6, Math.max(1, XT(t + 0.25) - XT(t)), 6); g.globalAlpha = 1; }
    }
  }
  // cut markers on the played timeline
  for (const j of run.jumps) {
    if (j.c > actx.currentTime || j.kind === 'restart') continue;
    const x = XT(j.t), col = j.dest < j.orig ? COL.loop : COL.skip;
    g.fillStyle = col; g.fillRect(x - 1.5, y2 - 6, 3, h2 + 12);
    g.font = font(800, 10);
    g.fillText(j.dest < j.orig ? `↺ again ${(j.orig - j.dest).toFixed(1)}s` : `⤼ −${(j.dest - j.orig).toFixed(1)}s`, x + 4, y2 + h2 + 13);
  }
  // playheads
  const last = pieces[pieces.length - 1];
  if (last) {
    g.fillStyle = '#fff';
    g.fillRect(XS(last.p1) - 1, y1 - 3, 2, h1 + 6);
    g.fillRect(XT(last.t1) - 1, y2 - 3, 2, h2 + 6);
  }
  g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = font(600, 10);
  g.textAlign = 'right'; g.fillText(`${fmt(span)} of playing`, R, H - 4); g.textAlign = 'start';
}

// Parts of the song changed by cuts that have already happened: skipped stretches, and
// looped stretches with how many times they have played.
function editedRegions() {
  if (!run) return { skipped: [], looped: [] };
  const now = actx.currentTime;
  const skipped = [], loops = new Map();
  for (const j of run.jumps) {
    if (j.c > now || j.kind === 'restart') continue;
    if (j.dest > j.orig) skipped.push({ a: j.orig, b: j.dest });
    else { const k = `${j.dest.toFixed(2)}|${j.orig.toFixed(2)}`; const r = loops.get(k) || { a: j.dest, b: j.orig, n: 1 }; r.n++; loops.set(k, r); }
  }
  return { skipped, looped: [...loops.values()] };
}
function drawEdited(g, X, y, h, small) {
  const { skipped, looped } = editedRegions();
  for (const r of skipped) {
    const x0 = X(r.a), x1 = X(r.b);
    g.save(); g.beginPath(); g.rect(x0, y, x1 - x0, h); g.clip();
    g.fillStyle = 'rgba(7,7,13,0.7)'; g.fillRect(x0, y, x1 - x0, h);
    g.strokeStyle = COL.skip; g.globalAlpha = 0.6; g.lineWidth = 1.5;
    for (let x = x0 - h; x < x1; x += small ? 6 : 12) { g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + h, y); g.stroke(); }
    g.restore();
    g.strokeStyle = COL.skip; g.lineWidth = 1.5; g.strokeRect(x0, y, x1 - x0, h);
    if (x1 - x0 > (small ? 40 : 70)) { g.font = font(800, small ? 9 : 11); g.fillStyle = COL.skip; g.textAlign = 'center'; g.fillText('SKIPPED', (x0 + x1) / 2, y + h / 2 + 4); g.textAlign = 'start'; }
  }
  for (const r of looped) {
    const x0 = X(r.a), x1 = X(r.b);
    g.fillStyle = COL.loop; g.globalAlpha = 0.3; g.fillRect(x0, y, x1 - x0, h); g.globalAlpha = 1;
    g.strokeStyle = COL.loop; g.lineWidth = 2; g.strokeRect(x0, y, x1 - x0, h);
    g.font = font(900, small ? 10 : 13); g.fillStyle = COL.loop; g.textAlign = 'center';
    g.fillText(`↺ PLAYED ×${r.n}`, (x0 + x1) / 2, y + (small ? -3 : 16)); g.textAlign = 'start';
  }
}

// The music coming up, as it will play: if a cut is coming, the track is spliced there.
function futurePath(pos, horizon) {
  const now = actx.currentTime;
  const j = run.pending && run.pending.c > now ? { ...run.pending, committed: true } : pendingPlan;
  if (j && j.orig > pos && j.orig - pos < horizon) {
    const a = j.orig - pos;
    return { jump: j, jumps: [{ ...j, at: a }], pieces: [{ from: pos, to: j.orig, at: 0 }, { from: j.dest, to: j.dest + horizon - a, at: a }] };
  }
  return { jump: null, jumps: [], pieces: [{ from: pos, to: pos + horizon, at: 0 }] };
}
function outlook(pos) {
  const segs = state.ana.segments;
  const highNow = segs[segIndexAt(pos)].high;
  if (run && state.mode === 'loop') return { highNow, t: null, looping: true };
  const { pieces } = run ? futurePath(pos, 600) : { pieces: [{ from: pos, to: pos + 600, at: 0 }] };
  for (const pc of pieces) {
    for (const s of segs) if (s.start > pc.from && s.start < pc.to && s.high !== highNow) return { highNow, t: pc.at + s.start - pc.from };
    if (pc !== pieces[0] && segs[segIndexAt(pc.from)].high !== highNow) return { highNow, t: pc.at };
  }
  return { highNow, t: null };
}

// The main view, in song time: sections, beats and cutpoints around the playhead. An upcoming
// cut is drawn as an arc from where it leaves to where it lands, with the part of the song it
// repeats (loop) or leaves out (skip) highlighted. When the cut happens, the playhead jumps.
let view = null;
function drawTrack() {
  const { g, W, H } = fitCanvas($('#track'));
  g.clearRect(0, 0, W, H);
  if (!state.ana) return;
  const now = performance.now() / 1000;
  const dur = state.song.duration;
  const pos = player ? player.pos() : state.song.beats[0];
  const nowC = actx ? actx.currentTime : 0;
  const j = run && run.pending && run.pending.c > nowC ? { ...run.pending, committed: true } : run ? pendingPlan : null;
  const last = run && run.jumps.length ? run.jumps[run.jumps.length - 1] : null;
  const lastAgo = last ? nowC - last.c : 99;
  // window: playhead plus the whole upcoming cut (and the last one, briefly)
  let w0 = pos - 6, w1 = pos + 22;
  for (const x of [j, lastAgo >= 0 && lastAgo < 2 ? last : null]) if (x && x.kind !== 'restart') { w0 = Math.min(w0, Math.min(x.orig, x.dest) - 4); w1 = Math.max(w1, Math.max(x.orig, x.dest) + 4); }
  w0 = Math.max(0, w0); w1 = Math.min(dur, w1);
  if (!view) view = { w0, w1 };
  view.w0 += (w0 - view.w0) * 0.12; view.w1 += (w1 - view.w1) * 0.12;
  const L = 8, R = W - 8, top = 70, laneH = H - top - 28, mid = top + laneH / 2;
  const X = (u) => L + ((u - view.w0) / (view.w1 - view.w0)) * (R - L);
  const segs = state.ana.segments;

  for (const sg of segs) {
    const a = Math.max(sg.start, view.w0), b = Math.min(sg.end, view.w1);
    if (b <= a) continue;
    const x0 = X(a), x1 = X(b);
    g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, laneH); g.clip();
    if (sg.high) {
      const grd = g.createLinearGradient(0, top, 0, top + laneH);
      grd.addColorStop(0, '#ff8a3d'); grd.addColorStop(0.5, COL.high); grd.addColorStop(1, '#7a1030');
      g.fillStyle = grd; g.globalAlpha = 0.85; g.fillRect(x0, top, x1 - x0, laneH);
      g.globalAlpha = 0.14; g.fillStyle = '#fff';
      const off = (now * 120) % 40;
      for (let x = x0 - laneH - 40 + off; x < x1; x += 40) { g.beginPath(); g.moveTo(x, top + laneH); g.lineTo(x + 14, top + laneH); g.lineTo(x + 14 + laneH, top); g.lineTo(x + laneH, top); g.fill(); }
    } else {
      const grd = g.createLinearGradient(0, top, 0, top + laneH);
      grd.addColorStop(0, '#1b2f55'); grd.addColorStop(1, '#0c1630');
      g.fillStyle = grd; g.globalAlpha = 1; g.fillRect(x0, top, x1 - x0, laneH);
      g.globalAlpha = 0.35; g.strokeStyle = COL.low; g.lineWidth = 1.5;
      for (let k = 0; k < 2; k++) { g.beginPath(); for (let x = x0; x <= x1; x += 6) { const y = mid + (k ? 14 : -10) + Math.sin(x / 26 + now * 1.6 + k) * 5; x === x0 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); }
    }
    g.globalAlpha = 1;
    if (x1 - x0 > 90) { g.font = font(800, 11); g.fillStyle = sg.high ? '#fff' : 'rgba(170,205,255,0.9)'; g.fillText(sg.high ? '🔥 HIGH ENERGY' : '〰 CALM', x0 + 8, top + laneH - 10); }
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(X(sg.start), top, 1, laneH);
  }
  // already played (this pass) is dimmed
  g.fillStyle = 'rgba(7,7,13,0.45)'; g.fillRect(L, top, Math.max(0, X(pos) - L), laneH);
  // cuts that already happened stay marked
  drawEdited(g, X, top, laneH, false);
  // beat ticks + time labels
  const B = state.song.beats;
  for (let i = beatAt(view.w0); i < B.length && B[i] <= view.w1; i++) {
    if (B[i] < view.w0) continue;
    const x = X(B[i]), bar = i % 4 === 0;
    g.fillStyle = bar ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
    g.fillRect(x, top + laneH - (bar ? 14 : 7), 1.2, bar ? 14 : 7);
  }
  g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = font(600, 10);
  for (let u = Math.ceil(view.w0 / 5) * 5; u <= view.w1; u += 5) g.fillText(fmt(u), X(u) - 10, H - 10);
  if (state.p.showCuts) for (const c of state.ana.cutpoints) {
    if (c.orig < view.w0 || c.orig > view.w1 || c.dest < c.orig) continue;
    const x = X(c.orig); g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath(); g.moveTo(x, top - 7); g.lineTo(x + 3, top - 4); g.lineTo(x, top - 1); g.lineTo(x - 3, top - 4); g.fill();
  }

  // upcoming cut: highlight the region, arc from where it leaves to where it lands
  const arcOf = (x) => {
    const xo = X(x.orig), xd = X(x.dest), h = Math.min(top - 12, 18 + Math.abs(xd - xo) * 0.25);
    return { xo, xd, yb: top - 2, yc: top - 2 - h };
  };
  if (j && j.kind !== 'restart') {
    const loop = j.dest < j.orig, col = loop ? COL.loop : COL.skip;
    const a = Math.min(j.orig, j.dest), b = Math.max(j.orig, j.dest);
    const x0 = X(a), x1 = X(b);
    g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, laneH); g.clip();
    if (loop) {
      g.fillStyle = col; g.globalAlpha = 0.28; g.fillRect(x0, top, x1 - x0, laneH);
    } else {
      g.fillStyle = '#07070d'; g.globalAlpha = 0.62; g.fillRect(x0, top, x1 - x0, laneH);
      g.globalAlpha = 0.5; g.strokeStyle = col; g.lineWidth = 2;
      for (let x = x0 - laneH; x < x1; x += 14) { g.beginPath(); g.moveTo(x, top + laneH); g.lineTo(x + laneH, top); g.stroke(); }
    }
    g.restore(); g.globalAlpha = 1;
    g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(x0, top, x1 - x0, laneH);
    g.font = font(900, 13); g.fillStyle = '#fff'; g.textAlign = 'center';
    g.shadowColor = '#000'; g.shadowBlur = 6;
    g.fillText(loop ? `↺ PLAYS AGAIN · ${(j.orig - j.dest).toFixed(1)} s` : `⤼ SKIPPED · ${(j.dest - j.orig).toFixed(1)} s`, (x0 + x1) / 2, mid + 5);
    g.shadowBlur = 0; g.textAlign = 'start';
    // arc with arrowhead at the landing point
    const { xo, xd, yb, yc } = arcOf(j);
    const pulse = 0.5 + 0.5 * Math.sin(now * 8);
    g.strokeStyle = col; g.lineWidth = 3; g.shadowColor = col; g.shadowBlur = 8 + 8 * pulse;
    if (!j.committed) g.setLineDash([7, 5]);
    g.beginPath(); g.moveTo(xo, yb); g.bezierCurveTo(xo, yc, xd, yc, xd, yb); g.stroke(); g.setLineDash([]);
    g.shadowBlur = 0; g.fillStyle = col;
    g.beginPath(); g.moveTo(xd, yb + 2); g.lineTo(xd - 6, yb - 9); g.lineTo(xd + 6, yb - 9); g.fill();
    // leave / land markers
    g.fillRect(xo - 2, top, 4, laneH);
    g.globalAlpha = 0.8; g.fillRect(xd - 1, top, 2, laneH); g.globalAlpha = 1;
    g.font = font(800, 10); g.fillStyle = col;
    g.fillText('LEAVES', xo + 5, top + 12); g.fillText('LANDS', xd + 5, top + 12);
    // label above the arc
    const label = `${loop ? '↺ LOOP' : '⤼ SKIP'} in ${(j.orig - pos).toFixed(1)} s · ${fmt(j.orig)} → ${fmt(j.dest)}${j.committed ? ' · locked in' : ''}`;
    g.font = font(800, 12);
    const tw = g.measureText(label).width + 16;
    const lx = Math.max(L, Math.min(R - tw, (xo + xd) / 2 - tw / 2)), ly = Math.max(4, yc - 26);
    g.fillStyle = col; rr(g, lx, ly, tw, 20, 10); g.fill();
    g.fillStyle = '#0b0b12'; g.fillText(label, lx + 8, ly + 14);
  }
  // the cut that just happened: comet along its arc
  if (last && last.kind !== 'restart' && lastAgo >= 0 && lastAgo < 1.2) {
    const k = Math.min(1, lastAgo / 0.6), col = last.dest < last.orig ? COL.loop : COL.skip;
    const { xo, xd, yb, yc } = arcOf(last);
    const bz = (a, b, c2, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c2 + t ** 3 * d;
    g.globalAlpha = 1 - lastAgo / 1.2;
    g.strokeStyle = col; g.lineWidth = 3;
    g.beginPath(); g.moveTo(xo, yb); g.bezierCurveTo(xo, yc, xd, yc, xd, yb); g.stroke();
    g.fillStyle = '#fff'; g.shadowColor = col; g.shadowBlur = 18;
    g.beginPath(); g.arc(bz(xo, xo, xd, xd, k), bz(yb, yc, yc, yb, k), 7, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    g.font = font(900, 22); g.textAlign = 'center'; g.fillStyle = '#fff';
    g.fillText(last.dest < last.orig ? '↺ LOOP!' : '⤼ SKIP!', xd, mid + 8);
    g.textAlign = 'start'; g.globalAlpha = 1;
  }
  // playhead
  const beatPulse = Math.pow(1 - (beatPhase(pos) % 1), 2);
  const xp = X(pos);
  g.fillStyle = '#fff'; g.shadowColor = '#fff'; g.shadowBlur = 6 + 12 * beatPulse;
  g.fillRect(xp - 1.5, top - 4, 3, laneH + 8);
  g.beginPath(); g.arc(xp, mid, 7 + 4 * beatPulse, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.font = font(700, 10); g.fillStyle = '#fff'; g.fillText('NOW', xp - 11, top + laneH + 14);
  if (hover && hover.canvas.id === 'track' && hover.t != null) {
    const xh = X(hover.t);
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(xh, top, 1, laneH);
    g.font = font(700, 10); g.fillStyle = '#fff'; g.fillText(`▶ ${fmt(hover.t)}`, xh + 4, top + 24);
  }

  // countdown HUD
  const o = outlook(pos);
  const txt = o.highNow
    ? (o.looping ? '🔥 HIGH ENERGY · looping' : o.t == null ? '🔥 HIGH ENERGY' : `🔥 HIGH ENERGY · ${Math.ceil(o.t)}s left`)
    : (o.t == null ? '〰 CALM' : `🔥 HIGH ENERGY IN ${o.t.toFixed(1)}s`);
  g.font = font(900, 14);
  const tw = g.measureText(txt).width + 20;
  g.fillStyle = o.highNow ? COL.high : 'rgba(90,169,255,0.18)';
  rr(g, R - tw, 6, tw, 26, 13); g.fill();
  g.strokeStyle = o.highNow ? '#ffb3bd' : COL.low; g.lineWidth = 1.5; g.stroke();
  g.fillStyle = '#fff'; g.fillText(txt, R - tw + 10, 24);
}

// Whole-song strip under the track (as in the MARingBA player): sections, what has been
// skipped or looped, the playhead, and the time under the cursor. Click or drag to move.
function drawOverview() {
  const { g, W, H } = fitCanvas($('#overview'));
  g.clearRect(0, 0, W, H);
  if (!state.ana) return;
  const dur = state.song.duration, X = (t) => 10 + (t / dur) * (W - 20);
  for (const sg of state.ana.segments) {
    g.fillStyle = sg.high ? COL.high : COL.low; g.globalAlpha = sg.high ? 0.85 : 0.5;
    g.fillRect(X(sg.start), 8, X(sg.end) - X(sg.start) - 1, H - 16);
  }
  g.globalAlpha = 1;
  drawEdited(g, X, 8, H - 16, true);
  if (hover && hover.canvas.id === 'overview' && hover.t != null) {
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(X(hover.t), 2, 1, H - 4);
    g.font = font(700, 10); g.fillStyle = '#fff'; g.fillText(fmt(hover.t), Math.min(W - 30, X(hover.t) + 4), 12);
  }
  const p = player ? player.pos() : state.song.beats[0];
  g.fillStyle = '#fff'; g.fillRect(X(p) - 1.5, 2, 3, H - 4);
}

// ---------------------------------------------------------------- UI
function frame() {
  step();
  renderCuts();
  drawAthlete(); drawTrack(); drawOverview(); drawTraj(); drawMap();
  if (run && state.ana) {
    const pos = player.pos(), high = state.ana.segments[segIndexAt(pos)].high;
    $('#statMusic').textContent = high ? 'High energy' : 'Calm';
    $('#statMusic').style.color = high ? COL.high : COL.low;
    $('#statPos').textContent = fmt(pos);
    $('#statSet').textContent = run.set ? `${run.set}` : '–';
    $('#statReps').textContent = `${run.total}`;
  }
  requestAnimationFrame(frame);
}

function setMode(m) {
  state.mode = m;
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  if (run) logEvent(actx.currentTime - run.ctx0, 'ev', m === 'loop' ? 'Mode: loop this section' : m === 'skip' ? 'Mode: skip ahead' : 'Mode: play normally');
}
const TOGGLES = [
  { key: 'showCuts', label: 'Show all cutpoints', hint: 'Diamonds on the track and faint arcs on the song map: every seamless jump the song allows.' },
];
function buildControls() {
  const g = el('div', { class: 'group' }, el('h3', {}, 'Options'));
  for (const c of TOGGLES) {
    const input = el('button', { class: 'switch', role: 'switch', 'aria-label': c.label, 'aria-checked': String(state.p[c.key]), onclick: () => { state.p[c.key] = !state.p[c.key]; input.setAttribute('aria-checked', String(state.p[c.key])); } });
    g.append(el('div', { class: 'ctl' }, el('div', { class: 'ctl-row' }, el('span', { class: 'ctl-label' }, c.label), input), el('div', { class: 'ctl-hint' }, c.hint)));
  }
  $('#controls').append(g);
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode('normal');
}

function buildSongs() {
  const groups = [['Featured songs', SONGS.filter((x) => x.study)], ['More songs', SONGS.filter((x) => !x.study)]];
  const list = $('#songList');
  let i = 0;
  for (const [name, songs] of groups) {
    list.append(el('div', { class: 'song-group' }, name));
    for (const s of songs) {
      const h = (i++ * 47 + 250) % 360;
      const b = el('button', { class: 'song', role: 'option', 'aria-selected': 'false', 'data-id': s.id, onclick: () => selectSong(s, b) },
        el('div', { class: 'art', style: `background: linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 60) % 360} 70% 35%))` }),
        el('div', { class: 't' }, s.title));
      list.append(b);
    }
  }
}

async function loadMeta(s) {
  const dir = `rise-assets/${encodeURIComponent(s.id)}/`;
  const [beatsT, segJ] = await Promise.all([
    fetch(dir + 'beat_times.csv').then((r) => { if (!r.ok) throw new Error('missing beat_times.csv'); return r.text(); }),
    fetch(dir + 'combined_segments.json').then((r) => r.json()),
  ]);
  const beats = beatsT.split(/[\s,]+/).filter(Boolean).map(Number);
  const d = beats.slice(1).map((x, i) => x - beats[i]).sort((a, b) => a - b);
  const beatDur = d[d.length >> 1];
  return { beats, beatDur, segJ };
}
function buildSegments(beats, segJ, duration) {
  const at = (i) => beats[Math.min(i, beats.length - 1)];
  return segJ.segments.map((g, si) => ({
    a: g.start, b: g.end, start: at(g.start), end: si === segJ.segments.length - 1 ? duration : at(g.end), high: g.label === 'high',
    // Pairs are undirected, as in AudioController.cs (loop: later → earlier beat, skip: earlier → later).
    cuts: [...new Map(parsePairs(g.transitions).flatMap(([o, t]) => [[o, t], [t, o]]).filter(([o, t]) => o !== t && o < beats.length && t < beats.length).map((p) => [p.join(), p])).values()]
      .map(([o, t]) => ({ oi: o, di: t, orig: at(o), dest: at(t), seg: si })),
  }));
}

const parsePairs = (t) => (typeof t === 'string' ? [...t.matchAll(/\((\d+),\s*(\d+)\)/g)].map((m) => [+m[1], +m[2]]) : (t || []));
let token = 0;
async function selectSong(s, btn) {
  const my = ++token;
  stopPlay();
  state.ana = null; state.song = null;
  document.querySelectorAll('.song').forEach((b) => { b.setAttribute('aria-selected', String(b === btn)); b.classList.remove('loading'); });
  btn.classList.add('loading');
  $('#startBtn').disabled = true;
  $('#songStatus').textContent = 'Loading…';
  try {
    const ctx = ctxReady();
    const dir = `rise-assets/${encodeURIComponent(s.id)}/`;
    const [{ beats, beatDur, segJ }, buf] = await Promise.all([
      loadMeta(s),
      bufCache.get(s.id) || fetch(dir + encodeURIComponent(s.file)).then((r) => { if (!r.ok) throw new Error('missing audio'); return r.arrayBuffer(); }).then((a) => ctx.decodeAudioData(a)),
    ]);
    bufCache.clear(); bufCache.set(s.id, buf);
    if (my !== token) return;
    const song = { ...s, buf, beats, beatDur, duration: buf.duration };
    const segments = buildSegments(beats, segJ, buf.duration);
    state.song = song;
    renderCuts.force = true; cutSeg = -1;
    state.ana = { segments, cutpoints: segments.flatMap((x) => x.cuts) };
    const hi = segments.filter((x) => x.high).reduce((a, x) => a + x.end - x.start, 0);
    $('#mapNote').textContent = `${segments.length} sections · ${Math.round((100 * hi) / buf.duration)}% high intensity · ${state.ana.cutpoints.length} cutpoints · ${Math.round(60 / song.beatDur)} BPM`;
    $('#songStatus').textContent = '';
    $('#startBtn').disabled = false;
  } catch (e) {
    console.error(e);
    if (my === token) $('#songStatus').textContent = `Couldn’t load: ${e.message}`;
  } finally {
    btn.classList.remove('loading');
  }
}

$('#startBtn').addEventListener('click', () => (run ? stopPlay() : startPlay()));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space' && state.ana) { e.preventDefault(); run ? stopPlay() : startPlay(); }
  else if (e.key === 'ArrowRight' && run) { e.preventDefault(); seekTo(player.pos() + 5); }
  else if (e.key === 'ArrowLeft' && run) { e.preventDefault(); seekTo(player.pos() - 5); }
  else if (e.key === 'l' || e.key === 'L') setMode('loop');
  else if (e.key === 's' || e.key === 'S') setMode('skip');
  else if (e.key === 'n' || e.key === 'N') setMode('normal');
});

buildControls();
makeScrubbable($('#overview'), (x, w) => state.ana ? Math.max(0, ((x - 10) / (w - 20)) * state.song.duration) : null);
makeScrubbable($('#map'), (x, w) => state.ana ? Math.max(0, ((x - 10) / (w - 20)) * state.song.duration) : null);
makeScrubbable($('#track'), (x, w) => (view && state.ana ? view.w0 + ((x - 8) / (w - 16)) * (view.w1 - view.w0) : null));
requestAnimationFrame(frame);
fetch('js/rise-songs.json').then((r) => r.json()).then((list) => {
  SONGS = list; buildSongs();
  const first = SONGS.find((x) => x.id === 'humble') || SONGS[0];
  document.querySelector(`.song[data-id="${first.id}"]`)?.click();
});
fetch('rise-assets/humble/beat_times.csv', { method: 'HEAD' })
  .then((r) => { if (!r.ok) $('#missing').hidden = false; })
  .catch(() => { $('#missing').hidden = false; });

window.__rise = { state, get run() { return run; }, get player() { return player; }, startPlay, stopPlay, setMode };
