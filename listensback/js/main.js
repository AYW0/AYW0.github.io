import { SONGS, RINGTONES, PRESETS, SCHEDULES, KEY_MAJOR, keyLabel } from './data.js';
import { Engine } from './engine.js';
import { Timeline, Overview } from './timeline.js';

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
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);

const engine = new Engine();
const state = {
  song: null,
  ringtone: RINGTONES[0],
  preset: 'balanced',
  params: { ...PRESETS.find((p) => p.id === 'balanced').params },
};
engine.applyParams(state.params);

// ---------------- controls definition ----------------
const CONTROLS = [
  {
    title: 'Rhythm', items: [
      { key: 'beatMatch', type: 'toggle', label: 'Beat match', hint: 'Stretch the ringtone to the song’s tempo so it keeps the same beat.' },
      { key: 'schedule', type: 'seg', label: 'Start on', options: SCHEDULES.map((s) => [s.id, s.label]), hint: 'Wait for a musical boundary instead of cutting in mid-phrase.' },
      { key: 'repeats', type: 'range', label: 'Rings', min: 1, max: 8, step: 1, fmt: (v) => `${v}×` },
    ],
  },
  {
    title: 'Pitch', items: [
      { key: 'keyMatch', type: 'toggle', label: 'Key match', hint: 'Transpose the ringtone into the song’s key, by the smallest shift possible.' },
    ],
  },
  {
    title: 'Mix', items: [
      { key: 'volume', type: 'range', label: 'Ringtone volume', min: 0, max: 30, step: 1, fmt: (v) => `${v - 30} dB` },
      { key: 'fadeIn', type: 'toggle', label: 'Fade in', hint: 'Start quiet and swell up instead of starting at full volume.' },
      { key: 'fadeInSpeed', type: 'range', label: 'Fade speed', min: 0.01, max: 0.2, step: 0.01, fmt: (v) => `~${(0.02 / -Math.log(1 - v) * 3).toFixed(1)} s`, when: (p) => p.fadeIn },
      { key: 'adaptive', type: 'range', label: 'Adaptive loudness', min: 0, max: 10, step: 0.5, fmt: (v) => (v ? v.toFixed(1) : 'off'), hint: 'Raise the ringtone when the song gets loud.' },
      { key: 'duckVocals', type: 'toggle', label: 'Lower the vocals', hint: 'The singer drops out while the ringtone plays.' },
      { key: 'duckSong', type: 'toggle', label: 'Lower the instruments', hint: 'The backing track drops out too.' },
    ],
  },
  {
    title: 'Space & tone', items: [
      { key: 'pan', type: 'range', label: 'Follow stereo position', min: 0, max: 100, step: 1, fmt: (v) => (v ? v : 'off'), hint: 'Pan the ringtone to where the music sits.' },
      { key: 'reverbMix', type: 'range', label: 'Reverb', min: 0, max: 1000, step: 10, fmt: (v) => `${Math.round(v / 10)}%` },
      { key: 'reverbDecay', type: 'range', label: 'Reverb length', min: 1, max: 18, step: 0.5, fmt: (v) => `${v} s`, when: (p) => p.reverbMix > 0 },
      { key: 'lowpass', type: 'log', label: 'Low-pass', min: 200, max: 20000, fmt: (v) => (v >= 19900 ? 'off' : fmtHz(v)), hint: 'Dull the ringtone so it sits behind the music.' },
      { key: 'highpass', type: 'log', label: 'High-pass', min: 10, max: 5000, fmt: (v) => (v <= 11 ? 'off' : fmtHz(v)) },
    ],
  },
];

const ctlRefs = new Map();

function buildControls() {
  const root = $('#controls');
  for (const group of CONTROLS) {
    const g = el('div', { class: 'group' }, el('h3', {}, group.title));
    for (const c of group.items) {
      const val = el('span', { class: 'ctl-val' });
      let input;
      if (c.type === 'toggle') {
        input = el('button', { class: 'switch', role: 'switch', 'aria-label': c.label, onclick: () => setParam(c.key, !state.params[c.key]) });
      } else if (c.type === 'seg') {
        input = el('div', { class: 'seg', role: 'group', 'aria-label': c.label },
          ...c.options.map(([id, label]) => el('button', { 'data-v': id, onclick: () => setParam(c.key, id) }, label)));
      } else {
        const log = c.type === 'log';
        const toPos = (v) => (log ? Math.log(v / c.min) / Math.log(c.max / c.min) * 1000 : v);
        const fromPos = (x) => (log ? c.min * Math.pow(c.max / c.min, x / 1000) : +x);
        input = el('input', {
          type: 'range', min: log ? 0 : c.min, max: log ? 1000 : c.max, step: log ? 1 : c.step, 'aria-label': c.label,
          oninput: (e) => setParam(c.key, fromPos(e.target.value)),
        });
        input._toPos = toPos;
      }
      const row = c.type === 'toggle'
        ? el('div', { class: 'ctl-row' }, el('span', { class: 'ctl-label' }, c.label), input)
        : el('div', { class: 'ctl-row' }, el('span', { class: 'ctl-label' }, c.label), val);
      const wrap = el('div', { class: 'ctl' }, row, c.type === 'toggle' ? null : input, c.hint ? el('div', { class: 'ctl-hint' }, c.hint) : null);
      ctlRefs.set(c.key, { c, input, val, wrap });
      g.append(wrap);
    }
    root.append(g);
  }
}

function syncControls() {
  const p = state.params;
  for (const { c, input, val, wrap } of ctlRefs.values()) {
    const v = p[c.key];
    if (c.type === 'toggle') input.setAttribute('aria-checked', String(!!v));
    else if (c.type === 'seg') input.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    else { input.value = input._toPos(v); val.textContent = c.fmt(v); }
    wrap.classList.toggle('disabled', c.when ? !c.when(p) : false);
  }
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === state.preset)));
  const pr = PRESETS.find((x) => x.id === state.preset);
  $('#presetBlurb').textContent = pr ? pr.blurb : 'Custom settings. Pick a style above to reset.';
}

function setParam(key, value) {
  state.params = { ...state.params, [key]: value };
  state.preset = 'custom';
  engine.applyParams(state.params);
  syncControls();
}

function setPreset(id) {
  state.preset = id;
  state.params = { ...PRESETS.find((p) => p.id === id).params };
  engine.applyParams(state.params);
  syncControls();
}

// ---------------- songs / ringtones / presets ----------------
function hueFor(i) { return (i * 47 + 250) % 360; }

function buildSongs() {
  const list = $('#songList');
  SONGS.forEach((s, i) => {
    const h = hueFor(i);
    const b = el('button', {
      class: 'song', role: 'option', 'aria-selected': 'false', 'data-id': s.id,
      onclick: () => selectSong(s, b),
    },
      el('div', { class: 'art', 'data-bpm': `${Math.round(s.bpm)} BPM`, style: `background: linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 60) % 360} 70% 35%))` }),
      el('div', { class: 't' }, s.title),
      el('div', { class: 'a' }, s.artist));
    list.append(b);
  });
}

let loadToken = 0;
async function selectSong(s, btn) {
  const token = ++loadToken;
  document.querySelectorAll('.song').forEach((b) => { b.setAttribute('aria-selected', String(b === btn)); b.classList.remove('loading'); });
  btn.classList.add('loading');
  $('#playBtn').disabled = true;
  $('#ringBtn').disabled = true;
  $('#nowTitle').textContent = s.title;
  $('#nowSub').textContent = s.artist;
  try {
    await engine.loadSong(s, (msg) => { if (token === loadToken) $('#songStatus').textContent = msg; });
    if (token !== loadToken) return;
    state.song = engine.song;
    $('#songStatus').textContent = '';
    $('#statBpm').textContent = `${s.bpm.toFixed(1)}`;
    $('#statKey').textContent = keyLabel(s.key);
    $('#playBtn').disabled = false;
    $('#ringBtn').disabled = false;
    engine.play();
  } catch (e) {
    console.error(e);
    if (token === loadToken) $('#songStatus').textContent = `Couldn’t load: ${e.message}`;
  } finally {
    btn.classList.remove('loading');
  }
}

function buildRingtones() {
  const list = $('#ringtoneList');
  for (const rt of RINGTONES) {
    list.append(el('button', {
      class: 'rt', role: 'radio', 'aria-checked': String(rt === state.ringtone), style: `--c: ${rt.color}`, 'data-id': rt.id,
      onclick: () => selectRingtone(rt),
    }, el('i'), rt.name));
  }
  applyAccent();
}

function selectRingtone(rt) {
  state.ringtone = rt;
  document.querySelectorAll('.rt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === rt.id)));
  applyAccent();
  if (engine.ring) ring();
}

function applyAccent() {
  document.documentElement.style.setProperty('--accent', state.ringtone.color);
}

function buildPresets() {
  const list = $('#presetList');
  for (const p of PRESETS) {
    list.append(el('button', { class: 'preset', role: 'radio', 'data-id': p.id, onclick: () => setPreset(p.id) },
      el('div', { class: 'n' }, p.label), el('div', { class: 'tg' }, p.tag)));
  }
}

// ---------------- ringing ----------------
async function ring() {
  if (!state.song) return;
  $('#ringLabel').textContent = 'Preparing…';
  try {
    await engine.trigger(state.ringtone, state.params);
  } catch (e) {
    console.error(e);
    $('#explain').replaceChildren(el('p', { class: 'muted' }, `Couldn’t play ringtone: ${e.message}`));
    $('#ringLabel').textContent = 'Ring';
  }
}

function onRingButton() {
  if (engine.ring) engine.dismiss(); else ring();
}

const SCHEDULE_TEXT = {
  now: 'Played immediately, wherever the song was',
  beat: 'Waited for the next beat',
  bar: 'Waited for the start of the next bar',
  phrase: 'Waited for the next 4-bar phrase',
  quiet: 'Picked the spot in the next 32 beats where the music least overlaps the ringtone',
};

function explain(r) {
  const p = r.params, x = r.prep, song = state.song;
  const items = [];
  const li = (k, on, v) => el('li', { class: on ? 'on' : 'off' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
  items.push(li('Tempo', p.beatMatch, p.beatMatch
    ? `Used the ${x.tempo} BPM version (closest of ${r.rt.tempos.join(' / ')}) and set it to ${x.target.toFixed(1)} BPM (×${x.speed.toFixed(2)})${x.mult === 2 ? ', double time against the song' : x.mult === 0.5 ? ', half time against the song' : ''}`
    : `Original ${x.tempo} BPM; ignores the song’s ${song.bpm.toFixed(0)} BPM`));
  items.push(li('Key', p.keyMatch && x.semis !== 0, p.keyMatch
    ? (x.semis === 0 ? `Already in the song’s key (${KEY_MAJOR[song.key - 1]}), no shift needed` : `Moved from ${KEY_MAJOR[x.ringKey - 1]} to ${KEY_MAJOR[song.key - 1]}: ${x.semis > 0 ? '+' : '−'}${Math.abs(x.semis)} semitone${Math.abs(x.semis) === 1 ? '' : 's'}`)
    : `Not transposed (song is in ${keyLabel(song.key)})`));
  const wait = Math.max(0, r.wait);
  items.push(li('Timing', p.schedule !== 'now', `${SCHEDULE_TEXT[p.schedule]}${p.schedule !== 'now' ? `: ${wait.toFixed(1)} s` : ''}${p.beatMatch && r.start.beat != null && r.plays.length > 1 ? `, then repeats every ${x.beats} beats` : ''}`));
  const mix = [];
  if (p.duckVocals && p.duckSong) mix.push('whole song lowered 30 dB');
  else if (p.duckVocals) mix.push('vocals lowered so the ringtone replaces the singer');
  else if (p.duckSong) mix.push('instruments lowered');
  else mix.push('song keeps playing at full volume');
  if (p.fadeIn) mix.push('ringtone fades in');
  if (p.adaptive) mix.push('ringtone gets louder when the song does');
  items.push(li('Mix', !(p.duckVocals && p.duckSong), mix.join(' · ')));
  const space = [];
  if (p.pan) space.push('panned with the music');
  if (p.reverbMix) space.push(`${Math.round(p.reverbMix / 10)}% reverb`);
  if (p.lowpass < 19900) space.push(`softened above ${fmtHz(p.lowpass)}`);
  if (p.highpass > 11) space.push(`thinned below ${fmtHz(p.highpass)}`);
  items.push(li('Space', space.length > 0, space.length ? space.join(' · ') : 'Dry and centred'));
  $('#explain').replaceChildren(el('ul', {}, ...items));
}

engine.addEventListener('ring', (e) => {
  explain(e.detail);
  $('#ringBtn').classList.add('ringing');
  $('#ringLabel').textContent = 'Dismiss';
});
engine.addEventListener('ringend', () => {
  $('#ringBtn').classList.remove('ringing');
  $('#ringLabel').textContent = 'Ring';
});
engine.addEventListener('statechange', () => {
  document.body.classList.toggle('playing', engine.playing);
  $('#playBtn').setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
});

// ---------------- render loop ----------------
const timeline = new Timeline($('#timeline'));
const overview = new Overview($('#overview'), (t) => engine.seek(t));
let lastPrepDur = new Map();
engine.addEventListener('ring', (e) => lastPrepDur.set(e.detail.rt.id + e.detail.params.beatMatch, e.detail.prep.dur));

function frame() {
  engine.tick();
  const song = engine.song;
  const t = engine.time;
  let preview = null;
  if (song && !engine.ring && engine.playing) {
    const s = engine.planStart(state.ringtone, state.params, 0.08);
    if (s) {
      const dur = lastPrepDur.get(state.ringtone.id + state.params.beatMatch) ?? state.ringtone.length * song.analysis.beatDur;
      preview = { t: s.t, dur };
    }
  }
  const accent = state.ringtone.color;
  timeline.draw({ song, t, ring: engine.ring, preview, accent, level: engine.ringLevel() });
  overview.draw(song, t, engine.ring, accent);
  if (song) $('#statTime').textContent = `${fmtTime(t)} / ${fmtTime(song.duration)}`;
  requestAnimationFrame(frame);
}

// ---------------- wiring ----------------
$('#playBtn').addEventListener('click', () => engine.toggle());
$('#ringBtn').addEventListener('click', onRingButton);
$('#metronome').addEventListener('change', (e) => { engine.metronome = e.target.checked; engine.nextClickBeat = -1; });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space') { e.preventDefault(); if (state.song) engine.toggle(); }
  else if (e.key === 'r' || e.key === 'R') { if (state.song) onRingButton(); }
  else if (e.key === 'Escape') engine.dismiss();
});

buildSongs();
buildRingtones();
buildPresets();
buildControls();
syncControls();
requestAnimationFrame(frame);

// Check that the audio assets are reachable.
fetch(`assets/music/${encodeURIComponent(SONGS[0].dir)}/timeStamps.csv`, { method: 'HEAD' })
  .then((r) => { if (!r.ok) $('#missing').hidden = false; })
  .catch(() => { $('#missing').hidden = false; });
