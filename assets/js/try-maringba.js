// MARingBA project page: pick a song and a delivery style, press Ring, and hear the ringtone
// arrive. Runs the same engine as the paper's demo, in the browser.
import { Engine } from '/listensback/js/engine.js';
import { SONGS, RINGTONES, PRESETS } from '/listensback/js/data.js';

const PAIRS = [
  { song: 'hotline', ring: 'classic', reps: [3, 2] },
  { song: 'nothing', ring: 'iphone', reps: [3, 2] },
  { song: 'whatislove', ring: 'discord', reps: [1, 1] },
].map((p) => ({ ...p, s: SONGS.find((x) => x.id === p.song), r: RINGTONES.find((x) => x.id === p.ring) }));
const STYLES = [
  ['conventional', 'Standard', 'How phones ring today: right away, and the music ducks.'],
  ['subtle', 'MARingBA', 'Waits for a musical moment, in the song’s tempo and key, blended into the mix.'],
];

const root = document.getElementById('try-mar');
const $ = (s) => root.querySelector(s);
root.innerHTML = `
  <div class="try-row"><span class="try-lab">Song</span><div class="try-chips" data-k="song">${PAIRS.map((p, i) => `<button type="button" data-i="${i}">${p.s.title}</button>`).join('')}</div></div>
  <div class="try-row"><span class="try-lab">Ringtone</span><div class="try-chips" data-k="style">${STYLES.map(([id, l, t], i) => `<button type="button" data-i="${i}" title="${t}">${l}</button>`).join('')}</div></div>
  <div class="try-player">
    <button type="button" class="try-pp" aria-label="Play or pause">▶</button>
    <div class="try-bar"><i class="try-ring"></i><i class="try-head"></i></div>
    <button type="button" class="try-go" disabled>🔔 Ring</button>
  </div>
  <p class="try-status"></p>`;

const engine = new Engine();
const st = { pair: null, style: 1, loading: false };
const preset = (id) => ({ ...PRESETS.find((p) => p.id === id).params });
// the same settings as the story's MARingBA ring: the next phrase, or a spot where the music
// comes back in, a few seconds ahead
function sweetSpots() {
  const a = engine.song.analysis, f = a.freq[0], n = f.length;
  const hi = [...f].sort((x, y) => x - y)[n >> 1] * 0.75, out = [];
  for (let i = 4; i < n; i++) { if (f[i] < hi) continue; let k = 0; while (k < 24 && i - 1 - k >= 0 && f[i - 1 - k] < hi) k++; if (k >= 3) out.push(i); }
  return out;
}
const params = () => {
  const id = STYLES[st.style][0];
  if (id === 'conventional') return { ...preset(id), repeats: st.pair.reps[0] };
  return { ...preset(id), repeats: st.pair.reps[1], sweet: sweetSpots(), lenient: 16, minLead: 6 };
};
function mark() {
  for (const b of root.querySelectorAll('[data-k="song"] button')) b.classList.toggle('on', st.pair && +b.dataset.i === PAIRS.indexOf(st.pair));
  for (const b of root.querySelectorAll('[data-k="style"] button')) b.classList.toggle('on', +b.dataset.i === st.style);
}
async function pick(i) {
  if (st.loading) return;
  st.loading = true; st.pair = PAIRS[i]; mark();
  $('.try-status').textContent = `Loading ${st.pair.s.title}…`; $('.try-go').disabled = true;
  try {
    engine.ensureContext(); await engine.ctx.resume();
    engine.stop(); engine.dismiss();
    await engine.loadSong(st.pair.s);
    engine.applyParams(params());
    await engine.prepare(st.pair.r, params());
    engine.seek(Math.min(30, engine.song.duration / 4)); engine.play();
    $('.try-go').disabled = false; $('.try-status').textContent = '';
  } catch (e) { console.error(e); $('.try-status').textContent = 'Couldn’t load the audio.'; }
  st.loading = false;
}
root.querySelector('[data-k="song"]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pick(+b.dataset.i); });
root.querySelector('[data-k="style"]').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  st.style = +b.dataset.i; mark();
  if (engine.song) { engine.dismiss(); engine.applyParams(params()); }
});
$('.try-pp').addEventListener('click', () => { if (!engine.song) return pick(0); engine.playing ? engine.stop() : engine.play(); });
$('.try-go').addEventListener('click', async () => { if (!engine.song) return; engine.applyParams(params()); await engine.trigger(st.pair.r, params()); });
$('.try-bar').addEventListener('click', (e) => {
  if (!engine.song) return; const r = e.currentTarget.getBoundingClientRect();
  engine.dismiss(); engine.seek(((e.clientX - r.left) / r.width) * engine.song.duration); if (!engine.playing) engine.play();
});
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
(function tick() {
  requestAnimationFrame(tick);
  $('.try-pp').textContent = engine.playing ? '❚❚' : '▶';
  if (!engine.song) return;
  const d = engine.song.duration, t = engine.time, ring = engine.ring;
  $('.try-head').style.left = `${(100 * t) / d}%`;
  const rr = $('.try-ring');
  if (ring) { rr.style.left = `${(100 * ring.t0) / d}%`; rr.style.width = `${Math.max(0.6, (100 * (ring.t1 - ring.t0)) / d)}%`; rr.hidden = false; } else rr.hidden = true;
  if (!st.loading && ring) $('.try-status').textContent = t < ring.t0 ? `Rings in ${(ring.t0 - t).toFixed(1)} s, when the music makes room` : t < ring.t1 ? 'Ringing…' : '';
  else if (!st.loading && engine.song && !ring) $('.try-status').textContent = '';
})();
mark();
