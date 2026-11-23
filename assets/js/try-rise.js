// RISE project page, on The Middle (Zedd, Maren Morris & Grey): the two comparisons from the
// interactive story, laid out the same way (one lane above the other, each with its own play
// button), redrawn for the page. Loop is red and skip is blue, as in the paper.
const DIR = '/listensback/rise-assets/middle/';
const SKIP = { from: 124, cut: [131.3, 140.2], to: 156 };
const LOOPC = '#ff4d5e', SKIPC = '#5cc8ff', INK = '#22305a', XF = 0.025;
const TABS = [
  { label: 'Skip to the drop', note: 'The song is still calm. RISE skips ahead so the energy comes back sooner.', h: 250,
    lanes: [{ l: 0, label: 'As written', col: '#e6e9f0', fg: INK, top: 52 }, { l: 1, label: 'With skip', col: SKIPC, fg: '#fff', top: 156 }] },
  { label: 'Loop or skip in the drop', note: 'Inside the drop, RISE can play a part again or leave it out, at matching beats.', h: 320,
    lanes: [{ l: 2, label: 'Loop B', col: LOOPC, fg: '#fff', top: 54 }, { l: 3, label: 'Skip B', col: SKIPC, fg: '#fff', top: 198 }] },
];

const root = document.getElementById('try-rise');
const $ = (s) => root.querySelector(s);
root.innerHTML = `
  <div class="rise-tabs">${TABS.map((t, i) => `<button type="button" data-t="${i}">${t.label}</button>`).join('')}</div>
  <div class="rise-fig"><canvas></canvas><div class="rise-flash" aria-hidden="true"><svg viewBox="0 0 80 40"><polygon class="ar-skip" points="4,16 52,16 52,4 76,20 52,36 52,24 4,24"/><polygon class="ar-loop" points="76,16 28,16 28,4 4,20 28,36 28,24 76,24"/></svg><span></span></div><button type="button" class="rise-play"><i></i><span></span></button><button type="button" class="rise-play"><i></i><span></span></button></div>`;

let ctx = null, data = null, tab = 0, play = null;
const cv = root.querySelector('canvas'), g = cv.getContext('2d');
async function load() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const [bt, sj, buf] = await Promise.all([
    fetch(DIR + 'beat_times.csv').then((r) => r.text()),
    fetch(DIR + 'combined_segments.json').then((r) => r.json()),
    fetch(DIR + 'middle.mp3').then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a)),
  ]);
  const B = bt.split(/[\s,]+/).filter(Boolean).map(Number), at = (i) => B[Math.min(i, B.length - 1)];
  const pairs = (t) => (typeof t === 'string' ? [...t.matchAll(/\((\d+),\s*(\d+)\)/g)].map((m) => [+m[1], +m[2]]) : t || []);
  const segs = sj.segments.map((g, i) => ({ start: at(g.start), end: i === sj.segments.length - 1 ? buf.duration : at(g.end), high: g.label === 'high',
    cuts: pairs(g.transitions).flatMap(([o, d]) => [[o, d], [d, o]]).map(([o, d]) => ({ orig: at(o), dest: at(d) })) }));
  // the same pair of matching beats as the story: about 8 s apart, near the middle of the drop
  const drop = segs.find((x) => x.high && x.start > SKIP.from), mid = (drop.start + drop.end) / 2;
  const cand = drop.cuts.filter((c) => c.dest > c.orig && c.orig > drop.start + 3 && c.dest < drop.end - 3);
  const pr = cand.reduce((b, c) => (!b || Math.abs(c.dest - c.orig - 8) + Math.abs((c.orig + c.dest) / 2 - mid) * 0.5 < Math.abs(b.dest - b.orig - 8) + Math.abs((b.orig + b.dest) / 2 - mid) * 0.5 ? c : b), null);
  data = { buf, segs, hiAt: drop.start, drop: { start: drop.start, end: drop.end, x: pr.orig, y: pr.dest } };
}
// what a lane plays: from, the jump (o → d, none for "as written"), and where it ends
function plan(l) {
  const D = data.drop;
  if (l === 0) return { from: SKIP.from, o: null, end: SKIP.to };
  if (l === 1) return { from: SKIP.from, o: SKIP.cut[0], d: SKIP.cut[1], end: SKIP.to };
  const from = Math.max(D.start, D.x - 3), end = D.end + 2;
  return l === 2 ? { from, o: D.y, d: D.x, end } : { from, o: D.x, d: D.y, end };
}
function stop() { if (!play) return; const n = ctx.currentTime; for (const v of play.v) { v.g.gain.setTargetAtTime(0, n, 0.08); try { v.s.stop(n + 0.4); } catch {} } play = null; }
// play lane l from song time `at` (default: its usual start); `jumped` = already past its jump
async function start(l, at = null, jumped = false) {
  if (!data) return; stop(); await ctx.resume();
  const p = plan(l), when = ctx.currentTime + 0.08, v = [];
  if (at == null) at = p.from;
  const voice = (pos, t0, until, fadeIn) => {
    const g = ctx.createGain(); g.connect(ctx.destination);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + fadeIn);
    if (until) { g.gain.setValueAtTime(1, until - XF); g.gain.linearRampToValueAtTime(0, until + XF); }
    const s = ctx.createBufferSource(); s.buffer = data.buf; s.connect(g); s.start(t0, pos); if (until) s.stop(until + XF + 0.02);
    v.push({ g, s });
  };
  const fade = at === p.from ? 1.2 : 0.15;
  let jumpAt = null, endAt;
  if (p.o == null || jumped || at >= p.o) {
    // no jump ahead of us: just play on from here
    voice(at, when, null, fade); endAt = when + Math.max(1.5, p.end - at);
    if (p.o != null) jumpAt = when - (at - p.d); // already jumped: positions continue past d
  } else { jumpAt = when + (p.o - at); voice(at, when, jumpAt, fade); voice(p.d - XF, jumpAt - XF, null, XF); endAt = jumpAt + (p.end - p.d); }
  for (const x of v) { x.g.gain.setValueAtTime(1, Math.max(when + 0.2, endAt - 1.5)); x.g.gain.linearRampToValueAtTime(0, endAt); try { x.s.stop(endAt + 0.05); } catch {} }
  play = { l, p, when: when - (at - p.from), jumpAt, endAt, v, jumped: p.o != null && (jumped || at >= p.o) };
}
function pos() {
  if (!play) return null; const n = ctx.currentTime;
  if (n > play.endAt) { play = null; return null; }
  return play.jumpAt != null && n >= play.jumpAt ? play.p.d + (n - play.jumpAt) : play.p.from + (n - play.when);
}
function setTab(i) {
  stop(); tab = i; const T = TABS[i];
  for (const b of root.querySelectorAll('.rise-tabs button')) b.classList.toggle('on', +b.dataset.t === i);
  $('.rise-fig').style.height = T.h + 'px';
  root.querySelectorAll('.rise-play').forEach((b, k) => { const ln = T.lanes[k]; b.dataset.l = ln.l; b.querySelector('span').textContent = ln.label; b.style.top = ln.top + 'px'; b.style.background = ln.col; b.style.color = ln.fg; });
}
root.querySelector('.rise-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(+b.dataset.t); });
for (const b of root.querySelectorAll('.rise-play')) b.addEventListener('click', () => (play && play.l === +b.dataset.l ? stop() : start(+b.dataset.l)));

// room on the left for the play buttons (they shrink on phones)
const lanePad = (W) => (W < 520 ? 108 : 150);

// ---- clickable timelines, as in the story: click a lane (or its "played" track) to play from there
function hit(x, y) {
  if (!data) return null;
  const W = cv.clientWidth, L = lanePad(W), R = W - 14; if (x < L || x > R) return null;
  if (tab === 0) {
    const from = SKIP.from - 2, t = from + ((x - L) / (R - L)) * (SKIP.to - from);
    for (const [l, y0] of [[0, 46], [1, 150]]) if (y >= y0 - 6 && y <= y0 + 52) {
      if (l === 1 && t > SKIP.cut[0] && t < SKIP.cut[1]) return { l, at: SKIP.cut[1], jumped: true }; // inside the skipped stretch
      return { l, at: Math.max(SKIP.from, t), jumped: l === 1 && t >= SKIP.cut[1] };
    }
    return null;
  }
  const D = data.drop, from = D.start - 2, to = D.end + 3, t = from + ((x - L) / (R - L)) * (to - from);
  const A = D.x - D.start, Bl = D.y - D.x, C = D.end - D.y, SC = (R - L) / (A + 2 * Bl + C);
  for (const [l, y0, loop] of [[2, 52, true], [3, 196, false]]) {
    if (y >= y0 - 6 && y <= y0 + 40) { // the song lane
      const at = Math.min(D.end, Math.max(D.start, t));
      if (!loop && at > D.x && at < D.y) return { l, at: D.y, jumped: true };
      return { l, at, jumped: !loop && at >= D.y };
    }
    const py = y0 + 34 + 26;
    if (y >= py - 6 && y <= py + 28) { // the "played" track: A B B C or A C
      const st = (x - L) / SC;
      if (loop) return st < A + Bl ? { l, at: D.start + st, jumped: false } : { l, at: D.x + (st - A - Bl), jumped: true };
      return st < A ? { l, at: D.start + st, jumped: false } : { l, at: D.y + (st - A), jumped: true };
    }
  }
  return null;
}
const cvXY = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('click', (e) => { const h = hit(...cvXY(e)); if (h) start(h.l, h.at, h.jumped); });
cv.addEventListener('mousemove', (e) => { cv.style.cursor = hit(...cvXY(e)) ? 'pointer' : 'default'; });

// ---- drawing (light version of the story's figures)
const text = (s, x, y, { size = 11, w = 700, col = INK, mono = false, align = 'left' } = {}) => {
  g.font = mono ? `600 ${size}px ui-monospace, Menlo, monospace` : `${w} ${size}px system-ui, -apple-system, sans-serif`;
  g.fillStyle = col; g.textAlign = align; g.fillText(s, x, y); g.textAlign = 'left';
};
const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
const hot = (y, h) => { const grd = g.createLinearGradient(0, y, 0, y + h); grd.addColorStop(0, '#ffb15c'); grd.addColorStop(1, '#e8573a'); return grd; };
function arc(xa, xb, y, col, label) {
  g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.moveTo(xa, y - 2); g.bezierCurveTo(xa, y - 28, xb, y - 28, xb, y - 2); g.stroke();
  g.fillStyle = col; g.beginPath(); g.moveTo(xb, y); g.lineTo(xb - 6, y - 9); g.lineTo(xb + 6, y - 9); g.fill();
  text(label, (xa + xb) / 2, y - 24, { size: 11, w: 800, col, align: 'center' });
}
function drawSkip(W, P) {
  const L = lanePad(W), R = W - 14, o = { from: SKIP.from - 2, to: SKIP.to, start: SKIP.from }, X = (s) => L + ((s - o.from) / (o.to - o.from)) * (R - L), h = 46;
  const lanes = [{ y: 46, sub: `energy back after ${(data.hiAt - o.start).toFixed(0)} s` }, { y: 150, sub: `energy back after ${(data.hiAt - o.start - (SKIP.cut[1] - SKIP.cut[0])).toFixed(0)} s` }];
  lanes.forEach((ln, li) => {
    for (const sg of data.segs) {
      const x0 = Math.max(L, X(sg.start)), x1 = Math.min(R, X(sg.end)); if (x1 <= x0) continue;
      g.fillStyle = sg.high ? hot(ln.y, h) : '#e6e9f0'; g.fillRect(x0, ln.y, x1 - x0, h);
      if (x1 - x0 > 70) text(sg.high ? '🔥 HIGH ENERGY' : '〰 calm', x0 + 8, ln.y + h - 9, { size: 10.5, w: 800, col: sg.high ? '#fff' : '#6a6f78' });
    }
    g.fillStyle = 'rgba(34,48,90,0.35)'; g.fillRect(X(o.start) - 0.5, ln.y - 4, 1, h + 8);
    if (li === 1) {
      const xa = X(SKIP.cut[0]), xb = X(SKIP.cut[1]);
      g.save(); g.beginPath(); g.rect(xa, ln.y, xb - xa, h); g.clip();
      g.fillStyle = '#fafbfc'; g.fillRect(xa, ln.y, xb - xa, h);
      g.strokeStyle = 'rgba(92,200,255,0.6)'; g.lineWidth = 1.5;
      for (let x = xa - h; x < xb; x += 7) { g.beginPath(); g.moveTo(x, ln.y + h); g.lineTo(x + h, ln.y); g.stroke(); }
      g.restore();
      arc(xa, xb, ln.y, SKIPC, `⤼ skip +${(SKIP.cut[1] - SKIP.cut[0]).toFixed(1)} s`);
    }
    text(ln.sub, R, ln.y + h + 16, { size: 11, w: 700, col: li ? '#1f8fc6' : '#9aa0a8', align: 'right' });
    if (play && play.l === li && P != null) { const x = X(P); g.fillStyle = INK; g.fillRect(x - 1.5, ln.y - 6, 3, h + 12); g.beginPath(); g.arc(x, ln.y + h / 2, 6, 0, Math.PI * 2); g.fill(); }
  });
}
function drawCut(W, P) {
  const L = lanePad(W), R = W - 14, D = data.drop, from = D.start - 2, to = D.end + 3, X = (s) => L + ((s - from) / (to - from)) * (R - L), h = 34, ph = 22;
  const A = D.x - D.start, Bl = D.y - D.x, C = D.end - D.y, SC = (R - L) / (A + 2 * Bl + C);
  const block = (x, w, y, hh, k, col, alpha = 1) => {
    g.globalAlpha = alpha; g.fillStyle = col || hot(y, hh); rr(x + 1, y, Math.max(2, w - 2), hh, 4); g.fill(); g.globalAlpha = 1;
    if (w > 18) text(k, x + w / 2, y + hh / 2 + 5, { size: hh > 26 ? 16 : 13, w: 900, align: 'center', col: alpha < 1 ? 'rgba(34,48,90,0.45)' : '#fff' });
  };
  const lanes = [{ y: 52, loop: true, cap: 'Loop: drop extended', col: LOOPC, l: 2 }, { y: 196, loop: false, cap: 'Skip: drop shortened', col: SKIPC, l: 3 }];
  for (const ln of lanes) {
    const playing = play && play.l === ln.l && P != null;
    g.fillStyle = '#e6e9f0'; g.fillRect(X(from), ln.y, X(to) - X(from), h);
    for (const [k, a, b] of [['A', D.start, D.x], ['B', D.x, D.y], ['C', D.y, D.end]]) block(X(a), X(b) - X(a), ln.y, h, k, null, k === 'B' && !ln.loop ? 0.3 : 1);
    const xa = X(D.x), xb = X(D.y);
    arc(ln.loop ? xb : xa, ln.loop ? xa : xb, ln.y, ln.col, ln.loop ? `↺ back ${Bl.toFixed(1)} s` : `⤼ ahead ${Bl.toFixed(1)} s`);
    if (playing) { const x = X(P); g.fillStyle = INK; g.fillRect(x - 1.5, ln.y - 5, 3, h + 10); }
    // what is actually heard: A B B C (second B in purple) or A C
    const py = ln.y + h + 26;
    text('played', L - 8, py + 15, { size: 10, mono: true, col: '#9aa0a8', align: 'right' });
    const seq = ln.loop ? [['A', A, null], ['B', Bl, null], ['B', Bl, '#b04ad6'], ['C', C, null]] : [['A', A, null], ['C', C, null]];
    let x = L; for (const [k, len, col] of seq) { block(x, len * SC, py, ph, k, col); x += len * SC; }
    text(`${ln.cap} · ${seq.reduce((a, q) => a + q[1], 0).toFixed(0)} s`, R, py + ph + 15, { size: 11, w: 700, col: '#6a6f78', align: 'right' });
    if (playing) {
      const jumped = play.jumped || (play.jumpAt != null && ctx.currentTime >= play.jumpAt);
      const st = jumped ? (ln.loop ? (D.y - D.start) + (P - D.x) : (D.x - D.start) + (P - D.y)) : P - D.start;
      const xp = L + Math.max(0, st) * SC; g.fillStyle = INK; g.fillRect(xp - 1.5, py - 5, 3, ph + 10); g.beginPath(); g.arc(xp, py + ph / 2, 5, 0, Math.PI * 2); g.fill();
    }
  }
}
(function draw() {
  requestAnimationFrame(draw);
  const dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  for (const b of root.querySelectorAll('.rise-play')) b.classList.toggle('on', !!play && play.l === +b.dataset.l);
  if (!data) return;
  const P = pos();
  if (play && play.jumpAt != null && !play.jumped && !play.flashed && ctx.currentTime >= play.jumpAt - 0.02) {
    play.flashed = true;
    const el = $('.rise-flash'), kind = play.p.d < play.p.o ? 'loop' : 'skip';
    el.className = 'rise-flash ' + kind; el.querySelector('span').textContent = kind === 'loop' ? 'LOOP' : 'SKIP';
    void el.offsetWidth; el.classList.add('go');
  }
  tab === 0 ? drawSkip(W, P) : drawCut(W, P);
})();
setTab(0);
load().catch((e) => console.error(e));
