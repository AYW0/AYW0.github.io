// Musical assistant demo: sings a spoken notification into the current song.
import { SONGS, MAJOR_MAP, keyLabel } from './data.js';
import { Engine } from './engine.js';
import { Overview } from './timeline.js';
import * as V from './voice.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const dbToGain = (db) => Math.pow(10, db / 20);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = (m) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

// Pre-rendered with macOS `say -v Samantha` (see README); `say` is what the TTS speaks.
const MESSAGES = [
  { id: 'meds', text: 'Remember to take your meds' },
  { id: 'flight', text: 'Your flight to New York is boarding soon' },
  { id: 'report', text: 'Project report due at 3 pm today', say: 'Project report due at three p m today' },
  { id: 'invite', text: 'New calendar invite from Sam' },
  { id: 'turn', text: 'In five hundred feet, turn left' },
  { id: 'battery', text: 'Your battery is running low' },
];

const MODES = [
  { id: 'musical', label: 'Musical', tag: 'Sings it in the song', blurb: 'The assistant replaces the singer for a bar or two, singing the message to the beat and the singer’s own melody. The band keeps playing.' },
  { id: 'standard', label: 'Standard', tag: 'Ducks the music', blurb: 'What assistants do today: the music drops right away and the message is spoken over it, then the music comes back.' },
];

const engine = new Engine();
const state = {
  song: null,
  msg: MESSAGES[0],
  custom: '',
  p: { mode: 'musical', grid: 0, fitTempo: true, schedule: 'bar', maxBars: 2, replaceVocals: true, reverb: 25, level: 5 },
};
let notif = null;
let lastSung = null;
const melCache = new Map();
const ttsCache = new Map();

// ---------------------------------------------------------------- controls
const CONTROLS = [
  {
    title: 'Rhythm', items: [
      { key: 'grid', type: 'seg', label: 'Pace', options: [[0, 'Auto'], [2, '8th notes'], [4, '16th notes']], hint: 'Typical note length. Syllables are then fitted to standard one-beat rhythms (♩, ♫, dotted ♪ + 16th, …).' },
      { key: 'fitTempo', type: 'toggle', label: 'Lock speech to the pulse', hint: 'Speed up or slow down the speech so syllables fall one grid step apart. Off keeps the spoken tempo, as in the paper.' },
      { key: 'maxBars', type: 'seg', label: 'Fit within', options: [[1, '1 bar'], [2, '2 bars'], [4, '4 bars']], hint: 'Long messages are sped up to fit. The paper uses 2 bars.' },
      { key: 'schedule', type: 'seg', label: 'Start on', options: [['bar', 'Next bar'], ['phrase', 'Next phrase']] },
    ],
  },
  {
    title: 'Mix', items: [
      { key: 'replaceVocals', type: 'toggle', label: 'Replace the singer', hint: 'Mute the original vocals while the assistant sings.' },
      { key: 'reverb', type: 'range', label: 'Reverb', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` },
      { key: 'level', type: 'range', label: 'Voice level', min: -12, max: 12, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
    ],
  },
];
const refs = [];
function buildControls() {
  const root = $('#controls');
  for (const group of CONTROLS) {
    const g = el('div', { class: 'group' }, el('h3', {}, group.title));
    for (const c of group.items) {
      const val = el('span', { class: 'ctl-val' });
      let input;
      if (c.type === 'toggle') input = el('button', { class: 'switch', role: 'switch', 'aria-label': c.label, onclick: () => setP(c.key, !state.p[c.key]) });
      else if (c.type === 'seg') input = el('div', { class: 'seg', role: 'group', 'aria-label': c.label }, ...c.options.map(([v, l]) => el('button', { 'data-v': String(v), onclick: () => setP(c.key, v) }, l)));
      else input = el('input', { type: 'range', min: c.min, max: c.max, step: c.step, 'aria-label': c.label, oninput: (e) => setP(c.key, +e.target.value) });
      const row = el('div', { class: 'ctl-row' }, el('span', { class: 'ctl-label' }, c.label), c.type === 'toggle' ? input : val);
      const wrap = el('div', { class: 'ctl' }, row, c.type === 'toggle' ? null : input, c.hint ? el('div', { class: 'ctl-hint' }, c.hint) : null);
      refs.push({ c, input, val, wrap });
      g.append(wrap);
    }
    root.append(g);
  }
  const modes = $('#modeList');
  for (const m of MODES) modes.append(el('button', { class: 'preset', role: 'radio', 'data-id': m.id, onclick: () => setP('mode', m.id) }, el('div', { class: 'n' }, m.label), el('div', { class: 'tg' }, m.tag)));
}
function sync() {
  const p = state.p;
  for (const { c, input, val, wrap } of refs) {
    const v = p[c.key];
    if (c.type === 'toggle') input.setAttribute('aria-checked', String(!!v));
    else if (c.type === 'seg') input.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
    else { input.value = v; val.textContent = c.fmt(v); }
    wrap.classList.toggle('disabled', p.mode === 'standard');
  }
  document.querySelectorAll('#modeList .preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === p.mode)));
  $('#modeBlurb').textContent = MODES.find((m) => m.id === p.mode).blurb;
  document.querySelectorAll('.msg').forEach((b) => b.setAttribute('aria-checked', String(!state.custom && b.dataset.id === state.msg.id)));
  $('#voiceNote').textContent = state.custom ? 'Typed messages use the eSpeak voice' : 'Voice: Samantha (macOS TTS)';
}
function setP(k, v) {
  state.p = { ...state.p, [k]: v };
  if (k === 'reverb' && voice) voice.send.gain.setTargetAtTime(v / 100, engine.ctx.currentTime, 0.05);
  if (k === 'level' && voice) voice.bus.gain.setTargetAtTime(dbToGain(v), engine.ctx.currentTime, 0.05);
  sync();
}

function buildMessages() {
  const list = $('#msgList');
  for (const m of MESSAGES) {
    list.append(el('button', { class: 'msg', role: 'radio', 'data-id': m.id, onclick: () => { state.msg = m; state.custom = ''; $('#msgText').value = ''; sync(); } }, m.text));
  }
  $('#msgText').addEventListener('input', (e) => { state.custom = e.target.value.trim(); sync(); });
  $('#msgText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); notify(); } });
}

// ---------------------------------------------------------------- songs
function buildSongs() {
  const list = $('#songList');
  SONGS.forEach((s, i) => {
    const h = (i * 47 + 250) % 360;
    const b = el('button', { class: 'song', role: 'option', 'aria-selected': 'false', onclick: () => selectSong(s, b) },
      el('div', { class: 'art', 'data-bpm': `${Math.round(s.bpm)} BPM`, style: `background: linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 60) % 360} 70% 35%))` }),
      el('div', { class: 't' }, s.title), el('div', { class: 'a' }, s.artist));
    list.append(b);
  });
}

let loadToken = 0;
async function selectSong(s, btn) {
  const token = ++loadToken;
  stopNotif();
  document.querySelectorAll('.song').forEach((b) => { b.setAttribute('aria-selected', String(b === btn)); b.classList.remove('loading'); });
  btn.classList.add('loading');
  $('#playBtn').disabled = true;
  $('#notifyBtn').disabled = true;
  $('#nowTitle').textContent = s.title;
  $('#nowSub').textContent = s.artist;
  try {
    await engine.loadSong(s, (m) => { if (token === loadToken) $('#songStatus').textContent = m; });
    if (token !== loadToken) return;
    ensureVoice();
    $('#songStatus').textContent = 'Tracking the singer’s melody…';
    await new Promise((r) => setTimeout(r, 30));
    const mel = await melodyFor(engine.song);
    if (token !== loadToken) return;
    state.song = engine.song;
    state.mel = mel;
    $('#songStatus').textContent = '';
    $('#statBpm').textContent = s.bpm.toFixed(1);
    $('#statKey').textContent = keyLabel(s.key);
    $('#playBtn').disabled = false;
    $('#notifyBtn').disabled = false;
    engine.play();
  } catch (e) {
    console.error(e);
    if (token === loadToken) $('#songStatus').textContent = `Couldn’t load: ${e.message}`;
  } finally {
    btn.classList.remove('loading');
  }
}

// YIN over the whole separated vocal stem at 8 kHz: the "original melody".
async function melodyFor(song) {
  if (melCache.has(song.id)) return melCache.get(song.id);
  const x = await V.toMono(song.vocals, 8000);
  const tr = V.yin(x, 8000, { hop: 0.01, fmin: 80, fmax: 1000, thresh: 0.18, gateDb: -38 });
  const ms = [];
  for (let k = 0; k < tr.f0.length; k++) if (tr.f0[k] && tr.conf[k] > 0.75) ms.push(V.hzToMidi(tr.f0[k]));
  ms.sort((a, b) => a - b);
  const lo = ms.length ? ms[Math.floor(ms.length * 0.03)] : 52, hi = ms.length ? ms[Math.floor(ms.length * 0.97)] : 76;
  const mel = { ...tr, lo: Math.floor(lo) - 3, hi: Math.ceil(hi) + 3 };
  melCache.set(song.id, mel);
  return mel;
}

// ---------------------------------------------------------------- audio graph for the voice
let voice = null;
function ensureVoice() {
  if (voice) return voice;
  const ctx = engine.ensureContext();
  const bus = ctx.createGain();
  bus.gain.value = dbToGain(state.p.level);
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.12;
  const send = ctx.createGain(); send.gain.value = state.p.reverb / 100;
  const conv = ctx.createConvolver();
  const sr = ctx.sampleRate, len = Math.floor(sr * 1.6);
  const ir = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(10, (-3 * i) / (sr * 1.6)) * 0.35;
  }
  conv.buffer = ir;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  bus.connect(hp).connect(comp);
  comp.connect(engine.master);
  comp.connect(send).connect(conv).connect(engine.master);
  comp.connect(analyser);
  voice = { bus, send, analyser, buf: new Float32Array(512), nodes: [] };
  return voice;
}

// ---------------------------------------------------------------- TTS
async function getTTS() {
  const ctx = engine.ensureContext();
  const custom = state.custom;
  const text = custom || state.msg.text;
  const spoken = custom ? V.normalizeText(custom) : (state.msg.say || state.msg.text);
  const key = custom ? `es:${spoken}` : `mac:${state.msg.id}`;
  if (!ttsCache.has(key)) {
    let buf;
    if (custom) {
      if (!window.meSpeak) throw new Error('eSpeak voice failed to load');
      const wav = window.meSpeak.speak(spoken, { rawdata: 'arraybuffer', speed: 150, pitch: 45, wordgap: 1 });
      if (!wav) throw new Error('eSpeak could not say that');
      buf = await ctx.decodeAudioData(wav);
    } else {
      const r = await fetch(`tts/${state.msg.id}.mp3`);
      if (!r.ok) throw new Error(`Missing tts/${state.msg.id}.mp3`);
      buf = await ctx.decodeAudioData(await r.arrayBuffer());
    }
    ttsCache.set(key, buf);
  }
  return { buf: ttsCache.get(key), text, spoken, engine: custom ? 'eSpeak' : 'Samantha' };
}

// ---------------------------------------------------------------- composing
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const PRE = 0.2; // seconds of lead-in before the downbeat (for the first consonant)

// Song time of a grid slot counted from beat index `b0`, following the real beat grid.
function slotTime(b0, slot, grid) {
  const a = state.song.analysis, beats = a.beats;
  const at = (i) => (i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * a.beatDur);
  const b = slot / grid, i = Math.floor(b), f = b - i;
  return at(b0 + i) + f * (at(b0 + i + 1) - at(b0 + i));
}

async function compose(tts) {
  const song = state.song, a = song.analysis, mel = state.mel, p = state.p;
  const sr = 22050;
  const x = await V.toMono(tts.buf, sr);
  const tr = V.yin(x, sr, { hop: 0.005, fmin: 70, fmax: 450, thresh: 0.15, gateDb: -35 });
  const sylText = V.syllabify(tts.spoken);
  const syl = V.segmentSyllables(x, sr, sylText.length, tr);
  const labels = syl.length === sylText.length ? sylText : null;
  const vf = []; for (const f of tr.f0) if (f) vf.push(f);
  const voiceMidi = vf.length ? V.hzToMidi(median(vf)) : 57;

  // Start: the next bar (or 4-bar phrase) that is at least a moment away.
  const nb = engine.nextBeatIndex(engine.time + 0.35 + PRE);
  const list = p.schedule === 'phrase' ? a.phraseIdx : a.downbeatIdx;
  const b0 = list.find((i) => i >= nb) ?? nb;
  if (b0 >= a.beats.length - 2) throw new Error('Too close to the end of the song');
  const t0 = a.beats[b0];

  const q = V.quantize(syl, { beatDur: a.beatDur, grid: p.grid, maxBeats: p.maxBars * 4, fitTempo: p.fitTempo });
  const G = q.grid;
  const spanEnd = slotTime(b0, q.slots, G);

  // Melody source: the singer under these same bars, or the nearest bars where they sing.
  // A window is usable if the singer is audible under most notes and the line actually moves.
  const melodyAt = (d) => {
    const ps = q.notes.map((nt) => V.pitchUnder(mel, slotTime(d, nt.slot, G), slotTime(d, nt.slot + nt.slots, G)));
    const hit = ps.filter((m) => m != null);
    return { hit: hit.length / ps.length, distinct: new Set(hit.map(Math.round)).size };
  };
  let mb0 = b0, borrowed = false;
  const here = melodyAt(b0);
  const cover = here.hit;
  if (here.hit < 0.5 || here.distinct < 2) {
    let best = -Infinity;
    for (const d of a.downbeatIdx) {
      if (a.beats[d] + 1 > song.duration) continue;
      const m = melodyAt(d);
      if (m.hit < 0.6) continue;
      const score = m.hit + 0.2 * Math.min(1, (m.distinct - 1) / 3) - 0.003 * Math.abs(a.beats[d] - t0);
      if (score > best) { best = score; mb0 = d; }
    }
    borrowed = mb0 !== b0;
  }
  const notes = q.notes.map((nt) => ({
    ...nt,
    t: slotTime(b0, nt.slot, G), t1: slotTime(b0, nt.slot + nt.slots, G),
    rawT: slotTime(b0, nt.raw, G),
    ma: slotTime(mb0, nt.slot, G), mb: slotTime(mb0, nt.slot + nt.slots, G),
  }));
  const root = MAJOR_MAP[song.key - 1];
  const { pitches, octave, fromSong } = V.assignPitches(notes, mel, {
    beatDur: a.beatDur, scalePcs: MAJOR.map((i) => (root + i) % 12), tonic: root, voiceMidi,
  });
  notes.forEach((nt, i) => { nt.midi = pitches[i]; nt.songMidi = pitches[i] - 12 * octave; nt.label = labels ? labels[i] : ''; nt.fromSong = fromSong[i]; });

  // The buffer starts PRE seconds before the downbeat so the first consonant can lead it.
  const segs = V.buildSegments(notes, t0 - PRE);
  const end = notes[notes.length - 1].t1;
  const y = V.psola(x, sr, tr, segs, end - t0 + PRE + 0.4);

  // Match the singer's loudness in these bars.
  const vd = song.vocals.getChannelData(0);
  const vsr = song.vocals.sampleRate;
  const vocalRms = V.rmsOf(vd.subarray(Math.floor(t0 * vsr), Math.floor(spanEnd * vsr)));
  const target = Math.max(0.05, Math.min(0.2, vocalRms * 1.1));
  const g = target / (V.rmsOf(y) || 1);
  for (let i = 0; i < y.length; i++) y[i] *= g;

  const ctx = engine.ctx;
  const buf = ctx.createBuffer(1, y.length, sr);
  buf.copyToChannel(y, 0);
  return { mode: 'musical', buf, notes, t0, t1: end, b0, mb0, borrowed, cover, q, octave, voiceMidi, syl, labels, tts, sylCount: sylText.length };
}

// ---------------------------------------------------------------- playback


function stopNotif() {
  if (!voice || !engine.ctx) { notif = null; return; }
  const now = engine.ctx.currentTime;
  for (const n of voice.nodes) { try { n.stop(now + 0.05); } catch {} }
  voice.nodes = [];
  for (const g of [engine.vocalGain.gain, engine.accGain.gain]) { g.cancelScheduledValues(0); g.setTargetAtTime(1, now, 0.08); }
  if (notif) { notif = null; onNotifEnd(); }
}

function playBuf(buf, when) {
  const s = engine.ctx.createBufferSource();
  s.buffer = buf;
  s.connect(voice.bus);
  s.start(when);
  voice.nodes.push(s);
  return s;
}

let busy = false;
async function notify() {
  if (!state.song || busy) return;
  busy = true;
  stopNotif();
  ensureVoice();
  if (!engine.playing) engine.play();
  $('#notifyLabel').textContent = 'Composing…';
  try {
    const tts = await getTTS();
    const ctx = engine.ctx;
    if (state.p.mode === 'standard') {
      const lead = 0.35;
      const t0 = engine.time + lead;
      const c0 = ctx.currentTime + lead;
      const dur = tts.buf.duration;
      for (const g of [engine.vocalGain.gain, engine.accGain.gain]) {
        g.cancelScheduledValues(0);
        g.setTargetAtTime(dbToGain(-24), ctx.currentTime, 0.06);
        g.setTargetAtTime(1, c0 + dur + 0.3, 0.2);
      }
      voice.send.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      playBuf(tts.buf, c0);
      notif = { mode: 'standard', t0, t1: t0 + dur, tts };
    } else {
      const n = await compose(tts);
      lastSung = n.buf;
      $('#hearSung').disabled = false;
      const c0 = engine.ctxTime(n.t0), c1 = engine.ctxTime(n.t1);
      if (c0 - PRE < ctx.currentTime + 0.02) throw new Error('Missed the bar, try again');
      voice.send.gain.setTargetAtTime(state.p.reverb / 100, ctx.currentTime, 0.02);
      const vg = engine.vocalGain.gain, ag = engine.accGain.gain;
      for (const g of [vg, ag]) { g.cancelScheduledValues(0); g.setTargetAtTime(1, ctx.currentTime, 0.02); }
      if (state.p.replaceVocals) { vg.setTargetAtTime(0, c0 - 0.12, 0.03); vg.setTargetAtTime(1, c1 + 0.1, 0.1); }
      ag.setTargetAtTime(dbToGain(-3), c0 - 0.1, 0.05);
      ag.setTargetAtTime(1, c1 + 0.1, 0.15);
      playBuf(n.buf, c0 - PRE);
      notif = n;
    }
    explain(notif);
    $('#notifyBtn').classList.add('ringing');
    $('#notifyLabel').textContent = 'Stop';
  } catch (e) {
    console.error(e);
    $('#explain').replaceChildren(el('p', { class: 'muted' }, `Couldn’t notify: ${e.message}`));
    $('#notifyLabel').textContent = 'Notify';
  } finally {
    busy = false;
  }
}

function onNotifEnd() {
  $('#notifyBtn').classList.remove('ringing');
  $('#notifyLabel').textContent = 'Notify';
}

async function preview(which) {
  ensureVoice();
  engine.ctx.resume();
  for (const n of voice.nodes) { try { n.stop(); } catch {} }
  voice.nodes = [];
  try {
    const buf = which === 'speech' ? (await getTTS()).buf : lastSung;
    if (buf) playBuf(buf, engine.ctx.currentTime + 0.02);
  } catch (e) {
    $('#explain').replaceChildren(el('p', { class: 'muted' }, e.message));
  }
}

// ---------------------------------------------------------------- explanation
function explain(n) {
  const li = (k, on, ...v) => el('li', { class: on ? 'on' : 'off' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, ...v));
  const items = [];
  if (n.mode === 'standard') {
    items.push(li('Speech', false, `“${n.tts.text}”, spoken by ${n.tts.engine}`));
    items.push(li('Timing', false, 'Starts right away, wherever the song is'));
    items.push(li('Mix', false, 'Whole song lowered 24 dB, then brought back'));
  } else {
    const p = state.p, song = state.song;
    const sylEls = n.labels ? n.labels.map((s, i) => [i ? ' · ' : '', el('span', {}, s)]).flat() : [`${n.notes.length} syllables`];
    items.push(li('Syllables', true, el('span', { class: 'syls' }, ...sylEls),
      n.labels ? '' : ` (text suggests ${n.sylCount}, audio showed ${n.notes.length})`));
        const beats = n.q.slots / n.q.grid;
    const sp = 1 / n.q.alpha;
    items.push(li('Rhythm', true, `${n.q.cells.map((c) => (c.on.length ? c.name : '𝄽')).join(' | ')}  at ${song.bpm.toFixed(0)} BPM, vowels on the beat grid${Math.abs(sp - 1) > 0.03 ? `; speech ${sp > 1 ? 'sped up' : 'slowed'} ×${sp.toFixed(2)} to an ${n.q.pace === 2 ? '8th' : '16th'}-note pace` : ''}`));
    const range = n.notes.map((x) => x.songMidi);
    const mt = state.song.analysis.beats[n.mb0];
    items.push(li('Melody', true, n.borrowed
      ? `No singing in these bars, so pitches come from the singer at ${fmtTime(mt)}`
      : `Pitches taken from the singer in these same bars (${fmtTime(n.t0)})`,
      `, ${noteName(Math.min(...range))}–${noteName(Math.max(...range))}${n.octave ? `, moved ${Math.abs(n.octave)} octave${Math.abs(n.octave) > 1 ? 's' : ''} ${n.octave > 0 ? 'up' : 'down'} for the voice` : ''}`));
    items.push(li('Mix', p.replaceVocals, p.replaceVocals ? 'Singer muted for those bars; band 3 dB lower' : 'Sung over the original singer; band 3 dB lower', p.reverb ? ` · ${p.reverb}% reverb` : ''));
  }
  $('#explain').replaceChildren(el('ul', {}, ...items));
}

// ---------------------------------------------------------------- piano roll
class Roll {
  constructor(c) {
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
    const laneTop = 22, laneH = 22, top = laneTop + laneH + 14, bot = H - 14;
    const Y = (m) => bot - ((m - mel.lo) / (mel.hi - mel.lo)) * (bot - top);
    const muted = n && n.mode === 'musical' && state.p.replaceVocals;

    // Octave lines.
    g.font = font(500, 10);
    for (let m = Math.ceil(mel.lo / 12) * 12; m <= mel.hi; m += 12) {
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, Y(m), W, 1);
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillText(noteName(m), W - 26, Y(m) - 3);
    }
    // Beats and bars.
    let i = engine.nextBeatIndex(tL);
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

// ---------------------------------------------------------------- loop + wiring
const roll = new Roll($('#roll'));
const overview = new Overview($('#overview'), (t) => engine.seek(t));
const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff9f5a';

function frame() {
  const song = state.song, t = engine.time;
  let level = 0;
  if (voice) { voice.analyser.getFloatTimeDomainData(voice.buf); for (const v of voice.buf) level = Math.max(level, Math.abs(v)); }
  if (notif && engine.playing && t > notif.t1 + 0.4) { notif = null; onNotifEnd(); }
  roll.draw(song, state.mel, t, notif, accent, Math.min(0.6, level));
  overview.draw(song, t, notif, accent);
  if (song) $('#statTime').textContent = `${fmtTime(t)} / ${fmtTime(song.duration)}`;
  requestAnimationFrame(frame);
}

engine.addEventListener('statechange', () => {
  document.body.classList.toggle('playing', engine.playing);
  $('#playBtn').setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
  if (!engine.playing && notif) stopNotif();
});

$('#playBtn').addEventListener('click', () => engine.toggle());
$('#notifyBtn').addEventListener('click', () => (notif ? stopNotif() : notify()));
$('#hearSpeech').addEventListener('click', () => preview('speech'));
$('#hearSung').addEventListener('click', () => preview('sung'));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space') { e.preventDefault(); if (state.song) engine.toggle(); }
  else if (e.key === 'n' || e.key === 'N') { if (state.song) (notif ? stopNotif() : notify()); }
  else if (e.key === 'Escape') stopNotif();
});

buildSongs();
buildMessages();
buildControls();
sync();
requestAnimationFrame(frame);

fetch(`assets/music/${encodeURIComponent(SONGS[0].dir)}/timeStamps.csv`, { method: 'HEAD' })
  .then((r) => { if (!r.ok) $('#missing').hidden = false; })
  .catch(() => { $('#missing').hidden = false; });

// For automated checks.
window.__sing = { engine, state, notify, compose: async () => compose(await getTTS()), V };
