// Musical Agents project page: one player for all the audio examples. The timeline marks where
// the agent sings the message, and the message plays like a lyric video, word by word.
// Data: /musicassistant/clips.json. Open the page with ?edit to mark times and fix text.
const EDIT = new URLSearchParams(location.search).has('edit');
const KEY = 'mva.clips.edit';

const root = document.getElementById('try-mva');
root.classList.add('lv');
const $ = (s) => root.querySelector(s);
const audio = new Audio(); audio.preload = 'auto';
let CLIPS = [], cur = 0;

async function boot() {
  CLIPS = await fetch('clips.json', { cache: 'no-store' }).then((r) => r.json());
  if (EDIT) { try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved && saved.length === CLIPS.length) CLIPS = saved; } catch {} }
  root.innerHTML = `
    <div class="lv-songs">${CLIPS.map((c, i) => `<button type="button" data-i="${i}"><b>${c.title}</b><span>${c.artist}</span></button>`).join('')}</div>
    <div class="lv-stage" aria-live="off"><div class="lv-line"></div></div>
    <div class="try-player">
      <button type="button" class="try-pp" aria-label="Play or pause">▶</button>
      <div class="try-bar"><i class="try-ring"></i><i class="try-head"></i></div>
      <span class="lv-time">0:00</span>
    </div>
    ${EDIT ? '<div class="lv-edit"></div>' : ''}`;
  root.querySelector('.lv-songs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) select(+b.dataset.i); });
  $('.try-pp').addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
  $('.try-bar').addEventListener('click', (e) => {
    if (!audio.duration) return; const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; if (audio.paused) audio.play().catch(() => {});
  });
  audio.addEventListener('ended', () => { if (!EDIT) select((cur + 1) % CLIPS.length); });
  select(0, false);
  tick();
}

// the line: just the message, its words lighting up one after another as they are sung
function build() {
  const c = CLIPS[cur], words = c.msg.split(' ');
  // spread the span over the words by length, so longer words take longer
  const total = words.reduce((n, w) => n + w.length + 2, 0), [a, b] = c.at;
  let acc = 0;
  $('.lv-line').innerHTML = '<span class="lv-q">“</span>' + words.map((w) => {
    const w0 = a + ((b - a) * acc) / total; acc += w.length + 2; const w1 = a + ((b - a) * acc) / total;
    return `<span class="lv-w" data-a="${w0.toFixed(3)}" data-b="${w1.toFixed(3)}">${w}</span>`;
  }).join(' ') + '<span class="lv-q">”</span>';
  if (EDIT) editor();
}
function select(i, play = true) {
  cur = i; const c = CLIPS[i];
  for (const b of root.querySelectorAll('.lv-songs button')) b.classList.toggle('on', +b.dataset.i === i);
  audio.src = encodeURI(c.src); build();
  if (play) audio.play().catch(() => {});
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function tick() {
  requestAnimationFrame(tick);
  const c = CLIPS[cur], t = audio.currentTime, d = audio.duration || 1;
  $('.try-pp').textContent = audio.paused ? '▶' : '❚❚';
  $('.try-head').style.left = `${(100 * t) / d}%`;
  const r = $('.try-ring'); r.style.left = `${(100 * c.at[0]) / d}%`; r.style.width = `${(100 * (c.at[1] - c.at[0])) / d}%`;
  $('.lv-time').textContent = EDIT ? t.toFixed(2) : fmt(t);
  for (const w of root.querySelectorAll('.lv-w')) {
    const a = +w.dataset.a, b = +w.dataset.b, k = Math.max(0, Math.min(1, (t - a) / (b - a)));
    w.style.setProperty('--k', `${(k * 100).toFixed(1)}%`);
    w.classList.toggle('now', t >= a && t < b); w.classList.toggle('done', t >= b);
  }
  root.classList.toggle('singing', t >= c.at[0] && t < c.at[1]);
}

// ---------------------------------------------------------------- editing (?edit)
// Mark where each part starts and ends while listening, fix the text, then download clips.json.
const r2 = (x) => Math.round(x * 100) / 100;
function save() { try { localStorage.setItem(KEY, JSON.stringify(CLIPS)); } catch {} build(); }
function editor() {
  const c = CLIPS[cur], box = $('.lv-edit');
  const row = (label, a, b, text, i) => `
    <div class="lv-row" data-i="${i}">
      <span class="lv-k">${label}</span>
      <button type="button" data-set="a" title="Set start to the playhead">⇤ now</button><input type="number" step="0.05" data-f="a" value="${a}">
      <button type="button" data-set="b" title="Set end to the playhead">now ⇥</button><input type="number" step="0.05" data-f="b" value="${b}">
      <button type="button" data-play title="Play this part">▶</button>
      <input type="text" data-f="text" value="${(text || '').replace(/"/g, '&quot;')}" placeholder="${i === 'msg' ? 'message' : 'words sung here (optional)'}">
      ${i === 'msg' ? '' : '<button type="button" data-del title="Remove">✕</button>'}
    </div>`;
  box.innerHTML = `
    <p class="lv-help">Edit mode. Keys: <kbd>space</kbd> play/pause · <kbd>[</kbd> message start · <kbd>]</kbd> message end · <kbd>←</kbd>/<kbd>→</kbd> ±0.5 s. Changes are kept in this browser until you download.</p>
    ${row('Message', c.at[0], c.at[1], c.msg, 'msg')}
    <div class="lv-row lv-actions">
      <span style="flex:1"></span>
      <button type="button" data-reset>Reset this song</button>
      <button type="button" data-copy>Copy JSON</button>
      <button type="button" data-dl class="lv-dl">Download clips.json</button>
    </div>`;
}
function setField(i, f, v) {
  const c = CLIPS[cur];
  if (i === 'msg') { if (f === 'text') c.msg = v; else c.at[f === 'a' ? 0 : 1] = r2(+v); }
}
if (EDIT) {
  root.addEventListener('change', (e) => { const inp = e.target.closest('.lv-row input'); if (!inp) return; setField(inp.closest('.lv-row').dataset.i, inp.dataset.f, inp.value); save(); });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('.lv-edit button'); if (!b) return;
    const rowEl = b.closest('.lv-row'), i = rowEl && rowEl.dataset.i, c = CLIPS[cur];
    if (b.dataset.set) { setField(i, b.dataset.set, audio.currentTime); save(); }
    else if (b.hasAttribute('data-play')) { const [a] = c.at; audio.currentTime = Math.max(0, a - 0.5); audio.play().catch(() => {}); }
    else if (b.hasAttribute('data-reset')) { const orig = await fetch('clips.json', { cache: 'no-store' }).then((r) => r.json()); CLIPS[cur] = orig[cur]; save(); }
    else if (b.hasAttribute('data-copy')) { await navigator.clipboard.writeText(JSON.stringify(CLIPS, null, 1)); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy JSON'), 1200); }
    else if (b.hasAttribute('data-dl')) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(CLIPS, null, 1)], { type: 'application/json' })); a.download = 'clips.json'; a.click(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input')) return;
    if (e.code === 'Space') { e.preventDefault(); audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    else if (e.key === '[') { setField('msg', 'a', audio.currentTime); save(); }
    else if (e.key === ']') { setField('msg', 'b', audio.currentTime); save(); }
    else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 0.5);
    else if (e.key === 'ArrowRight') audio.currentTime = audio.currentTime + 0.5;
  });
}
boot().catch((e) => { console.error(e); root.textContent = 'Couldn’t load the examples.'; });
