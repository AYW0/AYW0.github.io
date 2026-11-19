// "Context-aware music adaptation", told as a short visual-novel style story in a line-drawn
// living room. Each chapter uses the real system from this repo: MARingBA (engine.js),
// the music-aware voice agent (voice.js), and RISE (precomputed cutpoints).
import * as THREE from '../vendor/three.module.min.js';
import { Room, POSES, mixPose } from './story-scene.js';
import { SONGS, RINGTONES, PRESETS, MAJOR_MAP, KEY_MAJOR, KEY_MINOR } from './data.js';
import { Engine, normGain } from './engine.js';
import * as V from './voice.js';
import { Timeline } from './timeline.js';
import { Liminality, LIM_SONGS, loadData as loadJourney } from './liminality.js';
import { Roll, RiseTrack, MirFigure, MvPanel, MvPipe, BeatMatchFig, ProsodyFig, CutFig, StudyFig, WerFig, SkipFig, CutPlayFig } from './story-viz.js';

const $ = (s) => document.querySelector(s);
// phones and narrow windows: the card sits on top instead of beside the room
const isNarrow = () => window.innerWidth < 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbToGain = (db) => Math.pow(10, db / 20);
const fmtS = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

const room = new Room($('#scene'));
const engine = new Engine();
// the song David puts on, and the ringtone that interrupts it
const PLAYLIST = [
  { song: 'hotline', ring: 'classic', art: 'linear-gradient(135deg, #ffb36b, #ff5a8a 55%, #8a5cff)', reps: [3, 2] },
  { song: 'nothing', ring: 'iphone', art: 'linear-gradient(135deg, #ffe08a, #f6a04d 55%, #d0573a)', reps: [3, 2] },
  { song: 'whatislove', ring: 'discord', art: 'linear-gradient(135deg, #8bf0ff, #5865f2 55%, #2a1f6e)', reps: [1, 1] },
].map((c) => ({ ...c, s: SONGS.find((x) => x.id === c.song), r: RINGTONES.find((x) => x.id === c.ring) }));
let PICK = PLAYLIST[0], HOTLINE = PICK.s, IPHONE = PICK.r;
const preset = (id) => ({ ...PRESETS.find((p) => p.id === id).params });

// ---------------------------------------------------------------- camera shots
const SHOTS = {
  wide: { target: [-0.3, 0.75, -1.0], yaw: 0.55, pitch: 0.32, dist: 8.6 },
  speakers: { target: [-0.6, 1.1, -1.8], yaw: 0.3, pitch: 0.24, dist: 7.2 },
  phone: { target: [-0.35, 1.05, -1.4], yaw: 0.62, pitch: 0.3, dist: 5.8 },
  person: { target: [-0.4, 1.1, -1.6], yaw: 0.45, pitch: 0.24, dist: 5.6 },
  mat: { target: [1.4, 1.25, 0.4], yaw: 1.2, pitch: 0.18, dist: 7.0 },
};

// ---------------------------------------------------------------- 3D-anchored labels
const labels = new Map();
function label(id, anchor, html, cls = '') {
  let el = labels.get(id)?.el;
  if (!el) { el = document.createElement('div'); $('#labels').append(el); }
  const prev = labels.get(id);
  labels.set(id, { el, anchor });
  if (prev && prev.html === html && prev.cls === cls) { labels.get(id).html = html; labels.get(id).cls = cls; return; }
  el.className = `tag3d ${cls}${prev ? ' in' : ''}`;
  el.innerHTML = html;
  Object.assign(labels.get(id), { html, cls });
  if (!prev) requestAnimationFrame(() => el.classList.add('in'));
}
function unlabel(id) {
  const l = labels.get(id);
  if (!l) return;
  l.el.classList.remove('in');
  setTimeout(() => l.el.remove(), 300);
  labels.delete(id);
}
function clearLabels() { for (const id of [...labels.keys()]) unlabel(id); }
const at = (obj, dx = 0, dy = 0, dz = 0) => () => obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(dx, dy, dz));

// ---------------------------------------------------------------- David's thoughts
function think(text, mood = 'good', ms = 0) {
  label('thought', at(room.person.neck, 0, 0.62, 0), text, `thought ${mood}`);
  clearTimeout(think.t);
  if (ms) think.t = setTimeout(() => unlabel('thought'), ms);
}
const unthink = () => { clearTimeout(think.t); unlabel('thought'); };

// ---------------------------------------------------------------- centre card
// Live interfaces from the demo pages while something is being adapted; paper figures while
// the narrator explains.
const vizCard = $('#vizcard');
const vz = { kind: null, notif: null };
const tl = new Timeline($('#vz-timeline'));
const roll = new Roll($('#vz-roll'), engine, { replaceVocals: true });
const track = new RiseTrack($('#vz-rise'));
const mir = new MirFigure($('#vz-mir'));
const mv = new MvPanel($('#vz-mv'));
const mvp = new MvPipe($('#vz-mvpipe'), (clip) => {
  playClip(clip).then((ok) => { if (!ok && clip === 'david') think('(my verse is still being recorded 🎙️)', 'good', 3000); });
  if (clip === 'david') think('Wait, this song is about me? 😳', 'good', 3500);
});
mvp.onChange = () => stopClip();
const figs = { bm: new BeatMatchFig($('#vz-bm')), pro: new ProsodyFig($('#vz-pro')), cut: new CutFig($('#vz-cut')), study: new StudyFig($('#vz-study')), wer: new WerFig($('#vz-wer')), skip: new SkipFig($('#vz-skip canvas')), cutplay: new CutPlayFig($('#vz-cutplay canvas')) };
$('#vz-cutplay').addEventListener('click', (e) => { const b = e.target.closest('.sk-play'); if (b && skip.buf) skipToggle(+b.dataset.lane); });
$('#vz-skip').addEventListener('click', (e) => { const b = e.target.closest('.sk-play'); if (b && skip.buf) skipToggle(+b.dataset.lane); });
let replayFn = null;
$('#vz-replay').addEventListener('click', async (e) => { e.stopPropagation(); if (replayFn) await replayFn(); });
function setReplay(fn) { replayFn = fn; $('#vz-replay').hidden = !fn; }
function showLive(kind, tag, title, replay = null) {
  setReplay(replay);
  vz.kind = kind;
  vizCard.classList.remove('fig');
  vizCard.querySelector('.vz-kind').textContent = tag;
  vizCard.querySelector('.vz-title').textContent = title;
  for (const c of vizCard.querySelectorAll('.vz-canvas')) c.classList.toggle('on', c.id === 'vz-' + kind);
  vizCard.querySelector('.vz-figs').classList.remove('on');
  vizCard.classList.add('on');
  room.focusShift = isNarrow() ? 0 : 0.24; requestAnimationFrame(() => room.applyOffset());
  requestAnimationFrame(() => { tl.resize(); roll.resize(); });
}
function showFigs(tag, title, figs) {
  setReplay(null);
  vz.kind = 'figs';
  vizCard.classList.add('fig');
  vizCard.querySelector('.vz-kind').textContent = tag;
  vizCard.querySelector('.vz-title').textContent = title;
  for (const c of vizCard.querySelectorAll('.vz-canvas')) c.classList.remove('on');
  const box = vizCard.querySelector('.vz-figs');
  box.className = 'vz-figs on' + (figs.length === 1 ? ' one' : '');
  room.focusShift = isNarrow() ? 0 : 0.24; requestAnimationFrame(() => room.applyOffset());
  box.innerHTML = figs.map((f) => `<figure class="${f.tone || ''} ${f.anim || ''}"><img src="img/story/${f.src}" alt=""><figcaption>${f.cap ? `<i>${f.cap}</i>` : ''}${f.label || ''}</figcaption></figure>`).join('');
  vizCard.classList.add('on');
}
function hideViz() { vz.kind = null; vizCard.classList.remove('on'); room.focusShift = 0; requestAnimationFrame(() => room.applyOffset()); }

// ---------------------------------------------------------------- person animation state
const BUFF_KEY = 'story.davidBuff';
// The room resets on every load.
try { localStorage.removeItem(BUFF_KEY); } catch {}
const buff = { level: 0, ripped: false };
const saveBuff = () => {};
room.setBuff(buff.level, buff.ripped);
if (buff.ripped) room.ripJacket(false);
function onRep(n) {
  // only while RISE keeps the chorus going: from rep 4 David bulks up every 3 reps; at 20 the jacket rips
  if (!rise.adapt) return;
  if (n >= 4 && n % 3 === 1 && buff.level < 1) {
    buff.level = Math.min(1, buff.level + 0.12); room.setBuff(buff.level, buff.ripped);
if (buff.ripped) room.ripJacket(false); saveBuff();
    flashLabel('gain', at(room.person.neck, 0.35, 0.2, 0), '💪 gains', 1200);
  }
  if (n === 8) think('Can’t stop now 🔥', 'good');
  if (n === 13) think('This drop is endless. I love it.', 'good');
  if (n === 17) think('Something’s… happening to my jacket', 'good');
  if (n >= 20 && !buff.ripped) {
    buff.ripped = true; buff.level = 1; room.setBuff(buff.level, true); saveBuff();
    room.ripJacket(true);
    room.shake = 1.4;
    setTimeout(() => think('This bar is too light. Speakers, please 🔊', 'good'), 2600);
    flashLabel('rip', at(room.person.neck, 0, 0.25, 0), '💥 RIIIP!', 2500);
    think('MAXIMUM ENERGY 🦾', 'good');
  }
}
const anim = { onCalm: null, groove: false, pose: 'sit', from: { ...POSES.sit }, t: 1, dur: 0.6, nod: 0, working: false, reps: 0, walk: null };
function pose(name, dur = 0.6) {
  anim.from = { ...room.pose }; anim.pose = name; anim.t = 0; anim.dur = dur;
}
function walkTo(pos, rotY, dur = 2.2) {
  anim.walk = { from: room.person.root.position.clone(), to: new THREE.Vector3(...pos), r0: room.person.root.rotation.y, r1: rotY, t: 0, dur };
}

// ---------------------------------------------------------------- audio: song + analysis
let mel = null, flightBuf = null, flightWords = null, voiceBus = null;
const voiceSrcs = [];
async function loadCommon() {
  const r = await fetch('tts/invite-alex.mp3');
  flightBuf = await engine.ctx.decodeAudioData(await r.arrayBuffer());
  flightWords = await fetch('tts/invite-alex.words.json').then((q) => q.json()).catch(() => null);
  voiceBus = engine.ctx.createGain(); voiceBus.gain.value = dbToGain(5); voiceBus.connect(engine.master);
}
async function loadHome() {
  setLoading(`Loading ${HOTLINE.title}…`);
  await engine.loadSong(HOTLINE, (m) => setLoading(m));
  engine.applyParams(preset('balanced'));
  setLoading('Listening to the singer…');
  const x = await V.toMono(engine.song.vocals, 8000);
  mel = V.yin(x, 8000, { hop: 0.01, fmin: 80, fmax: 1000, thresh: 0.18, gateDb: -38 });
  const ms = [];
  for (let k = 0; k < mel.f0.length; k++) if (mel.f0[k] && mel.conf[k] > 0.75) ms.push(V.hzToMidi(mel.f0[k]));
  ms.sort((p, q) => p - q);
  mel.lo = Math.floor(ms[Math.floor(ms.length * 0.03)] ?? 52) - 3; mel.hi = Math.ceil(ms[Math.floor(ms.length * 0.97)] ?? 76) + 3;
  await engine.prepare(IPHONE, preset('conventional'));
  await engine.prepare(IPHONE, preset('subtle'));
  setLoading('');
}
function setLoading(m) { $('#loading').textContent = m; }

// Music-aware voice agent: sing the message on the singer's melody, in place of the singer.
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const PRE = 0.2;
function slotTime(b0, slot, grid) {
  const a = engine.song.analysis, beats = a.beats;
  const atb = (i) => (i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * a.beatDur);
  const b = slot / grid, i = Math.floor(b), f = b - i;
  return atb(b0 + i) + f * (atb(b0 + i + 1) - atb(b0 + i));
}
const HOTLINE_SPOTS = [[18, 2], [20, 2], [22, 2], [24, 1], [26, 1], [28, 1], [30, 1], [32, 1], [34, 1], [36, 1], [38, 1], [42, 1], [50, 2], [54, 3], [56, 1], [58, 2], [60, 1]];
async function singFlight(forceBeat = null) {
  const song = engine.song, a = song.analysis, sr = 22050;
  const x = await V.toMono(flightBuf, sr);
  const tr = V.yin(x, sr, { hop: 0.005, fmin: 70, fmax: 450, thresh: 0.15, gateDb: -35 });
  const spoken = 'New calendar invite from Alex';
  const sylText = V.syllabify(spoken);
  // word boundaries come from a DTW alignment against the words spoken alone (see README)
  const words = flightWords && flightWords.map((w) => ({ ...w, n: V.syllabify(w.w).length }));
  const syl = V.segmentSyllables(x, sr, sylText.length, tr, words);
  const vf = []; for (const f of tr.f0) if (f) vf.push(f);
  vf.sort((p, q) => p - q);
  const voiceMidi = vf.length ? V.hzToMidi(vf[vf.length >> 1]) : 57;
  // start on a bar where the singer is singing, a few seconds ahead
  const nb = engine.nextBeatIndex(engine.time + 0.6 + PRE);
  const q = V.quantize(syl, { beatDur: a.beatDur, grid: 0, maxBeats: 8, fitTempo: true });
  const G = q.grid;
  // Hotline Bling: the spots Alex picked by ear (bar.beat). The voicing-based rule wasn't reliable
  // enough, so these are used as they are: the next one within ~8 bars, else the old placement.
  let ruled = null;
  if (forceBeat == null && song.id === 'hotline') {
    const D = a.downbeatIdx, B = a.beats;
    const spots = HOTLINE_SPOTS.map(([bar, beat]) => D[bar - 1] + beat - 1).filter((i) => i >= nb && i + 8 < B.length && B[i] - B[nb] < 32 * a.beatDur);
    if (spots.length) ruled = Math.min(...spots);
  }
  let b0 = forceBeat ?? ruled ?? a.downbeatIdx.find((i) => i >= nb && V.voicedFraction(mel, a.beats[i], slotTime(i, q.slots, G)) > 0.35)
    ?? a.downbeatIdx.find((i) => i >= nb);
  const t0 = a.beats[b0];
  const sh = forceBeat != null || (ruled != null && b0 === ruled) ? q.notes[0].slot : 0;
  const notes = q.notes.map((nt) => ({ ...nt, slot: nt.slot - sh, raw: nt.raw - sh, t: slotTime(b0, nt.slot - sh, G), t1: slotTime(b0, nt.slot - sh + nt.slots, G), ma: slotTime(b0, nt.slot - sh, G), mb: slotTime(b0, nt.slot - sh + nt.slots, G) }));
  const root = MAJOR_MAP[song.key - 1];
  const { pitches, octave } = V.assignPitches(notes, mel, { beatDur: a.beatDur, scalePcs: MAJOR.map((i) => (root + i) % 12), tonic: root, voiceMidi });
  const labelsT = syl.length === sylText.length ? sylText : null;
  notes.forEach((nt, i) => { nt.midi = pitches[i]; nt.songMidi = pitches[i] - 12 * octave; nt.rawT = slotTime(b0, nt.raw, G); nt.label = labelsT ? labelsT[i] : ''; });
  const segs = V.buildSegments(notes, t0 - PRE);
  const end = notes[notes.length - 1].t1;
  const y = V.psola(x, sr, tr, segs, end - t0 + PRE + 0.4);
  const vd = song.vocals.getChannelData(0), vsr = song.vocals.sampleRate;
  const target = Math.max(0.05, Math.min(0.2, V.rmsOf(vd.subarray(Math.floor(t0 * vsr), Math.floor(end * vsr))) * 1.1));
  const g = target / (V.rmsOf(y) || 1);
  for (let i = 0; i < y.length; i++) y[i] *= g;
  const buf = engine.ctx.createBuffer(1, y.length, sr);
  buf.copyToChannel(y, 0);
  const c0 = engine.ctxTime(t0), c1 = engine.ctxTime(end);
  const vg = engine.vocalGain.gain, ag = engine.accGain.gain;
  vg.cancelScheduledValues(0); vg.setTargetAtTime(0, c0 - 0.12, 0.03); vg.setTargetAtTime(1, c1 + 0.1, 0.1);
  ag.cancelScheduledValues(0); ag.setTargetAtTime(dbToGain(-3), c0 - 0.1, 0.05); ag.setTargetAtTime(1, c1 + 0.1, 0.15);
  const s = engine.ctx.createBufferSource(); s.buffer = buf; s.connect(voiceBus); s.start(c0 - PRE); voiceSrcs.push(s);
  vz.notif = { mode: 'musical', t0, t1: end, notes };
  window.__lastSung = { t0, syl, sylText, q: { grid: G, alpha: q.alpha, pace: q.pace }, voiceMidi, octave, notes: notes.map((n) => ({ l: n.label, slot: n.slot, slots: n.slots, midi: n.midi, song: n.songMidi, src: n.src, vowel: n.vowel, dur: n.t1 - n.t })), y };
  return { wait: c0 - engine.ctx.currentTime, dur: end - t0, bpm: Math.round(60 / a.beatDur), n: notes.length, grid: G };
}
function speakFlight() {
  const ctx = engine.ctx, c0 = ctx.currentTime + 0.35, dur = flightBuf.duration;
  for (const g of [engine.vocalGain.gain, engine.accGain.gain]) {
    g.cancelScheduledValues(0); g.setTargetAtTime(dbToGain(-24), ctx.currentTime, 0.06); g.setTargetAtTime(1, c0 + dur + 0.3, 0.2);
  }
  const s = ctx.createBufferSource(); s.buffer = flightBuf; s.connect(voiceBus); s.start(c0); voiceSrcs.push(s);
  vz.notif = { mode: 'standard', t0: engine.time + 0.35, t1: engine.time + 0.35 + dur };
  return dur + 0.6;
}

// ---------------------------------------------------------------- RISE chapter
const rise = { choice: null, jumps: [], upcoming: null, setStart: 0, buf: null, beats: null, segs: null, voices: [], maps: [], high: false, pending: null, active: false, adapt: false, analyser: null, abuf: null };
// workout songs: one per genre, each with a loop picked by ear (null: the longest loop, as in RISE)
const WORKOUT = [
  { id: 'waves', file: 'Waves.mp3', title: 'Waves', artist: 'Zeds Dead', genre: 'EDM', loop: [136.3, 108.8], art: 'linear-gradient(135deg, #2bd2ff, #2b6cff 55%, #12123a)', say: 'EDM', col: '#2b6cff' },
  { id: 'humble', file: 'humble.mp3', title: 'HUMBLE. (Skrillex Remix)', artist: 'Kendrick Lamar', genre: 'Rap', loop: null, art: 'linear-gradient(135deg, #f5f5f5, #c9302c 55%, #1a1a1a)', say: 'rap', col: '#c9302c' },
  { id: 'lost', file: 'Lost.mp3', title: 'Lost', artist: 'Linkin Park', genre: 'Metal', loop: [72.0, 62.9], art: 'linear-gradient(135deg, #9aa0a6, #3b3f45 55%, #0d0d0f)', say: 'metal', col: '#4a4f57' },
  { id: 'cruelsummer', file: 'Cruel Summer.mp3', title: 'Cruel Summer', artist: 'Taylor Swift', genre: 'Pop', loop: [48.9, 37.6], art: 'linear-gradient(135deg, #ffd1e8, #f78fc2 55%, #6b5bd6)', judge: 'Taylor Swift… for leg day? 🙄 Fine.', say: 'Taylor Swift', col: '#e0569b' },
];
async function loadRise(w = WORKOUT[0]) {
  rise.meta = w;
  const dir = `rise-assets/${w.id}/`;
  const [bt, sj, ab] = await Promise.all([
    fetch(dir + 'beat_times.csv').then((r) => r.text()),
    fetch(dir + 'combined_segments.json').then((r) => r.json()),
    fetch(dir + w.file).then((r) => r.arrayBuffer()).then((a) => engine.ctx.decodeAudioData(a)),
  ]);
  rise.buf = ab; rise.norm = normGain([ab]);
  rise.beats = bt.split(/[\s,]+/).filter(Boolean).map(Number);
  const B = rise.beats, at = (i) => B[Math.min(i, B.length - 1)];
  const pairs = (t) => (typeof t === 'string' ? [...t.matchAll(/\((\d+),\s*(\d+)\)/g)].map((m) => [+m[1], +m[2]]) : t || []);
  rise.segs = sj.segments.map((g, i) => ({
    start: at(g.start), end: i === sj.segments.length - 1 ? ab.duration : at(g.end), high: g.label === 'high',
    cuts: pairs(g.transitions).flatMap(([o, d]) => [[o, d], [d, o]]).filter(([o, d]) => o !== d && o < B.length && d < B.length).map(([o, d]) => ({ orig: at(o), dest: at(d) })),
  }));
  const d = B.slice(1).map((x, i) => x - B[i]).sort((p, q) => p - q);
  rise.beatDur = d[d.length >> 1];
  rise.analyser = engine.ctx.createAnalyser(); rise.analyser.fftSize = 1024; rise.analyser.connect(engine.master);
  rise.abuf = new Float32Array(1024);
  // the loop picked by ear for this song, if any
  rise.choice = w.loop ? rise.segs.flatMap((s) => s.cuts).find((c) => Math.abs(c.orig - w.loop[0]) < 0.15 && Math.abs(c.dest - w.loop[1]) < 0.15) || null : null;
}
// The skip showcase: The Middle (Zedd, Maren Morris & Grey), resting in a calm part. Two versions
// side by side: as written, and with RISE skipping 2:11.3 → 2:20.2 so the energy comes back sooner.
const SKIP = { id: 'middle', file: 'middle.mp3', title: 'The Middle', artist: 'Zedd, Maren Morris & Grey', from: 124, cut: [131.3, 140.2], to: 156 };
const skip = { buf: null, segs: null, cut: null, play: null, voices: [] };
async function loadSkip() {
  if (skip.buf) return;
  const dir = `rise-assets/${SKIP.id}/`;
  const [bt, sj, ab] = await Promise.all([
    fetch(dir + 'beat_times.csv').then((r) => r.text()),
    fetch(dir + 'combined_segments.json').then((r) => r.json()),
    fetch(dir + SKIP.file).then((r) => r.arrayBuffer()).then((a) => engine.ctx.decodeAudioData(a)),
  ]);
  const B = bt.split(/[\s,]+/).filter(Boolean).map(Number), at = (i) => B[Math.min(i, B.length - 1)];
  const pairs = (t) => (typeof t === 'string' ? [...t.matchAll(/\((\d+),\s*(\d+)\)/g)].map((m) => [+m[1], +m[2]]) : t || []);
  skip.buf = ab; skip.beats = B; skip.norm = normGain([ab]);
  { const d = B.slice(1).map((x, i) => x - B[i]).sort((p, q) => p - q); skip.beatDur = d[d.length >> 1]; }
  skip.segs = sj.segments.map((g, i) => ({ start: at(g.start), end: i === sj.segments.length - 1 ? ab.duration : at(g.end), high: g.label === 'high',
    cuts: pairs(g.transitions).flatMap(([o, d]) => [[o, d], [d, o]]).map(([o, d]) => ({ orig: at(o), dest: at(d) })) }));
  const all = skip.segs.flatMap((x) => x.cuts);
  skip.cut = all.reduce((b, c) => (Math.abs(c.orig - SKIP.cut[0]) + Math.abs(c.dest - SKIP.cut[1]) < Math.abs(b.orig - SKIP.cut[0]) + Math.abs(b.dest - SKIP.cut[1]) ? c : b), all[0]);
  skip.hiAt = skip.segs.find((x) => x.high && x.start > SKIP.from).start;
  // a pair of matching beats inside the drop: jumping back loops B, jumping ahead skips it
  const drop = skip.segs.find((x) => x.high && x.start > SKIP.from), mid = (drop.start + drop.end) / 2;
  const cand = drop.cuts.filter((c) => c.dest > c.orig && c.orig > drop.start + 3 && c.dest < drop.end - 3);
  const pr = cand.reduce((b, c) => (!b || Math.abs(c.dest - c.orig - 8) + Math.abs((c.orig + c.dest) / 2 - mid) * 0.5 < Math.abs(b.dest - b.orig - 8) + Math.abs((b.orig + b.dest) / 2 - mid) * 0.5 ? c : b), null);
  skip.drop = { start: drop.start, end: drop.end, x: pr.orig, y: pr.dest };
}
function skipStop(fade = 3) {
  jumpFlashes.length = 0;
  const now = engine.ctx?.currentTime || 0;
  for (const v of skip.voices) { v.g.gain.cancelScheduledValues(0); v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.linearRampToValueAtTime(0, now + fade); try { v.s.stop(now + fade + 0.05); } catch {} }
  skip.voices = []; skip.play = null;
}
// lane 0: as written; lane 1: with the skip. Returns nothing; the frame loop follows skip.play.
function skipPlay(lane, resume = null) {
  skipStop(0.3); riseStop(); engine.stop();
  const ctx = engine.ctx, when = ctx.currentTime + 0.08, xf = 0.025, c = skip.cut;
  const voice = (pos, at, until, fadeIn = xf) => {
    const g = ctx.createGain(); g.connect(engine.master);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(skipLevel(), at + fadeIn);
    if (until) { g.gain.setValueAtTime(skipLevel(), until - xf); g.gain.linearRampToValueAtTime(0, until + xf); }
    const s = ctx.createBufferSource(); s.buffer = skip.buf; s.connect(g); s.start(at, pos); if (until) s.stop(until + xf + 0.02);
    skip.voices.push({ g, s });
  };
  // lanes 0/1: the calm-part skip demo; 2: loop B inside the drop; 3: skip B inside the drop
  const D = skip.drop;
  // the drop demos start near the end of A, so the cut comes quickly
  const from = lane >= 2 ? Math.max(D.start, D.x - 3) : SKIP.from;
  const o = lane === 2 ? D.y : lane === 3 ? D.x : c.orig, d = lane === 2 ? D.x : lane === 3 ? D.y : c.dest;
  // resuming a paused example: carry on from where it stopped (after its jump, if it had jumped)
  const fade = resume ? 0.25 : 1.2;
  let jumpAt;
  if (resume && resume.jumped) {
    // already past the jump: just continue on the far side of it
    voice(resume.pos, when, null, fade);
    jumpAt = when - (resume.pos - d);
    skip.play = { lane, when: jumpAt - (o - from), jumpAt, from, o, d };
  }
  else {
    const start = resume ? resume.pos : from;
    jumpAt = when + (o - start);
    if (lane === 0) voice(start, when, null, fade);
    else { voice(start, when, jumpAt, fade); voice(d - xf, jumpAt - xf); flashJump(d < o ? 'loop' : 'skip', jumpAt); }
    skip.play = { lane, when: when - (start - from), jumpAt, from, o, d };
  }
  unlabel('bored');
  skip.paused = skip.paused || {}; delete skip.paused[lane];
  if (!resume) { anim.free = false; anim.working = false; pose('stand', 0.4); rackBar(); }
}
// pause the playing example, remembering where it was
function skipPause() {
  const p = skip.play; if (!p) return;
  const now = engine.ctx.currentTime;
  skip.paused = skip.paused || {};
  skip.paused[p.lane] = { pos: skipPos(), jumped: p.lane !== 0 && now >= p.jumpAt };
  skipStop(0.25); anim.working = false; anim.free = false; pose('stand', 0.4); rackBar(); unlabel('bored');
}
// a play/pause button: pause the playing one, otherwise play (or resume) this one
function skipToggle(lane) {
  skip.queue = []; // the reader has taken over
  if (skip.play && skip.play.lane === lane && !skip.play.fading) { skipPause(); return; }
  skipPlay(lane, skip.paused && skip.paused[lane]);
}
// play two examples back to back on their own
function skipAuto(a, b) { skip.paused = {}; skip.queue = [b]; later(() => skipPlay(a), 900); }
// an example finished: note it, then start the next one in the queue
function skipEnded() {
  skip.played = true;
  const nx = skip.queue && skip.queue.shift();
  if (nx != null) later(() => skipPlay(nx), 900);
}
// song position of the lane being played
function skipPos() {
  const p = skip.play; if (!p) return null;
  const now = engine.ctx.currentTime, t = now - p.when;
  if (p.lane !== 0 && now >= p.jumpAt) return p.d + (now - p.jumpAt);
  return p.from + Math.max(0, t);
}
// A big arrow flashed at the exact moment of a jump (back for a loop, forward for a skip):
// on instantly, then fades over about a second.
const jumpFlashes = [];
function flashJump(kind, ctxT) { jumpFlashes.push({ kind, at: ctxT }); }
function runJumpFlashes() {
  if (!engine.ctx) return;
  const now = engine.ctx.currentTime;
  for (let i = jumpFlashes.length - 1; i >= 0; i--) {
    if (now < jumpFlashes[i].at - 0.02) continue;
    const { kind } = jumpFlashes.splice(i, 1)[0];
    const el = $('#jumpflash');
    el.className = `jumpflash ${kind}`;
    // sit just under the visualization card, centred on it; otherwise high in the middle of the room
    const vc = vizCard.classList.contains('on') ? vizCard.getBoundingClientRect() : null;
    const st = $('.stage').getBoundingClientRect();
    if (vc) { el.style.left = `${vc.left - st.left + vc.width / 2 - el.offsetWidth / 2}px`; el.style.top = `${vc.top - st.top + vc.height / 2 - el.offsetHeight / 2}px`; }
    else { el.style.left = `${st.width / 2 - 85}px`; el.style.top = `${st.height * 0.22}px`; }
    el.querySelector('span').textContent = kind === 'loop' ? 'LOOP' : 'SKIP';
    void el.offsetWidth; el.classList.add('go');
  }
}
// workout songs share the engine's output stage, which carries the home song's normalization
const outNorm = () => (engine.songNorm ? engine.songNorm.gain.value : 1) || 1;
const riseLevel = () => (rise.norm || 1) / outNorm();
const skipLevel = () => (skip.norm || 1) / outNorm();
function riseVoice(pos, when, fade) {
  const ctx = engine.ctx, g = ctx.createGain(); g.connect(rise.analyser);
  g.gain.setValueAtTime(0, Math.max(ctx.currentTime, when - 0.001)); g.gain.linearRampToValueAtTime(riseLevel(), when + fade);
  const s = ctx.createBufferSource(); s.buffer = rise.buf; s.connect(g); s.start(when, Math.max(0, pos));
  rise.voices.push({ g, s });
}
function riseStart(pos, fadeIn = 0.3) {
  riseStop();
  const when = engine.ctx.currentTime + 0.1;
  rise.maps = [{ c: when, p: pos }]; riseVoice(pos, when, fadeIn); rise.active = true; rise.pending = null; rise.jumps = []; rise.upcoming = null; rise.setStart = when;
}
function riseStop() {
  jumpFlashes.length = 0;
  const now = engine.ctx?.currentTime || 0;
  for (const v of rise.voices) { v.g.gain.cancelScheduledValues(0); v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.linearRampToValueAtTime(0, now + 3); try { v.s.stop(now + 3.1); } catch {} }
  rise.voices = []; rise.active = false;
}
function risePos(now = engine.ctx.currentTime) { let m = rise.maps[0]; for (const x of rise.maps) if (x.c <= now) m = x; return m ? m.p + (now - m.c) : 0; }
function riseJump(orig, dest, xf = 0.025) {
  const m = rise.maps[rise.maps.length - 1], c = m.c + (orig - m.p);
  const old = rise.voices[rise.voices.length - 1];
  old.g.gain.setValueAtTime(riseLevel(), c - xf); old.g.gain.linearRampToValueAtTime(0, c + xf); old.s.stop(c + xf + 0.02);
  riseVoice(dest - xf, c - xf, 2 * xf);
  rise.maps.push({ c, p: dest });
  flashJump(dest < orig ? 'loop' : 'skip', c);
  return c;
}
const riseSeg = (p) => !rise.segs ? { high: false } : rise.segs.find((s) => p >= s.start && p < s.end) || rise.segs[rise.segs.length - 1];
function riseStep() {
  if (!rise.active) return;
  const now = engine.ctx.currentTime, pos = risePos();
  if (rise.pending && now > rise.pending + 0.05) rise.pending = null;
  // keep the chorus going while David works: longest seamless loop back inside the section
  rise.upcoming = null;
  if (rise.adapt && anim.working && !rise.pending) {
    const seg = riseSeg(pos);
    if (seg.high) {
      // the loop that will be taken: longest jump back among cutpoints still ahead
      // a loop chosen in the panel, or else the longest jump back (as in RISE)
      const ok = (c) => c.dest < c.orig && (!rise.choice || (Math.abs(c.orig - rise.choice.orig) < 0.01 && Math.abs(c.dest - rise.choice.dest) < 0.01));
      let next = null;
      for (const c of seg.cuts) if (ok(c) && c.orig > pos + 0.1 && (!next || c.orig < next.orig - 0.01 || (Math.abs(c.orig - next.orig) < 0.01 && c.orig - c.dest > next.orig - next.dest))) next = c;
      rise.upcoming = next;
      let best = null;
      for (const c of seg.cuts) if (ok(c) && c.orig > pos + 0.1 && c.orig - pos < 0.35 && (!best || c.orig - c.dest > best.orig - best.dest)) best = c;
      if (best) {
        rise.pending = riseJump(best.orig, best.dest);
        rise.jumps.push({ ...best });
        setTimeout(() => flashLabel('loop', at(room.speakers[1], 0, 1.35, 0), `↺ Looped back ${(best.orig - best.dest).toFixed(1)} s · seamless`), Math.max(0, (rise.pending - now) * 1000));
      }
    }
  }
}
// MultiVerse clips from the UIST '26 talk (David's version is added later)
let mvClip = null;
function playClip(name) {
  if (mvClip) { const a = mvClip; mvClip = null; a.pause(); }
  return new Promise((resolve) => {
    const a = new Audio(`audio/multiverse/${name}.mp3`);
    mvClip = a;
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.play().catch(() => resolve(false));
  });
}
function stopClip() {
  if (!mvClip) return;
  // fade the clip out over a couple of seconds
  const a = mvClip; mvClip = null;
  const t0 = performance.now(), v0 = a.volume;
  const iv = setInterval(() => { const k = (performance.now() - t0) / 2500; if (k >= 1) { a.pause(); clearInterval(iv); } else a.volume = v0 * (1 - k); }, 50);
}
function rackBar() { anim.barMode = null; anim.quit = null; room.bar.position.set(2.45, 0.17, 1.7); room.bar.rotation.set(0, 0, 0); }
function flashLabel(id, anchor, html, ms = 2600) {
  label(id, anchor, html, 'flash');
  clearTimeout(flashLabel[id]); flashLabel[id] = setTimeout(() => unlabel(id), ms);
}

// ---------------------------------------------------------------- dialogue
const box = $('#dialogue'), textEl = $('#dtext'), nameEl = $('#dname'), actsEl = $('#dacts');
let typing = null, typingDone = null;
// very light UI sounds, synthesized: a soft tick on clicks and visual-novel blips while Alex talks
const sfx = {
  bus: null,
  out() {
    const ctx = engine.ctx; if (!ctx) return null;
    if (!this.bus) { this.bus = ctx.createGain(); this.bus.gain.value = 1; this.bus.connect(ctx.destination); }
    return ctx;
  },
  tone(f0, f1, dur, vol, type = 'sine') {
    const ctx = this.out(); if (!ctx) return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + dur + 0.02);
  },
  click() { this.tone(1500, 900, 0.05, 0.05); },
  // treasure found: a quick sparkling run up and a shimmer
  unlock() {
    const ctx = this.out(); if (!ctx) return;
    [72, 76, 79, 84, 88, 91, 96].forEach((m, k) => setTimeout(() => this.tone(440 * Math.pow(2, (m - 69) / 12), 440 * Math.pow(2, (m - 69) / 12) * 1.01, 0.5, 0.05), k * 55));
    setTimeout(() => { for (let k = 0; k < 6; k++) setTimeout(() => this.tone(2600 + Math.random() * 1600, 2400, 0.25, 0.015), k * 70); }, 400);
  },
  // chapter chime: three descending notes on beat 1, the 'and' of 2, and 4, at the song's tempo.
  // The second and third are quieter, like echoes, and bounce left and right through a wide reverb.
  chime(at, beatDur = 0.5, top = 84) {
    const ctx = this.out(); if (!ctx) return;
    if (!this.verb) {
      const len = Math.floor(ctx.sampleRate * 4), ir = ctx.createBuffer(2, len, ctx.sampleRate);
      // independent noise per channel = a wide, decorrelated tail
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
      this.verb = ctx.createConvolver(); this.verb.buffer = ir;
      const wet = ctx.createGain(); wet.gain.value = 0.9; this.verb.connect(wet); wet.connect(this.bus);
    }
    const t0 = Math.max(ctx.currentTime + 0.01, at);
    [[top, 0, 0.2, 0], [79, 1.5, 0.12, -0.75], [76, 3, 0.08, 0.75]].forEach(([m, beat, vol, pan]) => {
      const f = 440 * Math.pow(2, (m - 69) / 12), t = t0 + beat * beatDur;
      const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.bus); p.connect(this.verb);
      for (const [mult, v] of [[1, 1], [2, 0.28], [3.01, 0.1]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f * mult;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        o.connect(g); g.connect(p); o.start(t); o.stop(t + 1.5);
      }
    });
  },
  blip() { this.tone(560 + Math.random() * 90, 520, 0.035, 0.018, 'triangle'); },
  // a soft kalimba-like pluck for each spoken word: a sine with a little bell overtone and a tick
  word(midi, accent = 0.5) {
    const ctx = this.out(); if (!ctx) return;
    const t = ctx.currentTime + 0.005, f = 440 * Math.pow(2, (midi - 69) / 12), vol = 0.035 + 0.05 * accent, dur = 0.12 + 0.12 * accent;
    for (const [mult, v, type] of [[1, 1, 'sine'], [4.02, 0.18, 'sine'], [2, 0.12, 'triangle']]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f * mult * 1.012, t); o.frequency.exponentialRampToValueAtTime(f * mult, t + 0.03);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (mult > 1 ? 0.5 : 1));
      o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + dur + 0.02);
    }
  },
};
document.addEventListener('click', (e) => { if (e.target.closest('button, .choice, .chapters li, .papercard, .pc-row, a')) sfx.click(); }, true);
// paper names in Alex's lines are shown in each paper's colour
const PAPER_COL = [[/\bMARingBA\b/g, '#2fae74'], [/Towards Music-Aware Virtual Assistants/g, '#e0479e'], [/\bmusic-aware voice agents?\b/gi, '#e0479e'], [/\bRISE\b/g, '#e8a33d'], [/\bMultiVerse\b/g, '#1d8a96']];
const C3_COL = { creator: '#f07a1c', content: '#e0384f', context: '#1fa4b8' };
const tintC3 = (html) => html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(/\b(creator|content|context)(s?)\b/gi, (m, w) => `<span class="c3w" style="color:${C3_COL[w.toLowerCase()]}">${m}</span>`))).join('');
const tintPapers = (html) => html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : PAPER_COL.reduce((t, [re, c]) => t.replace(re, (m) => `<span class="paper" style="color:${c}">${m}</span>`), part))).join('');
// the first n visible characters of an html string (open tags are closed by the parser)
function htmlPrefix(html, n) {
  let out = '', k = 0;
  for (let i = 0; i < html.length && k < n; i++) {
    if (html[i] === '<') { const j = html.indexOf('>', i); out += html.slice(i, j + 1); i = j; continue; }
    out += html[i]; k++;
  }
  return out;
}
// Alex "sings" her lines: one word per 16th note of whatever music is playing (a steady pace when
// nothing is), each word with a soft tonal blip that follows a little melody in the song's key.
// Emphasized words (<b>) land on a stronger beat, pop on screen, and get a higher, louder note.
function _say(text, { name = 'Alex' } = {}) {
  text = tintPapers(text);
  if (curChapter === 4) text = tintC3(text);
  histLeave(); sayLog.push({ name, text }); histUI();
  nameEl.textContent = name;
  box.classList.add('talking');
  clearInterval(typing);
  // a paper citation header is shown at once; only the sentence is typed
  const m = text.match(/^(<span class="cite"[^>]*>.*?<\/span>)([\s\S]*)$/);
  const head = m ? m[1] : '', body = m ? m[2] : text;
  textEl.innerHTML = head;
  textEl.dataset.full = text;
  // plain characters, each marked if it sits inside <b>
  const bold = []; let plain = '', depth = 0;
  for (const part of body.split(/(<[^>]+>)/)) {
    if (part.startsWith('<')) { if (/^<b[\s>]/.test(part)) depth++; else if (/^<\/b>/.test(part)) depth = Math.max(0, depth - 1); continue; }
    const txt = part.replace(/&[a-z#0-9]+;/gi, '·'); for (const ch of txt) { plain += ch; bold.push(depth > 0); }
  }
  const words = []; const re = /\S+\s*/g; let mm;
  while ((mm = re.exec(plain))) words.push({ end: mm.index + mm[0].length, word: mm[0].trim(), emph: bold.slice(mm.index, mm.index + mm[0].trim().length).some(Boolean) });
  let k = 0;
  return new Promise((resolve) => {
    typingDone = resolve;
    const step = () => {
      if (k >= words.length) { finishTyping(); return; }
      const w = words[k], prevEmph = k > 0 && words[k - 1].emph;
      textEl.innerHTML = head + htmlPrefix(body, w.end);
      if (w.emph) { const bs = textEl.querySelectorAll('b'); const last = bs[bs.length - 1]; if (last && !prevEmph) last.classList.add('emph-pop'); }
      // one pitch for ordinary words; a stressed word gets a higher, louder note
      sfx.word(w.emph ? 81 : 76, w.emph ? 1 : 0.4);
      k++;
      // talk fast; breathe at sentence ends, a little at commas; land a stressed word on the beat
      const nx = words[k];
      let ms = 38 + 7 * Math.min(10, w.word.length);
      if (/[.!?…]["”’)]*$/.test(w.word)) ms = 420; else if (/[,:;—]["”’)]*$/.test(w.word)) ms = 170;
      if (nx && nx.emph && !w.emph) ms = Math.max(ms, onBeat(ms));
      typing = setTimeout(step, ms);
    };
    typing = setTimeout(step, 60);
  });
}
// ms until the next 16th note of the music, at least `min` ms away (just `min + 80` with no music)
function onBeat(min) {
  let pos = null, bd = 0;
  if (engine.playing && engine.song) { pos = engine.time; bd = engine.song.analysis.beatDur; }
  else if (rise.active && rise.beatDur) { pos = risePos(); bd = rise.beatDur; }
  if (!bd) return min + 80;
  let g = bd / 4; if (g < 0.09) g = bd / 2;
  const t = pos + min / 1000 + 0.04, next = Math.ceil(t / g) * g;
  return Math.max(min, (next - pos) * 1000);
}
function finishTyping() {
  if (!typing) return;
  clearInterval(typing); typing = null;
  box.classList.remove('talking');
  textEl.innerHTML = textEl.dataset.full;
  const r = typingDone; typingDone = null; r && r();
}
const coached = { next: false, action: false, phone: false, skip: false };
function _choices(list) {
  actsEl.replaceChildren();
  return new Promise((resolve) => {
    for (const c of list) {
      const b = document.createElement('button');
      b.className = 'choice' + (c.primary ? ' primary' : '');
      // first-time guidance: the first “Next”, and the first action the reader is asked to take
      const isNext = /^Next/.test(c.label.replace(/<[^>]+>/g, ''));
      const coach = c.coach || (c.primary && !c.locked && (isNext ? !coached.next : !coached.action));
      if (coach) { b.classList.add('coach'); b.dataset.hint = isNext ? 'Click to continue · or press Space' : 'Click to try it'; if (isNext) coached.next = true; else coached.action = true; }
      b.innerHTML = c.label;
      let shown = performance.now();
      if (c.locked) {
        b.disabled = true; b.classList.add('locked');
        const iv = setInterval(() => { if (c.until()) { clearInterval(iv); b.disabled = false; b.classList.remove('locked'); b.innerHTML = c.then; shown = performance.now(); } }, 150);
      }
      b.onclick = (e) => {
        if (b.disabled || swapping) return; // wait for a song switch to finish loading
        e.stopPropagation();
        if (performance.now() - shown < 600) return; // ignore a click/keypress that was meant for the previous line
        // never advance twice in quick succession (double clicks, key + click, key repeat)
        if (performance.now() - (choices.lastAdvance || 0) < 900) return;
        choices.lastAdvance = performance.now();
        b.blur(); actsEl.replaceChildren(); resolve(c.value ?? c.label);
      };
      actsEl.append(b);
    }
  });
}
// Jumping between chapters: every wait in the story is guarded, so a jump cancels whatever the
// current chapter is waiting on (a line, a button, a timer) and the runner starts the new chapter.
class Jump extends Error {}
let epoch = 0;
const live = new Set();
function guard(p) {
  const e = epoch;
  return new Promise((res, rej) => {
    const cancel = () => rej(new Jump());
    live.add(cancel);
    p.then((v) => { live.delete(cancel); e === epoch ? res(v) : rej(new Jump()); }, (err) => { live.delete(cancel); rej(err); });
  });
}
const say = (...a) => guard(_say(...a));
const choices = (...a) => guard(_choices(...a));
const wait = (ms) => guard(sleep(ms));
const later = (fn, ms) => { const e = epoch; setTimeout(() => { if (e === epoch) fn(); }, ms); };
const next = (label = 'Next ▸') => choices([{ label, primary: true }]);
// Looking back: earlier lines can be re-read without touching the story. While an earlier line is
// shown, the current choices are hidden (not removed) and come back on return.
const sayLog = [];
let histAt = -1; // -1: showing the current line
function histUI() {
  const n = sayLog.length;
  $('#dh-prev').disabled = n < 2 || histAt === 0;
  $('#dh-next').disabled = histAt === -1;
  $('#dh-pos').textContent = histAt === -1 ? '' : `${histAt + 1} / ${n}`;
  box.classList.toggle('browsing', histAt !== -1);
}
function histShow(i) {
  if (typing) finishTyping();
  if (i >= sayLog.length - 1) { histLeave(); histUI(); return; }
  histAt = Math.max(0, i);
  const L = sayLog[histAt];
  nameEl.textContent = L.name; textEl.innerHTML = L.text;
  actsEl.style.visibility = 'hidden';
  histUI();
}
function histLeave() {
  if (histAt === -1) return;
  histAt = -1;
  const cur = sayLog[sayLog.length - 1];
  if (cur) { nameEl.textContent = cur.name; textEl.innerHTML = textEl.dataset.full || cur.text; }
  actsEl.style.visibility = '';
}
$('#dh-prev').addEventListener('click', (e) => { e.stopPropagation(); histShow((histAt === -1 ? sayLog.length - 1 : histAt) - 1); });
$('#dh-next').addEventListener('click', (e) => { e.stopPropagation(); histShow(histAt === -1 ? sayLog.length : histAt + 1); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft' && !e.repeat && sayLog.length > 1) { e.preventDefault(); $('#dh-prev').click(); return; }
  if (e.key === 'ArrowRight' && !e.repeat && histAt !== -1) { e.preventDefault(); $('#dh-next').click(); return; }
  // while looking back, Space/Enter returns to the current line instead of advancing
  if ((e.code === 'Space' || e.key === 'Enter') && !e.repeat && histAt !== -1) { e.preventDefault(); e.stopPropagation(); histLeave(); histUI(); return; }
  if ((e.code === 'Space' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); if (typing) finishTyping(); else actsEl.querySelector('.choice.primary, .choice')?.click(); }
});
box.addEventListener('click', (e) => { if (e.target.closest('#dhist') || e.target.closest('a')) return; if (histAt !== -1) { histLeave(); histUI(); return; } finishTyping(); });
// top right: the paper behind the current chapter, styled like a row of the poster
const PAPERS = {
  1: { id: 'maringba', col: '#2fae74', venue: 'CHI 2024 · Best Paper Honorable Mention', title: 'MARingBA: Music-Adaptive Ringtones for Blended Audio Notification Delivery', auth: 'Alexander Wang, Yi Fei Cheng, David Lindlbauer', img: 'maringba-teaser.png' },
  2: { id: 'mva', col: '#e0479e', venue: 'UIST 2024', title: 'Towards Music-Aware Virtual Assistants', auth: 'Alexander Wang, David Lindlbauer, Chris Donahue', img: 'mva-teaser.png' },
  3: { id: 'rise', col: '#e8a33d', venue: 'ISMIR 2025', title: 'RISE: Adaptive Music Playback for Realtime Intensity Synchronization with Exercise', auth: 'Alexander Wang, Chris Donahue, Dhruv Jain', img: 'rise-teaser.png' },
  4: { id: 'multiverse', col: '#1d8a96', venue: 'UIST 2026', title: 'MultiVerse: A Creator-Centered Approach to Steering Context-Adaptive Lyrics', auth: 'Alexander Wang, Chris Donahue, David Lindlbauer', img: 'mv-teaser.png' },
};
let paperHi = null;
const card = $('#papercard');
card.addEventListener('pointerenter', () => { const p = PAPERS[card.dataset.ch]; if (!p) return; paperHi = p.id; vizCard.classList.add('peek'); const f = room.posterFrames[p.id]; label('wall', at(f, 0, 0.62, 0), '📌 on the wall', 'chip'); });
card.addEventListener('pointerleave', () => { paperHi = null; vizCard.classList.remove('peek'); unlabel('wall'); });
card.addEventListener('click', (e) => { e.preventDefault(); const p = PAPERS[card.dataset.ch]; if (p) openPoster(room.posterFrames[p.id]); });
// [kicker, name (html), subtitle (html), colour]; acronym letters in the full name are coloured
const K = (t) => `<em>${t}</em>`;
const TITLES = {
  1: ['Chapter 1', K('MARingBA'), `${K('M')}usic-${K('A')}daptive ${K('Ring')}tones for ${K('B')}lended ${K('A')}udio Notification Delivery · CHI 2024`, '#2fae74'],
  2: ['Chapter 2', K('Musical Agents'), 'Towards Music-Aware Virtual Assistants · UIST 2024', '#e0479e'],
  3: ['Chapter 3', K('RISE'), `${K('R')}ealtime ${K('I')}ntensity ${K('S')}ynchronization with ${K('E')}xercise · ISMIR 2025`, '#e8a33d'],
  4: ['Chapter 4', `Multi${K('Verse')}`, 'A Creator-Centered Approach to Steering Context-Adaptive Lyrics · UIST 2026', '#1d8a96'],
};
let lastTitle = -1, chapterJumped = false;
let lastActivity = performance.now();
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, () => { lastActivity = performance.now(); }, { passive: true, capture: true });
function chapterTitle(n) {
  const T = TITLES[n], el = $('#chtitle');
  if (!T || n === lastTitle) return;
  lastTitle = n;
  el.querySelector('.ct-num').textContent = T[0]; el.querySelector('.ct-name').innerHTML = T[1]; el.querySelector('.ct-sub').innerHTML = T[2];
  el.style.setProperty('--c', T[3]);
  // on the next downbeat of whatever is playing (next beat after a jump from the chapter bar)
  let at = 0;
  const ctx = engine.ctx;
  if (ctx) {
    const jump = chapterJumped; chapterJumped = false;
    if (engine.playing && engine.song) {
      const A = engine.song.analysis, now = engine.time + 0.05;
      const list = jump ? A.beats : A.downbeatIdx.map((i) => A.beats[i]);
      const nx = list.find((x) => x > now); if (nx != null && nx - now < 3) at = engine.ctxTime(nx);
    } else if (rise.active) {
      const p0 = risePos() + 0.05, nb = rise.beats.find((x) => x > p0); if (nb != null) at = ctx.currentTime + (nb - p0) + 0.05;
    }
    const bd = engine.playing && engine.song ? engine.song.analysis.beatDur : rise.active ? rise.beatDur : 0.5;
    const when = at || ctx.currentTime + 0.02;
    // the first note climbs a step each chapter (A, C, D, E over the same G and E echoes)
    sfx.chime(when, bd, [81, 84, 86, 88][n - 1] ?? 84);
    // pop the card up exactly when the first note sounds
    const delay = Math.max(0, (when - ctx.currentTime) * 1000 + (ctx.outputLatency || ctx.baseLatency || 0) * 1000);
    const n0 = n;
    setTimeout(() => { if (lastTitle !== n0) return; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); }, delay);
  } else { el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); }
}
let curChapter = 0;
function chapter(n) {
  curChapter = n;
  // a new chapter: whatever David was doing stops, and (except for the workout) he's back on the couch
  if (n !== 3 && typeof skip !== 'undefined') {
    skip.queue = []; if (skip.play) skipStop(1); riseStop();
    Object.assign(anim, { working: false, free: false, quit: null, idle: null, sing: null, hop: null, walk: null, barMode: null });
    unlabel('energy'); unlabel('sing'); rackBar();
    if (n > 0) { room.person.root.position.copy(HOME_SPOT.p); room.person.root.rotation.y = HOME_SPOT.r; pose('sit', 0.4); }
  }
  document.querySelectorAll('.chapters li').forEach((li, i) => li.classList.toggle('on', i === n));
  chapterTitle(n); chapterJumped = false;
  const p = PAPERS[n];
  card.hidden = !p; card.dataset.ch = n;
  if (p) {
    card.style.setProperty('--pk', p.col);
    card.querySelector('.pk-venue').textContent = p.venue; card.querySelector('.pk-title').textContent = p.title; card.querySelector('.pk-auth').textContent = p.auth;
    card.querySelector('.pk-teaser').src = `img/story/${p.img}`;
    card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  }
}

// "Tuesday evening": the reader's own day and time of day
function nowPhrase() {
  const d = new Date(), h = d.getHours();
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  return `${day} ${part}`;
}
// David's phone, drawn front-on over the room: the reader taps play for him.
// items: [{ title, artist, art }]; resolves with the index tapped, after onPlay(i) has run.
async function phone(items, line, onPlay, onShow = null) {
  const pc = $('#phonecut'), list = pc.querySelector('.pc-list');
  const show = (i) => { onShow && onShow(i); pc.querySelector('.pc-title').textContent = items[i].title; pc.querySelector('.pc-artist').textContent = items[i].artist; pc.querySelector('.pc-art').style.background = items[i].art; };
  // one song at a time, the default first; skip left/right to browse
  let cur = 0;
  show(0);
  pc.classList.remove('gone', 'playing', 'tap', 'edm', 'pick'); pc.classList.toggle('multi', items.length > 1);
  const step = (d) => { cur = (cur + d + items.length) % items.length; show(cur); const a = pc.querySelector('.pc-art'); a.animate([{ transform: `translateX(${d * 24}px)`, opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'ease-out' }); };
  $('#pc-prev').onclick = () => step(-1); $('#pc-next').onclick = () => step(1);
  const seated = anim.pose === 'sit';
  if (seated) {
    anim.ph = { k: 0, to: 0, both: false };
    pose('phoneReach', 0.6); await wait(450); anim.ph.to = 1; await wait(450);
    anim.ph.both = true; pose('phoneHold', 0.6);
  }
  pc.classList.toggle('coach', !coached.phone); coached.phone = true;
  pc.hidden = false;
  const tapped = new Promise((r) => { $('#pc-play').onclick = () => r(cur); });
  let played = false;
  tapped.then(() => { played = true; });
  const pick = await Promise.race([tapped, say(line).then(() => (played ? tapped : choices([{ label: '▶ Play', primary: true, value: -1 }]).then((v) => (v === -1 ? cur : v))))]);
  played = true; finishTyping(); await wait(0); actsEl.replaceChildren();
  show(pick); pc.classList.remove('coach');
  pc.classList.add('tap'); setTimeout(() => pc.classList.remove('tap'), 260);
  await onPlay(pick);
  pc.classList.add('playing');
  await wait(1100);
  pc.classList.add('gone');
  setTimeout(() => { pc.hidden = true; }, 700);
  if (seated) {
    // and back on the table
    await wait(300);
    anim.ph.both = false; pose('phoneReach', 0.6); await wait(400); anim.ph.to = 0; await wait(650);
    pose('sit', 0.7); anim.ph = null;
  }
  return pick;
}

// Sweet spots: beats where the bass (lowest band) comes back after dropping out for a few beats.
// A ringtone that enters exactly there sounds like part of the arrangement.
function sweetSpots() {
  const a = engine.song.analysis, f = a.freq[0], n = f.length;
  const med = [...f].sort((x, y) => x - y)[n >> 1], hi = med * 0.75;
  const out = [];
  for (let i = 4; i < n; i++) {
    if (f[i] < hi) continue;
    let k = 0; while (k < 24 && i - 1 - k >= 0 && f[i - 1 - k] < hi) k++;
    if (k >= 3) out.push(i);
  }
  return out;
}
const SUBTLE = () => ({ ...preset('subtle'), repeats: PICK.reps[1], sweet: sweetSpots(), lenient: 16, minLead: 6 });
let countdown = null;

// ---------------------------------------------------------------- the story
const CH = [async () => {
  chapter(0);
  room.setShot(SHOTS.wide);
  // David's phone, front view: the reader taps play for him
  await say('Hi! My name is <b>Alex</b>. I’m a PhD student at Carnegie Mellon. Today I’d like to introduce you to some of my work on exploring new opportunities for <b>adaptive multimedia experiences</b> and <b>creator control</b>.');
  await next();
  label('davidpin', at(room.person.neck, 0, 0.42, 0), '<span class="dpin"><img src="img/story/david.jpg" alt=""><span><b>David</b><i>our listener</i></span></span><span class="dpin-ar"></span>', 'davidpin');
  await phone(PLAYLIST.map((c) => ({ title: c.s.title, artist: c.s.artist, art: c.art })), `It’s ${nowPhrase()}, and <b>David</b> is home. Let’s put on some music.`, async (i) => {
    PICK = PLAYLIST[i]; HOTLINE = PICK.s; IPHONE = PICK.r;
    $('#phonecut .pc-artist').textContent = 'Loading…';
    try { await loadHome(); } catch (e) { console.error(e); setLoading(`Couldn’t load audio: ${e.message}`); }
    $('#phonecut .pc-artist').textContent = HOTLINE.artist;
    engine.seek(0); engine.play();
  });
  unlabel('davidpin');
  await say('Great song choice! 🎶');
  await choices([{ label: 'Next ▸', primary: true, coach: true }]);
  await say('The way we produce and consume media is rapidly changing. Generative AI is becoming increasingly capable of <b>generating and modifying multimedia content</b>, with higher quality, controllability, and speed.');
  await next();
  await say('I firmly believe these advances present <b>new opportunities for art and storytelling</b>. Instead of simply making content creation easy and fast, generative AI could enable entirely <b>new forms of creative expression</b> that were previously impossible.');
  await next();
  await say('One example: the music you hear doesn’t have to be a fixed recording. It could <b>respond to what is happening around you</b>, as if the musician were performing live, just for you.');
  await next();
}, async () => {
  // ---- Chapter 1: MARingBA
  chapter(1);
  room.setShot(SHOTS.phone);
  await say('Today, it doesn’t. The rest of your devices act as if the music isn’t there. Watch what happens when a call comes in.');
  label('callcue', at(room.phone, 0.2, 0.22, 0), '<span class="cc"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg></span>', 'callcue');
  await choices([{ label: '📞 Ring the phone', primary: true }]);
  unlabel('callcue');
  engine.applyParams(preset('conventional'));
  await engine.trigger(IPHONE, { ...preset('conventional'), repeats: PICK.reps[0] });
  showLive('timeline', 'Standard', 'Ringtone ignores the music', async () => { if (!engine.playing) engine.play(); engine.applyParams(preset('conventional')); await engine.trigger(IPHONE, { ...preset('conventional'), repeats: PICK.reps[0] }); ringing = 'jarring'; });
  ringing = 'jarring';
  startle(1);
  label('call', at(room.phone, 0, 0.18, 0), '<b>Incoming call</b> · Chris Donahue', 'phone');
  think('Ugh, my song! Chris, why now?! 😣', 'bad');
  await say('<b>Jarring.</b> The song is cut out, and the ringtone blasts in its own tempo and key, wherever the song happens to be.');
  await wait(1500);
  await choices([{ label: 'Try it again with MARingBA', primary: true }]);
  engine.dismiss(); unlabel('call'); unlabel('callcue'); ringing = null; unthink();
  room.setShot(SHOTS.speakers);
  showLive('mir', 'MARingBA', 'Music information retrieval');
  await say('In our CHI paper, <b>MARingBA</b>, we first read the music with <b>music information retrieval</b>: beats and downbeats, key, and separated vocals.');
  label('callcue', at(room.phone, 0.2, 0.22, 0), '<span class="cc"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg></span>', 'callcue');
  await next('Ring it again ▸');
  const p = preset('subtle');
  engine.applyParams(p);
  const ring = await engine.trigger(IPHONE, SUBTLE());
  unlabel('callcue'); countdown = ring;
  const x = ring.prep;
  ringing = 'blended';
  later(() => { anim.groove = true; think('Oh, Chris is calling. Still in the groove 🎶', 'good'); }, Math.max(0, ring.wait * 1000));
  showLive('timeline', 'MARingBA', 'Ringtone matched to the music', async () => { if (!engine.playing) engine.play(); engine.applyParams(preset('subtle')); countdown = await engine.trigger(IPHONE, SUBTLE()); ringing = 'blended'; });
  room.setShot(SHOTS.phone);
  await say('The ringtone is <b>stretched to the song’s tempo</b>, <b>moved into its key</b>, and <b>waits for the next phrase</b>, then fades in softly like another instrument in the mix. You still notice it. It just doesn’t break the song.');
  // don't move on until the adapted ringtone has actually played
  await choices([{ label: '🔔 Listen to it ring…', locked: true, until: () => !engine.ring || engine.time > ring.t1 + 0.2, then: 'Next ▸' }]);
  engine.dismiss(); clearLabels(); countdown = null; ringing = null; anim.groove = false;
  showLive('bm', 'CHI 2024', 'Beat matching');
  await say('<span class="cite">MARingBA · CHI 2024 · Best Paper Honorable Mention</span>Its settings let a notification be tuned from subtle to urgent: saliency becomes a design choice, not a side effect.');
  await next();
  showLive('study', 'CHI 2024', 'User study (N = 12): reaction time');
  figs.study.t0 = null;
  await say('<span class="cite">MARingBA · CHI 2024 · user study</span>We empirically show that we can <b>computationally modulate people’s reaction time and perceived disruption</b>, while keeping <b>high confidence that every ringtone is detected</b>.');
  await next();

}, async () => {
  // ---- Chapter 2: music-aware voice agent
  chapter(2);
  hideViz();
  room.setShot(SHOTS.person);
  await say('A ringtone only needs to be noticed. A <b>voice agent</b> has something to <b>say</b>. Here is today’s voice agent with a new calendar invite.');
  await choices([{ label: '🔊 Standard voice agent', primary: true }]);
  label('vb', at(room.phone, 0, 0.2, 0), '“New calendar invite from Alex.”', 'speech');
  startle(0.8);
  think('Hey, I was listening to that…', 'bad');
  const d1 = speakFlight();
  showLive('roll', 'Standard', 'Music ducks for the voice', async () => { if (!engine.playing) engine.play(); speakFlight(); });
  await say('The music drops out so the voice agent can talk over it. Clear, but it <b>stops the song</b> every time.');
  await wait(Math.max(0, d1 * 1000 - 1500));
  unlabel('vb');
  await choices([{ label: '🎤 Sing it into the song', primary: true }]);
  unthink();
  room.setShot(SHOTS.speakers);
  setLoading('Composing…');
  const sung = await singFlight();
  setLoading('');
  later(() => { anim.groove = true; think(`Ha! Alex’s invite, sung over ${HOTLINE.artist.split(' ft.')[0]} 😄`, 'good'); }, Math.max(0, sung.wait * 1000));
  showLive('roll', 'Music-aware', 'Message sung into the song', async () => { if (!engine.playing) engine.play(); await singFlight(); });
  await say('With a <b>music-aware voice agent</b>, from our UIST paper <i>Towards Music-Aware Virtual Assistants</i>, the message is <b>sung in place of the singer</b>, to the beat. Each syllable gets one note, close to <b>where it is naturally spoken</b>, so the words stay intelligible.');
  await wait(Math.max(0, (sung.wait + sung.dur) * 1000 - 2500));
  await next();
  clearLabels(); anim.groove = false;
  showLive('pro', 'UIST 2024', 'Prosody-conditioned music generation');
  await say('<span class="cite">Towards Music-Aware Virtual Assistants · UIST 2024</span>In the paper, a <b>transformer-based music generation model, conditioned on the speech’s prosody</b>, writes a new melody that fits both the song and the words. We don’t have a GPU to run that model here, so this demo uses a simpler approach that is still prosody-based.');
  await next();
  showLive('wer', 'UIST 2024', 'Word error rate');
  figs.wer.t0 = null;
  await say('<span class="cite">Towards Music-Aware Virtual Assistants · UIST 2024 · results</span>Conditioning on prosody keeps the sung words intelligible: speech recognition transcribes them at a <b>2% word error rate</b>, versus <b>15% without prosody conditioning</b>.');
  await next();

}, async () => {
  // ---- Chapter 3: RISE
  chapter(3);
  hideViz();
  room.setShot(SHOTS.mat);
  pose('stand', 0.8);
  walkTo([1.65, 0, 0.55], 0.25, 2.4);
  await say('Music can also adapt to what you are doing. Time for David’s workout.');
  await next();
  rise.adapt = false;
  let dropEnd = 0;
  const HI = () => (rise.meta && ['Metal', 'Pop'].includes(rise.meta.genre) ? 'chorus' : 'drop');
  await phone(WORKOUT.map((w) => ({ title: w.title, artist: `${w.artist} · ${w.genre}`, art: w.art })), `Help David put on some <b class="genre" style="color:${WORKOUT[0].col}">${WORKOUT[0].say}</b> for his set.`, async (i) => {
    $('#phonecut .pc-artist').textContent = 'Loading…';
    await loadRise(WORKOUT[i]);
    $('#phonecut .pc-artist').textContent = `${WORKOUT[i].artist} · ${WORKOUT[i].genre}`;
    dropEnd = rise.segs.find((s) => s.high).end;
    engine.fadeStop(2.5); // the earlier song fades out as the workout song fades in
    riseStart(dropEnd - 9 - (WORKOUT[i].judge ? 2.6 : 0), 2);
  }, (i) => {
    // the line follows the song on screen: “some EDM”, “some rap”…
    const html = `<b class="genre" style="color:${WORKOUT[i].col}">${WORKOUT[i].say}</b>`;
    textEl.dataset.full = (textEl.dataset.full || '').replace(/<b class="genre"[^>]*>.*?<\/b>/, html);
    const el = textEl.querySelector('.genre'); if (el) el.outerHTML = html;
  });
  if (rise.meta.judge) {
    // David has opinions about the song choice
    pose('frustrated', 0.5); think(rise.meta.judge, 'bad', 3200);
    await wait(2600);
  }
  pose('rack', 0.5); anim.working = true; anim.reps = 0;
  showLive('rise', 'Standard', 'Song as written');
  think('Let’s go! 💪', 'good', 3500);
  await say(`David starts squatting during the ${HI()}…`);
  await guard(new Promise((r) => { anim.onCalm = r; }));
  await say(`…and halfway through the set, <b>the ${HI()} ends</b>. The energy drops right when David needs it, and he stops.`);
  await wait(1500);
  riseStop(); rackBar();
  await choices([{ label: 'Try it again with RISE', primary: true }]);
  unthink();
  rise.adapt = true;
  const loopStart = rise.choice ? rise.choice.orig - 9 : dropEnd - 9;
  riseStart(loopStart);
  pose('rack', 0.5); anim.working = true; anim.reps = 0;
  showLive('rise', 'RISE', 'Loops while David works');
  think('Let’s go! 💪', 'good', 3500);
  later(() => think(`Yes! Keep the ${HI()} going 🔥`, 'good'), 9600);
  await say(`<b>RISE</b>, from our ISMIR paper, knows David is still working. Near the end of the ${HI()} it <b>jumps back to a point where the music repeats</b>, so the ${HI()} keeps going.`);
  await wait(11000);
  await next();
  await say('The loop sits on a <b>seamless cutpoint</b> inside the section, found ahead of time from the song’s own repetition. Listeners rate these cuts as natural as unedited audio.');
  await next('Finish the set ▸');
  anim.working = false; pose('stand', 0.6); riseStop(); rackBar(); unthink();
  // skipping: after resting, David is ready, but the song is still calm
  setLoading('Loading The Middle…');
  await loadSkip();
  setLoading('');
  showLive('skip', 'RISE', 'Skip to the drop');
  skipAuto(0, 1);
  think('Ready for the next set!', 'good', 3000);
  skip.played = false;
  await say(`RISE can also <b>skip</b>. David has rested and is ready to go, but the song is still in a calm part: in <b>${SKIP.title}</b>, the energy only comes back ${Math.round(skip.hiAt - SKIP.from)} s later. Listen to both versions.`);
  await next();
  await say(`With RISE, the song <b>jumps ahead</b> at a seamless cutpoint, from ${fmtS(skip.cut.orig)} to ${fmtS(skip.cut.dest)}, so the high-energy part arrives <b>${(skip.cut.dest - skip.cut.orig).toFixed(0)} s sooner</b>. Play both to compare.`);
  await next();
  skip.queue = []; skipStop(); anim.free = false; anim.working = false; pose('stand', 0.5); rackBar();
  showLive('cutplay', 'ISMIR 2025', 'Seamless cutpoints');
  skipAuto(2, 3);
  await say('<span class="cite">RISE · ISMIR 2025</span>When a set starts, it can skip ahead to reach high energy sooner; when David rests, it can skip out of it.');
  await next();
  skip.queue = []; skipStop(1.5); anim.free = false; anim.working = false;

}, async () => {
  // ---- Chapter 4: MultiVerse
  chapter(4);
  hideViz();
  room.setShot(SHOTS.wide);
  await say('A call, a voice agent, a workout: each time, the music <b>adapted while it played</b>. These are new forms of <b>adaptive multimedia experiences</b> that audiences love.');
  await next();
  await say('We call this <b>adaptive media</b>: media whose content varies in response to its runtime context. A song could even change depending on who is listening.');
  await next();
  await say('But <b>how can a creator control this?</b> The space of runtime contexts is so large that creators cannot anticipate every adaptation.');
  await next();
  showLive('mv', 'MultiVerse', 'C³ steering controls');
  mv.set({});
  await say('We propose <b>C³</b>, a creator-centered framework for authoring adaptive media, based on three dimensions: <b>creator</b> intent, <b>content</b> structure, and runtime <b>context</b>. Hover the diagram: most prior work either adapts interfaces for pragmatic goals, or supports creators in making static content.');
  await next();
  await say('We instantiated the framework in <b>MultiVerse</b>, our UIST 2026 paper: an authoring system for adaptive lyrics.');
  await next();
  // the pipeline: profile + controls → generation → lyrics; starts on the full-control version
  showLive('mvpipe', 'MultiVerse', 'Steering adaptive lyrics');
  mvp.seen = new Set(['anna']); mvp.set({ who: 'anna', level: 0 });
  mvp.setGuide('ctl');
  await say('The songwriter’s <b>controls</b> and a listener’s <b>persona</b> go into an LLM, and the adapted lyrics come out. With no controls, the song loses its theme and its rhyme. Turn on the <b>content</b> control.');
  await guard(mvp.until((m) => m.state.who === 'anna' && m.state.level >= 1));
  await say('Now the rhyme is kept, but the sad theme is gone. Turn on the <b>creator</b> control.');
  await guard(mvp.until((m) => m.state.who === 'anna' && m.state.level >= 2));
  await say('Isolation and “hates me” are back, but it isn’t about Anna. Turn on the <b>context</b> control.');
  await guard(mvp.until((m) => m.state.who === 'anna' && m.state.level >= 3));
  mvp.setGuide('who');
  await say('Now it’s Anna’s story, in the songwriter’s voice. Same controls, different listener: try <b>Elena</b> and <b>David</b>.');
  await guard(mvp.until((m) => m.seen.has('elena') && m.seen.has('david')));
  mvp.setGuide(null);
  await next();
  stopClip(); unthink();
  await say('<span class="cite">MultiVerse · UIST 2026</span>We conducted a study with <b>10 songwriters</b>, who transformed their own compositions into adaptive versions. MultiVerse demonstrates that creators can <b>maintain control over adaptive media</b> through authoring mechanisms that shape how the output aligns with their intent.');
  await next();

}, async () => {
  // ---- Ending
  chapter(5);
  hideViz();
  walkTo([-0.3, 0, -1.85], 0, 2.2); later(() => pose('sit', 0.8), 2000);
  room.setShot(SHOTS.wide);
  engine.play();
  later(() => callPhone('📱 <b>2 new messages</b> · tap the phone'), 2500);
  await say('Music that listens back: it makes room for a call, sings a message, keeps a workout going, and tells each listener’s story <b>the way the artist meant it</b>.');
  
  // what next: questions float in the middle; Re-watch / Back to the website stay in the dialogue
  const asked = new Set();
  let first = true, unlocked = false;
  for (;;) {
    const list = [
      ['future', 'What’s next? (future work)'],
      ['creators', 'What did songwriters think?'],
      ['live', 'Why make recorded music adaptive at all?'],
    ];
    let reveal = false;
    if (asked.has('live') || asked.has('creators')) { list.push(['author', 'Is it still the creator’s if it’s adapted by AI??']); if (!unlocked) { unlocked = true; reveal = true; } }
    const allAsked = list.every(([id]) => asked.has(id));
    if (!first) await say(reveal ? 'Oh! That raises another question…' : allAsked ? 'Thank you so much for playing through the entire experience!! If you have any questions or want to discuss anything, feel free to drop me a message at <a href="mailto:alexanderwang@cmu.edu">alexanderwang@cmu.edu</a>. Even if you just found this experience fun, I’d love to hear it! 😊 Feel free to look around the room, and check David’s phone.' : 'Anything else?');
    first = false;
    
    // once everything has been asked, the bubbles stay hidden until the reader asks for them
    let pick = allAsked ? await choices([{ label: '💬 Questions', value: 'qs' }, { label: '↺ Re-watch', value: 'again' }, { label: '🏠 Back to my website', value: 'home', primary: true }]) : null;
    if (!allAsked || pick === 'qs') pick = await Promise.race([
      askQuestion(list, asked, reveal),
      choices([{ label: '↺ Re-watch', value: 'again' }, { label: '🏠 Back to my website', value: 'home', primary: true }]),
    ]);
    $('#questions').hidden = true; actsEl.replaceChildren();
    if (pick === 'again') { location.reload(); return; }
    if (pick === 'home') { goHome(true); return; }
    $('#outro').hidden = true;
    asked.add(pick);
    if (pick === 'live') {
      await say('Recorded, static music is a <b>recent phenomenon</b> in the history of human storytelling. For the longest time, music was a <b>live</b> activity: performers read the room and played to the moment and to the people in it.');
      await next();
      await say('Moving to the digital era, we <b>lost many of those rich storytelling qualities</b>, in exchange for others: music became accessible to far more people, at any time.');
      await next();
      await say('Bringing <b>context-sensitivity</b> back into digital music may let us get the best of both worlds, and make music feel <b>“live”</b> again.');
      await next();
    } else if (pick === 'future') {
      await say('<span class="cite" style="color:#e0384f">Future work · Content</span>First, we plan to explore <b style="color:#e0384f">other forms of adaptive multimedia beyond lyrics</b>. For instance, what would a similar adaptive medium look like for video? And what technical innovations are needed to enable similar <b>control mechanisms</b> for these domains?');
      await next();
      await say('<span class="cite" style="color:#1fa4b8">Future work · Context</span>Second, our work only explored the creator side of adaptive media. Future work should explore how to <b style="color:#1fa4b8">collect context in real-life scenarios</b>, without violating privacy.');
      await next();
      await say('<span class="cite" style="color:#f07a1c">Future work · Creator</span>Finally, the development of effective <b style="color:#f07a1c">authoring tools</b> remains a difficult challenge. Future work should explore technical approaches to <b>control the output space</b>, workflow designs for efficient review and <b>intent specification</b>, and evaluation methods to determine success criteria for such tools.');
      await next();
    } else if (pick === 'creators') {
      await say('Songwriters saw adaptive music as a way to <b>get their point across</b> better, and to <b>connect with their audience</b>, even letting fans co-create or “customize lyrics to their experiences.”');
      await next();
      await say('They also valued the <b>creative process</b>: authoring adaptive lyrics pushed them to identify the essence of their own work. As one participant put it, “the system helps you decide what’s distinctive about the music that makes it you.”');
      await next();
      await say('But they raised concerns about <b>authenticity</b> and <b>relatability</b>: adaptations could use words they would never use, and hyper-tailored lyrics could lose the shared experience a song creates.');
      await next();
    } else if (pick === 'author') {
      await say('That’s a difficult question, and a <b>key challenge</b> in making this paradigm possible. To make “live” music scalable, we essentially need a <b>digital duplicate of the author</b>.');
      await next();
      await say('I’m optimistic about this. Think of interactive media like <b>video games</b>: the designer doesn’t create one static instance, but a whole <b>space of possible experiences</b> for the audience.');
      await next();
      await say('Playtesting takes a lot of time, to make sure nothing unexpected happens. But once it’s finalized, the author still keeps their <b>creative voice</b>, even though every player gets a completely different story and trajectory.');
      await next();
      await say('I’m actively working on better <b>control and authoring mechanisms</b> that let creators keep their voice.');
      await next();
    }
  }
}];
// questions float on screen as bubbles; resolves with the id of the one clicked
function askQuestion(list, asked = new Set(), reveal = false) {
  const box = $('#questions');
  box.replaceChildren(...list.map(([id, text], k) => { const b = document.createElement('button'); b.className = 'qbub' + (asked.has(id) ? ' done' : '') + (id === 'author' && !asked.has('author') ? ' fresh' : ''); b.style.setProperty('--k', k); b.textContent = (asked.has(id) ? '✓ ' : '') + text; b.dataset.id = id; return b; }));
  box.hidden = false;
  // a newly found question: a glowing orb shakes, bursts open, and the question pops out
  if (reveal) {
    const b = box.querySelector('.qbub.fresh');
    if (b) {
      b.classList.add('unlock');
      const fx = document.createElement('div'); fx.className = 'unlockfx';
      fx.innerHTML = '<div class="uf-rays"></div><div class="uf-orb">?</div><div class="uf-banner">✨ New question unlocked!</div>' + Array.from({ length: 18 }, (_, i) => `<i style="--a:${i * 20}deg;--d:${60 + (i % 3) * 30}px;--c:${['#ffd166', '#ff8fcb', '#7fe3ef'][i % 3]}"></i>`).join('');
      b.append(fx);
      setTimeout(() => sfx.unlock(), 1150);
      setTimeout(() => { b.classList.remove('unlock'); b.classList.add('unlocked'); }, 1200);
      setTimeout(() => fx.remove(), 3600);
    }
  }
  return guard(new Promise((res) => { box.onclick = (e) => { const b = e.target.closest('.qbub'); if (!b) return; box.hidden = true; res(b.dataset.id); }; })).finally(() => { box.hidden = true; });
}
// Click a speaker to switch to the next song, any time the home song is playing (not during the
// workout or the lyrics, which use their own audio). Anything tied to the old song is cleared first.
let swapping = false;
const swapClicks = [];
async function swapSong(to = null) {
  // clicking through songs too fast: David has had enough
  const nowMs = performance.now();
  swapClicks.push(nowMs); while (swapClicks.length && nowMs - swapClicks[0] > 4000) swapClicks.shift();
  if (to == null && swapClicks.length >= 5) { swapClicks.length = 0; think(['Can you pick one already?? 😤', 'Make up your mind!', 'I was vibing to that one…'][Math.floor(Math.random() * 3)], 'bad', 2600); }
  if (swapping || !started || ![0, 1, 2, 5].includes(curChapter) || !engine.song || !$('#phonecut').hidden) return;
  swapping = true;
  try {
    // silence what belongs to the old song: ringtones, countdown, sung or spoken invites, ducking
    engine.dismiss(); ringing = null; countdown = null;
    for (const v of voiceSrcs.splice(0)) { try { v.stop(); } catch {} }
    const now = engine.ctx.currentTime;
    for (const g of [engine.vocalGain.gain, engine.accGain.gain]) { g.cancelScheduledValues(0); g.setValueAtTime(1, now); }
    vz.notif = null;
    for (const id of ['bm', 'km', 'nb', 'vs', 'sy', 'pi', 'countdown', 'vb', 'call', 'callcue']) unlabel(id);
    anim.groove = false;
    PICK = to != null ? PLAYLIST[to] : PLAYLIST[(PLAYLIST.indexOf(PICK) + 1) % PLAYLIST.length]; HOTLINE = PICK.s; IPHONE = PICK.r;
    musicNow = { kind: 'g', i: PLAYLIST.indexOf(PICK) }; // David's phone shows what the speakers play
    if (!$('#phoneapp').hidden) phoneTab('music');
    if (to == null) flashLabel('swap', at(room.speakers[1], 0, 1.35, 0), `♫ <b>${HOTLINE.title}</b> · ${HOTLINE.artist}`, 2600);
    await loadHome();
    engine.seek(0); engine.play();
  } catch (e) { console.error(e); setLoading(''); }
  finally { swapping = false; }
}
// ---------------------------------------------------------------- David's phone (at the end)
// Music: pick a song and set the volume. Messages: Alex and Chris have been texting David, and the
// reader chooses how he replies.
const LYRIC_REPLY = { hotline: '♪ You used to call me on my cell phone… you used to, you used to ♪', nothing: '♪ Beautiful girls all over the world… they got nothin’ on you~ ♪', whatislove: '♪ What is love??? ♪' };
const WORKOUT_REPLY = { waves: '♪ Missing you comes in waves~ ♪', humble: '♪ Be humble! ♪', lost: '♪ I’m lost in these meeeeeemories ♪', cruelsummer: '♪ And it’s oooooh, whoa-oh, it’s a cruel summer ♪' };
const songReplies = () => [['song', LYRIC_REPLY[HOTLINE.id]], ['workout', WORKOUT_REPLY[(rise.meta && rise.meta.id) || 'waves']]];
const CHATS = {
  alex: { name: 'Alex', img: 'img/story/alex-drawn.png', msgs: [['in', 'Hey David! Did you get my calendar invite?? 📅']],
    replies: songReplies,
    answer: { song: '???', workout: '???' } },
  chris: { name: 'Chris Donahue', img: 'img/story/chris.jpg', msgs: [['in', 'Hey, I called earlier. Can you call me back when you get a chance?']],
    replies: songReplies,
    answer: { song: '…are you okay? 😂', workout: '…are you okay? 😂' } },
};
const chatLog = { alex: [], chris: [] };
// Alex's own songs: shown locked, each opening on SoundCloud
const ALEX_SC = 'https://soundcloud.com/alex-wang-796617401/sets/alexs-compositions/s-NJGasTQyLPD';
const ALEX_SONGS = [
  { id: 'floating', art: 'linear-gradient(135deg, #b8f6ff, #22b5c2 50%, #06303a)', title: 'Floating', sub: 'Alexander Wang · 1/3', url: 'https://soundcloud.com/alex-wang-796617401/floating-lyrics-by-johnny-hu-1/s-rjxvc3g1Jye' },
  { id: 'errorcode', art: 'linear-gradient(135deg, #d9a6ff, #6b1fd1 50%, #0b0412)', title: 'Error Code: Pse', sub: 'Alexander Wang · 2/3', url: 'https://soundcloud.com/alex-wang-796617401/error-code-pse-1/s-6IAKtF9TItr' },
  { id: 'afterburn', art: 'linear-gradient(135deg, #ffe0a0, #e8902a 50%, #3a2412)', title: 'Afterburn', sub: 'Alexander Wang · 3/3', url: 'https://soundcloud.com/alex-wang-796617401/afterburn-1/s-CDRMXF8urPA' },
];
// Alex's songs unlock by beating them in Liminality, played on David's phone
const unlocked = new Set((() => { try { return JSON.parse(localStorage.getItem('story.unlocked') || '[]'); } catch { return []; } })());
// ---- David's music player (end of the story): one queue across the library, with play/pause,
// previous/next, a clickable timeline, and auto-advance when a song ends
let alexAudio = null, alexNow = null, musicNow = null, riseLast = 0;
// Alex's songs play from the decoded Liminality journey, through the same output as everything else
// (so the volume slider applies). alexAudio = { src, g, t0, at, paused }
function stopAlex() { if (alexAudio) { const n = engine.ctx.currentTime; try { alexAudio.g.gain.setTargetAtTime(0, n, 0.08); alexAudio.src.stop(n + 0.3); } catch {} alexAudio = null; alexNow = null; } }
async function playAlex(id, at = 0) {
  stopAlex(); engine.fadeStop(1); riseStop();
  alexNow = id;
  const [, buf] = await loadJourney(engine.ctx);
  if (alexNow !== id) return;
  const S = LIM_SONGS[id], ctx = engine.ctx, g = ctx.createGain(), src = ctx.createBufferSource();
  src.buffer = buf; g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(1 / outNorm(), ctx.currentTime + 0.4);
  src.connect(g).connect(engine.master); src.start(ctx.currentTime + 0.02, S.from + at);
  alexAudio = { src, g, t0: ctx.currentTime + 0.02, at, paused: false };
}
const alexPos = () => (alexAudio ? (alexAudio.paused ? alexAudio.at : alexAudio.at + engine.ctx.currentTime - alexAudio.t0) : 0);
const queue = () => [
  ...PLAYLIST.map((c, i) => ({ kind: 'g', i, title: c.s.title, artist: c.s.artist })),
  ...WORKOUT.map((w, i) => ({ kind: 'w', i, title: w.title, artist: w.artist })),
  ...ALEX_SONGS.filter((a) => unlocked.has(a.id)).map((a) => ({ kind: 'a', id: a.id, title: a.title, artist: 'Alexander Wang' })),
];
const sameTrack = (a, b) => a && b && a.kind === b.kind && (a.kind === 'a' ? a.id === b.id : a.i === b.i);
async function playTrack(tr, at = 0) {
  musicNow = tr;
  if (tr.kind === 'a') { playAlex(tr.id, at); }
  else if (tr.kind === 'g') {
    stopAlex(); riseStop();
    if (PLAYLIST[tr.i] !== PICK || !engine.song) await swapSong(tr.i); else { engine.seek(at); engine.play(); }
    if (engine.song) engine.song.loop = null; // in the player, songs end and the next one starts
    if (at) engine.seek(at);
  } else {
    stopAlex(); const w = WORKOUT[tr.i];
    if (!rise.meta || rise.meta.id !== w.id || !rise.buf) await loadRise(w);
    engine.fadeStop(1.2); rise.adapt = false; riseStart(at, at ? 0.3 : 1.2);
  }
  if (!$('#phoneapp').hidden) phoneTab('music');
}
// where the current track is: { pos, dur, playing }
function trackPos() {
  const m = musicNow; if (!m) return null;
  if (m.kind === 'a') { const S = LIM_SONGS[m.id]; return { pos: alexPos(), dur: S.to - S.from, playing: !!alexAudio && !alexAudio.paused }; }
  if (m.kind === 'g') return engine.song ? { pos: engine.time, dur: engine.song.duration, playing: engine.playing } : null;
  return rise.buf ? { pos: rise.active ? risePos() : riseLast, dur: rise.buf.duration, playing: rise.active } : null;
}
function togglePlay() {
  const m = musicNow, p = trackPos(); if (!m || !p) return;
  if (m.kind === 'a') { if (p.playing) { const at = alexPos(); const id = m.id; stopAlex(); alexNow = id; alexAudio = { paused: true, at, g: { gain: { setTargetAtTime() {} } }, src: { stop() {} } }; } else playAlex(m.id, alexPos()); }
  else if (m.kind === 'g') { p.playing ? engine.stop() : engine.play(); }
  else if (p.playing) { riseLast = risePos(); riseStop(); } else riseStart(riseLast, 0.3);
}
function seekTrack(frac) {
  const m = musicNow, p = trackPos(); if (!m || !p) return;
  const at = Math.max(0, Math.min(p.dur - 0.5, frac * p.dur));
  if (m.kind === 'a') playAlex(m.id, at);
  else if (m.kind === 'g') { engine.seek(at); if (!engine.playing) engine.play(); }
  else riseStart(at, 0.15);
}
function stepTrack(d) {
  const q = queue(); if (!musicNow) musicNow = { kind: 'g', i: PLAYLIST.indexOf(PICK) };
  const i = q.findIndex((t) => sameTrack(t, musicNow));
  playTrack(q[((i < 0 ? 0 : i) + d + q.length) % q.length]);
}
async function speakerNext() {
  if (speakerNext.busy) return; speakerNext.busy = true;
  try { await stepTrack(1); const m = musicNow, t = m.kind === 'a' ? { title: LIM_SONGS[m.id].title, artist: 'Alexander Wang' } : m.kind === 'w' ? WORKOUT[m.i] : PLAYLIST[m.i].s; flashLabel('swap', at(room.speakers[1], 0, 1.35, 0), `♫ <b>${t.title}</b> · ${t.artist}`, 2600); }
  finally { speakerNext.busy = false; }
}
// called each frame: advance when a song ends, keep the phone's timeline moving
function musicTick() {
  if (!musicNow) return;
  const p = trackPos(); if (!p) return;
  if (p.playing && p.pos >= p.dur - 0.25 && !musicTick.busy) { musicTick.busy = true; Promise.resolve(stepTrack(1)).finally(() => { musicTick.busy = false; }); return; }
  const bar = document.querySelector('.pa-tl i'); if (bar) bar.style.width = `${(100 * p.pos) / p.dur}%`;
  const tt = document.querySelector('.pa-time'); if (tt) tt.textContent = `${fmt(p.pos)} / ${fmt(p.dur)}`;
  const pb = document.querySelector('.pa-pp'); if (pb) pb.textContent = p.playing ? '❚❚' : '▶';
}
let lim = null;
// playtest shortcut: story.html?dev, then press L anywhere to open Liminality
if (new URLSearchParams(location.search).has('dev')) window.addEventListener('keydown', (e) => { if (e.code === 'KeyL' && $('#limgame').hidden && engine.ctx) playLiminality(); });
function playLiminality() {
  $('#phoneapp').hidden = true;
  lim = lim || new Liminality($('#limgame'), engine.ctx, engine.master);
  // the room dims; David picks up his phone and plays the whole journey
  document.body.classList.add('lim-on');
  engine.fadeStop(1); riseStop(); stopAlex();
  Object.assign(anim, { sing: null, idle: null });
  anim.ph = { k: 0, to: 1, both: true }; pose('phoneHold', 0.6);
  think('Let’s go 🎮', 'good', 2000);
  lim.open({
    onCleared: (id) => { unlocked.add(id); try { localStorage.setItem('story.unlocked', JSON.stringify([...unlocked])); } catch {} },
    onClose: (cleared) => {
      document.body.classList.remove('lim-on');
      if (anim.ph) { anim.ph.both = false; anim.ph.to = 0; }
      later(() => { pose('sit', 0.6); anim.ph = null; }, 700);
      if (cleared.length) { think(`Unlocked ${cleared.map((id) => LIM_SONGS[id].title).join(', ')}! 🎉`, 'good', 3200); later(() => { playTrack({ kind: 'a', id: cleared[0], title: LIM_SONGS[cleared[0]].title }); callPhone(`🎵 <b>${cleared.length} new song${cleared.length > 1 ? 's' : ''}</b> · tap the phone`); }, 900); }
      else { think('So close…', 'bad', 2200); engine.play(); }
    },
  });
}
// make the 3D phone call for attention: a bobbing tag and a glowing pulse, until it's tapped
function callPhone(text) {
  label('phonehint', at(room.phone, 0, 0.25, 0), `<span class="ph-in">${text}</span>`, 'phonehint');
  anim.phoneGlow = true;
}
function openPhoneApp(tab = 'messages') {
  unlabel('phonehint'); anim.phoneGlow = false;
  const el = $('#phoneapp');
  el.hidden = false;
  phoneTab(tab);
}
function phoneTab(tab, chat = null) {
  const el = $('#phoneapp'), body = el.querySelector('.pa-body');
  for (const b of el.querySelectorAll('.pa-tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  if (tab === 'game') {
    body.innerHTML = `<div class="pa-game">
      <div class="pg-art"><i></i><b>LIMINALITY</b><span>a five-lane rhythm game by Alex</span></div>
      <div class="pg-songs">${ALEX_SONGS.map((a) => `<span class="${unlocked.has(a.id) ? 'on' : ''}" style="${unlocked.has(a.id) ? `background:${a.art};color:#fff` : ''}">${unlocked.has(a.id) ? '🔓' : '🔒'} ${a.title}</span>`).join('')}</div>
      <button class="pg-play">▶ Play</button></div>`;
    body.querySelector('.pg-play').onclick = () => playLiminality();
    return;
  }
  if (tab === 'music') {
    if (!musicNow) musicNow = rise.active && rise.meta ? { kind: 'w', i: WORKOUT.findIndex((w) => w.id === rise.meta.id) } : { kind: 'g', i: PLAYLIST.indexOf(PICK) };
    const vol = Math.round((engine.master ? engine.master.gain.value : 1) * 100);
    const m = musicNow;
    const now = m.kind === 'a' ? { title: LIM_SONGS[m.id].title, artist: 'Alexander Wang' } : m.kind === 'w' ? { title: WORKOUT[m.i].title, artist: WORKOUT[m.i].artist } : { title: PLAYLIST[m.i].s.title, artist: PLAYLIST[m.i].s.artist };
    const row = (attrs, art, title, sub, on) => `<button ${attrs} class="${on ? 'on' : ''}"><i style="background:${art}">♪</i><span><b>${title}</b>${sub}</span>${on ? '<em>♫</em>' : ''}</button>`;
    body.innerHTML = `<div class="pa-now"><span>Now playing</span><b>${now.title}</b>${now.artist}</div>
      <div class="pa-tl" title="Click to jump"><i></i></div><div class="pa-time mono"></div>
      <div class="pa-ctl"><button data-c="prev" aria-label="Previous">⏮</button><button data-c="pp" class="pa-pp" aria-label="Play or pause">❚❚</button><button data-c="next" aria-label="Next">⏭</button></div>
      <label class="pa-vol">🔈<input type="range" min="0" max="100" value="${vol}" aria-label="Volume">🔊</label>
      <div class="pa-lib">
        <div class="pa-sec">General</div>
        ${PLAYLIST.map((c, i) => row(`data-g="${i}"`, c.art, c.s.title, c.s.artist, m.kind === 'g' && m.i === i)).join('')}
        <div class="pa-sec">Workout</div>
        ${WORKOUT.map((w, i) => row(`data-w="${i}"`, w.art, w.title, `${w.artist} · ${w.genre}`, m.kind === 'w' && m.i === i)).join('')}
        <div class="pa-sec">Alex’s music <a href="${ALEX_SC}" target="_blank" rel="noopener">SoundCloud ↗</a></div>
        ${ALEX_SONGS.map((a) => unlocked.has(a.id)
          ? row(`data-a="${a.id}"`, a.art, a.title, a.sub, m.kind === 'a' && m.id === a.id)
          : `<button class="pa-lock" data-lock="${a.id}"><i>🔒</i><span><b>${a.title}</b>${a.sub} · locked</span></button>`).join('')}
        <div class="pa-lockmsg" hidden></div>
      </div>`;
    body.querySelector('input').oninput = (e) => { if (engine.master) engine.master.gain.value = e.target.value / 100; };
    body.querySelector('.pa-tl').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); seekTrack((e.clientX - r.left) / r.width); };
    body.querySelector('.pa-ctl').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.c === 'pp') togglePlay(); else stepTrack(b.dataset.c === 'next' ? 1 : -1); };
    musicTick();
    body.querySelector('.pa-lib').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.classList.contains('on')) return;
      if (b.dataset.lock) {
        const msg = body.querySelector('.pa-lockmsg');
        msg.hidden = false;
        msg.innerHTML = `🔒 Alex’s songs unlock as you play through <b>Liminality</b>, a rhythm game Alex made.<button>🎮 Play it</button>`;
        msg.querySelector('button').onclick = (ev) => { ev.stopPropagation(); playLiminality(); };
        msg.scrollIntoView({ block: 'nearest' });
        return;
      }
      b.querySelector('span').insertAdjacentHTML('beforeend', ' · loading…');
      if (b.dataset.a) await playTrack({ kind: 'a', id: b.dataset.a });
      else if (b.dataset.g != null) await playTrack({ kind: 'g', i: +b.dataset.g });
      else await playTrack({ kind: 'w', i: +b.dataset.w });
      phoneTab('music');
    };
  } else if (!chat) {
    body.innerHTML = '<div class="pa-list">' + Object.entries(CHATS).map(([id, c]) => {
      const last = chatLog[id].length ? chatLog[id][chatLog[id].length - 1][1] : c.msgs[c.msgs.length - 1][1];
      const unread = !chatLog[id].length;
      return `<button data-c="${id}"><img src="${c.img}" alt=""><span><b>${c.name}</b>${last.replace(/<[^>]+>/g, '')}</span>${unread ? '<em></em>' : ''}</button>`;
    }).join('') + '</div>';
    body.querySelector('.pa-list').onclick = (e) => { const b = e.target.closest('button'); if (b) phoneTab('messages', b.dataset.c); };
  } else {
    const C = CHATS[chat];
    const all = C.msgs.concat(chatLog[chat]);
    body.innerHTML = `<div class="pa-chathead"><button class="pa-back">‹</button><img src="${C.img}" alt=""><b>${C.name}</b></div>
      <div class="pa-thread">${all.map(([d, t]) => `<div class="pa-msg ${d}">${t}</div>`).join('')}</div>
      <div class="pa-replies">${chatLog[chat].length ? '' : C.replies().map(([k, t]) => `<button data-k="${k}">${t}</button>`).join('')}</div>`;
    body.querySelector('.pa-back').onclick = () => phoneTab('messages');
    const th = body.querySelector('.pa-thread'); th.scrollTop = th.scrollHeight;
    body.querySelector('.pa-replies').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      chatLog[chat].push(['out', b.textContent]);
      if (b.dataset.k === 'song' || b.dataset.k === 'workout') { pose('startle', 0.15); later(() => pose('sit', 0.4), 500); anim.sing = { t0: performance.now() / 1000 - 0.01, line: b.textContent, dance: (SINGALONG[HOTLINE.id] || SINGALONG.hotline).dance }; }
      else think('😄', 'good', 1500);
      phoneTab('messages', chat);
      setTimeout(() => { chatLog[chat].push(['in', '<span class="pa-typing">•••</span>']); phoneTab('messages', chat); }, 600);
      setTimeout(() => { chatLog[chat].pop(); chatLog[chat].push(['in', C.answer[b.dataset.k]]); if (!$('#phoneapp').hidden) phoneTab('messages', chat); sfx.tone(1320, 1760, 0.12, 0.05); }, 1800);
    };
  }
}
$('#phoneapp').addEventListener('click', (e) => {
  if (e.target.id === 'phoneapp' || e.target.closest('.pa-close')) { $('#phoneapp').hidden = true; return; }
  const t = e.target.closest('.pa-tabs button'); if (t) phoneTab(t.dataset.tab);
});

// back to the website, with a fade; `finished` lets the homepage play a little joke
function goHome(finished = false) {
  const btn = document.getElementById('homebtn');
  try { if (finished) sessionStorage.setItem('aw-story-done', '1'); } catch (e) {}
  if (btn) btn.click(); else location.href = 'https://ayw0.github.io/';
}

// Runs the chapters in order; a click on the chapter bar jumps to any of them.
let started = false, jumpTarget = 0;
const HOME_SPOT = { p: room.person.root.position.clone(), r: room.person.root.rotation.y };
async function resetFor(n) {
  lastTitle = -1;
  clearInterval(typing); typing = null; box.classList.remove('talking'); histLeave(); histUI(); actsEl.replaceChildren(); textEl.innerHTML = '';
  jumpFlashes.length = 0;
  skip.queue = []; skip.paused = {};
  engine.dismiss(); ringing = null; countdown = null; bigCount(null); stopClip();
  for (const v of voiceSrcs.splice(0)) { try { v.stop(); } catch {} } riseStop(); skipStop(); rise.adapt = false;
  hideViz(); setReplay(null); clearLabels(); unthink(); setLoading('');
  $('#outro').hidden = true; $('#lightbox').hidden = true; $('#phonecut').hidden = true; $('#questions').hidden = true; $('#phoneapp').hidden = true; unlabel('phonehint');
  Object.assign(anim, { working: false, free: false, quit: null, ph: null, groove: false, onCalm: null, walk: null });
  rackBar();
  room.phone.position.set(0.2, 0.452, 0.04); room.phone.rotation.set(0, 0.35, 0);
  // David is on the couch at home and during calls, at the mat for the workout and the lyrics
  const atMat = n === 3;
  room.person.root.position.copy(atMat ? new THREE.Vector3(1.65, 0, 0.55) : HOME_SPOT.p);
  room.person.root.rotation.y = atMat ? 0.25 : HOME_SPOT.r;
  pose(atMat ? 'stand' : 'sit', 0.3);
  // music: the story's song plays from the calls through the workout; the lyrics chapter is quiet
  if (n === 0) { engine.stop(); return; }
  if (!engine.song) { setLoading('Loading…'); try { await loadHome(); } catch (e) { console.error(e); } setLoading(''); }
  if (n === 4) engine.stop(); else if (!engine.playing) engine.play();
}
async function story(start) {
  started = true;
  let c = start;
  while (c < CH.length) {
    try { await CH[c](); c++; }
    catch (e) {
      if (!(e instanceof Jump)) throw e;
      c = jumpTarget;
      await resetFor(c);
    }
  }
}
function jumpTo(n) {
  if (!started) return;
  jumpTarget = n; epoch++; chapterJumped = true;
  for (const cancel of [...live]) cancel();
  live.clear();
}
document.querySelectorAll('.chapters li').forEach((li, i) => {
  li.tabIndex = 0; li.setAttribute('role', 'button');
  li.addEventListener('click', () => jumpTo(i));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); jumpTo(i); } });
});

// music particles: notes float up from the speakers on the beat, and sound waves ripple out
const fx = (() => {
  const mk = (ch, col) => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.font = '700 52px serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(ch, 32, 34); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const tex = [mk('♪', '#22305a'), mk('♫', '#22305a'), mk('♪', '#ff5a6e'), mk('♫', '#2f6fde')];
  const items = [];
  let lastBeat = -1;
  return {
    update(dt, on, beatPos, pump) {
      const b = Math.floor(beatPos);
      if (on && b !== lastBeat && room.speakers.every((sp) => sp.visible)) {
        lastBeat = b;
        room.speakers.forEach((sp, i) => {
          if (buff.ripped && anim.working) return;
          const base = sp.position;
          if (b % 2 === i % 2) {
            const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex[(b + i) % tex.length], transparent: true, depthWrite: false }));
            m.position.set(base.x + (Math.random() - 0.5) * 0.2, 1.2, base.z + 0.2); m.scale.setScalar(0.16);
            room.scene.add(m); items.push({ o: m, kind: 'note', age: 0, life: 2.2, vx: (Math.random() - 0.5) * 0.18, ph: Math.random() * 6 });
          }
          const ring = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.125, 40), new THREE.MeshBasicMaterial({ color: 0x22305a, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
          ring.position.set(base.x, 0.62, base.z + 0.18);
          room.scene.add(ring); items.push({ o: ring, kind: 'wave', age: 0, life: 0.7 });
        });
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]; it.age += dt; const k = it.age / it.life;
        if (k >= 1) { room.scene.remove(it.o); it.o.material.dispose(); if (it.o.geometry) it.o.geometry.dispose(); items.splice(i, 1); continue; }
        if (it.kind === 'note') {
          it.o.position.y += dt * 0.35; it.o.position.x += it.vx * dt + Math.sin(it.age * 3 + it.ph) * dt * 0.08;
          it.o.material.opacity = Math.min(1, it.age * 5) * (1 - k); it.o.material.rotation = Math.sin(it.age * 2.5 + it.ph) * 0.35;
          it.o.scale.setScalar(0.12 + 0.08 * Math.min(1, it.age * 3));
        } else { it.o.scale.setScalar(1 + k * 2.6); it.o.material.opacity = 0.5 * (1 - k); }
      }
    },
  };
})();

// A jolt: one short screen shake, and David leaps off the couch, arms up, then drops back down.
function startle(k = 1) {
  room.shake = 0.9 * k;
  anim.hop = { t0: performance.now() / 1000, k };
  pose('startle', 0.12);
  flashLabel('jolt', at(room.person.neck, 0.1, 0.55, 0), '<b>!!</b>', 900);
  later(() => pose('sit', 0.5), 750);
}

// the same countdown, big in the middle of the screen: 4 3 2 1, then a ringing phone
let bigShown = undefined;
function bigCount(n) {
  if (n === bigShown) return;
  bigShown = n;
  const el = $('#bigcount');
  if (n == null) { el.classList.remove('on'); return; }
  el.innerHTML = n === 'ring' ? '<span class="bc-ring"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg></span><span class="bc-cap">Ringing, in time with the song</span>'
    : `<span class="bc-cap">Ringtone in</span><span class="bc-n">${n}</span>`;
  el.classList.remove('on', 'pop'); void el.offsetWidth; el.classList.add('on', 'pop');
  if (n === 'ring') setTimeout(() => { if (bigShown === 'ring') bigCount(null); }, 1800);
}

// what David sings along with (song titles and humming), and how he dances to each
const SINGALONG = {
  hotline: { dance: 'hotline', lines: ['♪ You used to call me on my cell phone… ♪', '♪ (hums along) ♪', '♪ You used to call me on my cell phone… ♪'] },
  nothing: { dance: 'smooth', lines: ['♪ Nothin’ on youuu ♪', '♪ (hums along) ♪', '♪ ooh-ooh ♪'] },
  whatislove: { dance: 'roxbury', lines: ['♪ What is love?! ♪', '♪ da-da-da-da ♪', '♪ (head bob intensifies) ♪'] },
};

// ---------------------------------------------------------------- per frame
let ringing = null;
let last = performance.now();
const tip = $('#tip');
// click a poster on the wall to read it
let downAt = null;
$('#scene').addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
$('#scene').addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hv = room.hoverTarget();
  // at the end the speakers and David's phone share one queue: a click goes to the next track
  if (hv && hv.userData.hover === 'speaker') { if (curChapter === 5 && $('#limgame').hidden) speakerNext(); else swapSong(); return; }
  if (hv && hv.userData.hover === 'phone' && curChapter === 5) { openPhoneApp(); return; }
  if (hv && hv.userData.hover === 'drawer') { const d = room.drawer.userData; d.target = d.target ? 0 : 1; sfx.tone(220, 160, 0.18, 0.04, 'triangle'); return; }
  if (hv && hv.userData.hover === 'namecard') { $('#profile').hidden = false; return; }
  if (!hv || !['poster', 'drake'].includes(hv.userData.hover)) return;
  openPoster(hv);
});
function openPoster(hv) {
  const i = hv.userData.info, lb = $('#lightbox');
  lb.querySelector('img').src = hv.userData.hover === 'poster' ? `img/story/poster-${i.id}.png` : 'img/story/drake.png';
  const a = lb.querySelector('a.lb-demo'), pp = lb.querySelector('a.lb-paper');
  a.hidden = !i.href; if (i.href) { a.href = i.href; a.textContent = `Try the ${i.title.split(':')[0]} demo ▸`; }
  pp.hidden = !i.paper; if (i.paper) pp.href = i.paper;
  lb.hidden = false;
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const t = now / 1000;
  if (engine.ctx && engine.song) engine.tick();
  riseStep();

  // speakers pulse with the music
  let level = 0;
  if (rise.active) { rise.analyser.getFloatTimeDomainData(rise.abuf); let s = 0; for (const v of rise.abuf) s += v * v; level = Math.sqrt(s / rise.abuf.length) * 3; }
  else if (engine.playing) level = engine.rms * 3;
  const skP = skip.play ? skipPos() : null;
  const LEAD = 0.07; // seconds: motion peaks land on the beat instead of just after it
  const beatPos = anim.free ? t / 0.5 : skP != null ? (skP + LEAD) / skip.beatDur : rise.active ? (risePos() + LEAD) / rise.beatDur : engine.playing ? (engine.time + LEAD) / engine.song.analysis.beatDur : 0;
  const musicOn = !!(engine.playing || rise.active || skP != null || anim.free);
  if (skP != null) level = Math.max(level, 0.35);
  const pulse = Math.pow(1 - (beatPos % 1), 3);
  const pump = musicOn ? Math.min(1, 0.35 + level) * pulse : 0;
  for (const sp of room.speakers) {
    for (const c of sp.userData.cones) c.ring.scale.setScalar(1 + 0.28 * pump);
    if (!(buff.ripped && anim.working)) sp.scale.set(1 - 0.05 * pump, 1 + 0.09 * pump, 1 - 0.05 * pump);
  }
  fx.update(dt, musicOn, beatPos, pump);
  // countdown to an adapted ringtone, on the beat, then the pulsing call icon once it rings
  if (countdown && engine.ring === countdown && engine.song) {
    const A = engine.song.analysis, now = engine.time;
    if (now < countdown.t0 - 0.03) {
      let nb = 0; for (let b = countdown.start.beat; b > 0 && A.beats[b] > now + 0.11; b--) nb++;
      nb = Math.max(1, nb);
      const html = nb <= 4 ? `<span class="cd last" data-n="${nb}">ringtone in <b>${nb}</b></span>` : '<span class="cd">📞 ringtone incoming…</span>';
      if (labels.get('countdown')?.html !== html) label('countdown', at(room.phone, 0, 0.62, 0), html, 'cdtag');
      bigCount(nb <= 4 ? nb : null);
    } else {
      countdown = null; unlabel('countdown'); bigCount('ring');
      label('callcue', at(room.phone, 0.2, 0.22, 0), '<span class="cc"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg></span>', 'callcue');
    }
  } else if (countdown) { countdown = null; unlabel('countdown'); bigCount(null); }
  const cc = labels.get('callcue'); if (cc) cc.el.style.setProperty('--p', musicOn ? pulse.toFixed(3) : (0.5 + 0.5 * Math.sin(t * 6)).toFixed(3));

  // phone buzz / glow
  const scr = room.phone.userData.screen.material.uniforms;
  scr.uGlow.value = ringing ? 0.5 + 0.5 * Math.sin(t * (ringing === 'jarring' ? 18 : 6)) : anim.phoneGlow ? 0.6 + 0.4 * Math.sin(t * 5) : 0;
  if (!anim.ph || (anim.ph.k === 0 && anim.ph.to === 0)) room.phone.position.x = 0.2 + (ringing === 'jarring' ? Math.sin(t * 70) * 0.004 : 0);
  if (engine.ring == null && ringing === 'jarring') { ringing = null; unlabel('call'); }

  // person: walking, posing, nodding, squatting on the beat
  if (anim.walk) {
    const w = anim.walk; w.t = Math.min(1, w.t + dt / w.dur);
    const e = w.t < 0.5 ? 2 * w.t * w.t : 1 - Math.pow(-2 * w.t + 2, 2) / 2;
    room.person.root.position.lerpVectors(w.from, w.to, e);
    room.person.root.rotation.y = w.r0 + (w.r1 - w.r0) * e;
    if (w.t >= 1) anim.walk = null;
  }
  anim.t = Math.min(1, anim.t + dt / anim.dur);
  const e = 1 - Math.pow(1 - anim.t, 3);
  let p = mixPose(anim.from, POSES[anim.pose], e);
  if (anim.working && (anim.barMode || anim.quit)) { anim.barMode = null; anim.quit = null; }
  if (anim.working && anim.t >= 1) {
    // one squat per 4 beats (half time on fast songs), down then up, on the beat
    const per = anim.free ? 4 : rise.beatDur * 4 < 2 ? 8 : 4;
    const ph = (beatPos / per) % 1;
    const d = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
    p = buff.ripped ? mixPose(POSES.carry, POSES.carrySquat, d) : mixPose(POSES.rack, POSES.squat, d);
    const rep = Math.floor(beatPos / per);
    if (rep !== anim.lastRep) { anim.lastRep = rep; anim.reps++; if (anim.reps > 1) { flashLabel('rep', at(room.person.neck, 0, 0.45, 0), `${anim.reps - 1}!`, 700); onRep(anim.reps - 1); } }
    const hi = anim.free || riseSeg(risePos()).high;
    if (!hi && !rise.adapt && !anim.free) {
      // the drop is over: David stalls, lowers the bar, drops it and slumps
      anim.working = false; anim.quit = { t0: t, stage: 0 };
      pose('rack', 0.3);
      flashLabel('huh', at(room.person.neck, 0, 0.55, 0), '…huh?', 1400);
    }
    if (!anim.free) label('energy', at(room.person.hips, 0.55, 0.2, 0), hi ? '<i>music</i> 🔥 HIGH ENERGY' : '<i>music</i> 〰 calm', hi ? 'chip hot' : 'chip cold');
  } else if (labels.has('energy') && !anim.working) unlabel('energy');
  // head bob: a smooth dip a little after each beat, eased so it never snaps
  const ph = (beatPos % 1 + 1) % 1, nodT = musicOn && anim.t >= 1 && !anim.working && !anim.quit && !anim.hop ? 0.5 + 0.5 * Math.cos(2 * Math.PI * ph) : 0;
  anim.nod = (anim.nod || 0) + (nodT - (anim.nod || 0)) * Math.min(1, dt * 30);
  if (anim.pose === 'sit' || anim.pose === 'stand') p = { ...p, neck: p.neck + 0.06 * anim.nod - 0.02 * (musicOn ? 1 : 0), torso: p.torso + (anim.pose === 'stand' ? 0.025 : 0.015) * anim.nod, y: p.y - (anim.pose === 'stand' ? 0.012 * anim.nod : 0) };
  if (anim.groove && anim.pose === 'sit' && anim.t >= 1) {
    // groove on the beat: deeper nod, shoulders bounce, arms swing
    const sw = Math.sin(Math.PI * beatPos);
    p = { ...p, neck: p.neck + 0.1 * anim.nod, torso: p.torso + 0.04 * anim.nod, lEl: [p.lEl[0] - 0.22 * (0.5 + 0.5 * sw), p.lEl[1], p.lEl[2]], rEl: [p.rEl[0] - 0.22 * (0.5 - 0.5 * sw), p.rEl[1], p.rEl[2]] };
  }
  // singing along: while a home song plays and nothing else is going on, David sings along now and
  // then, each song with its own little dance
  {
    const busy = !engine.playing || rise.active || skip.play || ringing || engine.ring || vz.notif || anim.working || anim.quit || anim.walk || anim.ph || anim.hop || anim.idle || labels.has('thought') || !$('#phonecut').hidden;
    const sa = anim.sing;
    anim.singTilt = 0;
    if (busy) { if (sa) { anim.sing = null; unlabel('sing'); } }
    else if (!sa && t > (anim.nextSing || 6)) {
      const S = SINGALONG[HOTLINE.id] || SINGALONG.hotline;
      anim.sing = { t0: t, line: S.lines[(anim.singN = ((anim.singN || 0) + 1)) % S.lines.length], dance: S.dance };
    } else if (sa) {
      const el = t - sa.t0, beatOn = Math.pow(1 - (beatPos % 1), 2);
      if (el < 4.5) {
        if (!labels.has('sing')) label('sing', at(room.person.neck, 0.12, 0.55, 0), `<span class="singl">${sa.line}</span>`, 'singtag');
        const e = Math.min(1, el / 0.4) * Math.min(1, (4.5 - el) / 0.4);
        if (sa.dance === 'roxbury') {
          // the side-to-side head bob, on every beat
          const side = Math.floor(beatPos) % 2 ? 1 : -1;
          p = { ...p, neck: p.neck + 0.05 * e };
          anim.singTilt = side * 0.3 * e * (0.4 + 0.6 * beatOn);
        } else if (sa.dance === 'hotline') {
          // one hand up, waving side to side, a little sway
          const w = Math.sin(beatPos * Math.PI) * e;
          p = { ...p, rSh: [p.rSh[0] - 1.2 * e, p.rSh[1], p.rSh[2] - 0.5 * w], rEl: [p.rEl[0] - 0.6 * e, p.rEl[1], p.rEl[2]], torso: p.torso + 0.04 * w };
        } else {
          // smooth shoulder rolls and a finger point on the beat
          const r = Math.sin(beatPos * Math.PI * 2) * e;
          p = { ...p, lSh: [p.lSh[0] - 0.25 * Math.max(0, r), p.lSh[1], p.lSh[2]], rSh: [p.rSh[0] - 0.25 * Math.max(0, -r) - 0.6 * e, p.rSh[1], p.rSh[2]], rEl: [p.rEl[0] - 0.9 * e, p.rEl[1], p.rEl[2]], neck: p.neck + 0.06 * beatOn * e };
        }
      } else { anim.sing = null; unlabel('sing'); anim.nextSing = t + 14 + Math.random() * 8; }
    }
  }
  // idle: the reader has sat on the same line for a while, so David entertains himself
  {
    const idle = performance.now() - lastActivity;
    const free = anim.t >= 1 && !anim.working && !anim.quit && !anim.walk && !anim.ph && !anim.hop && (anim.pose === 'sit' || anim.pose === 'stand') && !typing && actsEl.children.length;
    if (!free || idle < 20000) { if (anim.idle) { anim.idle = null; } }
    else {
      if (!anim.idle) {
        const opts = ['drum', 'stretch'].concat(anim.pose === 'sit' ? ['phone'] : []);
        anim.idle = { kind: opts[Math.floor(Math.random() * opts.length)], t0: t };
        const say = { drum: 'Ba-dum-tss 🥁', stretch: 'Mmmh… 🥱', phone: '📱 …' }[anim.idle.kind];
        think(say, 'good', 2200);
      }
      const ii = anim.idle, e = Math.min(1, (t - ii.t0) / 0.6);
      if (ii.kind === 'drum') {
        // air drums on the beat: forearms up, hands alternate
        const hit = Math.pow(1 - (beatPos * 2 % 1), 2);
        p = { ...p, lSh: [p.lSh[0] - 0.5 * e, p.lSh[1], p.lSh[2]], rSh: [p.rSh[0] - 0.5 * e, p.rSh[1], p.rSh[2]],
          lEl: [p.lEl[0] - (0.6 + 0.6 * (Math.floor(beatPos * 2) % 2 ? hit : 0)) * e, p.lEl[1], p.lEl[2]], rEl: [p.rEl[0] - (0.6 + 0.6 * (Math.floor(beatPos * 2) % 2 ? 0 : hit)) * e, p.rEl[1], p.rEl[2]], neck: p.neck + 0.08 * hit * e };
      } else if (ii.kind === 'stretch') {
        // arms up overhead, lean back, hold, then repeat every few seconds
        const c = 0.5 - 0.5 * Math.cos(Math.min(1, ((t - ii.t0) % 6) / 2.5) * Math.PI * 2) ;
        p = { ...p, lSh: [p.lSh[0] - 2.7 * c, p.lSh[1], p.lSh[2] - 0.2 * c], rSh: [p.rSh[0] - 2.7 * c, p.rSh[1], p.rSh[2] + 0.2 * c], lEl: [p.lEl[0] * (1 - c), p.lEl[1], p.lEl[2]], rEl: [p.rEl[0] * (1 - c), p.rEl[1], p.rEl[2]], torso: p.torso - 0.18 * c, neck: p.neck - 0.25 * c };
      } else if (ii.kind === 'phone') {
        // head down, scrolling something on his lap
        const sc = Math.sin(t * 3) * 0.05;
        p = { ...p, neck: p.neck + 0.45 * e, lSh: [p.lSh[0] - 0.5 * e, p.lSh[1], p.lSh[2] + 0.25 * e], rSh: [p.rSh[0] - 0.5 * e, p.rSh[1], p.rSh[2] - 0.25 * e], lEl: [-1.6 * e + p.lEl[0] * (1 - e), p.lEl[1], p.lEl[2]], rEl: [(-1.6 + sc) * e + p.rEl[0] * (1 - e), p.rEl[1], p.rEl[2]] };
      }
    }
  }
  if (anim.quit) {
    const q = anim.quit, el = t - q.t0;
    if (q.stage === 0 && el > 0.9) { q.stage = 1; pose('lower', 0.8); anim.barMode = 'hands'; }
    if (q.stage === 1 && el > 1.8) { q.stage = 2; anim.barMode = 'drop'; anim.barV = 0; room.shake = 0.25; }
    if (q.stage === 2 && el > 2.2) { q.stage = 3; pose('slump', 1.1); room.shake = 0.7; flashLabel('clank', at(room.bar, 0, 0.35, 0), '<b>CLANK</b>', 1100); }
    if (q.stage === 3 && el > 3.0) { q.stage = 4; think('Ugh. Where did the energy go?! 😤', 'bad'); }
    if (q.stage === 4 && el > 4.2) { q.stage = 5; flashLabel('sigh', at(room.person.neck, 0.25, 0.45, 0), '<i>sigh…</i> 😮‍💨', 1800); if (anim.onCalm) { const f = anim.onCalm; anim.onCalm = null; f(); } }
    // discouraged: a slow head shake while he stands there
    if (q.stage >= 3 && anim.pose === 'slump') p = { ...p, neck: p.neck + 0.05 * Math.sin(t * 1.3) };
  }
  if (anim.hop) {
    // the leap: up fast, a little hang, back down onto the cushion
    const u = (t - anim.hop.t0) / 0.75;
    if (u >= 1) anim.hop = null;
    else { const h = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8; p = { ...p, y: p.y + 0.42 * anim.hop.k * Math.max(0, h) }; }
  }
  room.pose = p;
  room.applyPose(p);
  if (anim.ph) {
    // the phone travels between the coffee table and David's hands
    const ph = anim.ph, sp = dt / 0.55;
    ph.k = ph.to > ph.k ? Math.min(ph.to, ph.k + sp) : Math.max(ph.to, ph.k - sp);
    const e2 = ph.k * ph.k * (3 - 2 * ph.k), par = room.phone.parent;
    room.person.root.updateMatrixWorld(true);
    const a = room.person.hands[0].getWorldPosition(new THREE.Vector3()), b = room.person.hands[1].getWorldPosition(new THREE.Vector3());
    const hand = par.worldToLocal(ph.both ? a.add(b).multiplyScalar(0.5) : b);
    room.phone.position.set(0.2, 0.452, 0.04).lerp(hand, e2);
    room.phone.rotation.set(-1.25 * e2 * (ph.both ? 1 : 0.4), 0.35 + (room.person.root.rotation.y - par.rotation.y - 0.35) * e2, 0);
  }
  const sway = musicOn && anim.pose === 'sit' && !anim.working ? Math.sin(beatPos * Math.PI) * (anim.groove ? 0.07 : 0.025) : 0;
  room.person.torso.rotation.z += (sway - room.person.torso.rotation.z) * 0.3;
  room.person.neck.rotation.z += (-sway * 0.9 + (anim.singTilt || 0) - room.person.neck.rotation.z) * Math.min(1, dt * 14);
  const speakerLift = buff.ripped && anim.working;
  if (speakerLift) {
    // muscle mode: the barbell is too light, so David squats holding a speaker in each hand
    rackBar();
    room.person.hips.updateMatrixWorld(true);
    room.speakers.forEach((sp, i) => {
      const hand = room.person.hands[i].getWorldPosition(new THREE.Vector3());
      // farmer's carry: each speaker hangs from a hand by its top edge
      sp.position.set(hand.x, hand.y - 1.1, hand.z);
      sp.rotation.y = room.person.root.rotation.y;
    });
  } else {
    for (const sp of room.speakers) { sp.position.lerp(sp.userData.home, 0.15); sp.rotation.y *= 0.85; }
    if (anim.barMode === 'hands') {
      // the bar travels with his hands as he lowers it
      const a = room.person.hands[0].getWorldPosition(new THREE.Vector3()), b = room.person.hands[1].getWorldPosition(new THREE.Vector3());
      room.bar.position.copy(a.add(b).multiplyScalar(0.5)); room.bar.rotation.y = room.person.root.rotation.y;
    } else if (anim.barMode === 'drop') {
      // let go: it falls, bounces once and settles on the floor
      anim.barV -= 9.8 * dt; room.bar.position.y += anim.barV * dt;
      if (room.bar.position.y < 0.17) { room.bar.position.y = 0.17; anim.barV = Math.abs(anim.barV) > 1 ? -anim.barV * 0.3 : 0; if (!anim.barV) anim.barMode = 'floor'; }
    } else if (anim.barMode === 'floor') {
      // stays where he dropped it
    } else if (anim.working || anim.pose === 'rack' || anim.pose === 'squat') {
      // bar rides on the shoulders
      const sh = room.person.torso.localToWorld(new THREE.Vector3(0, 0.47, -0.2));
      room.bar.position.copy(sh); room.bar.rotation.y = room.person.root.rotation.y;
    }
  }
  { const d = room.drawer.userData; d.open += (d.target - d.open) * Math.min(1, dt * 7); room.drawer.position.x = 0.36 * d.open;
 }
  runJumpFlashes();
  { const h = room.phone.userData.halo; if (h) { const o = anim.phoneGlow ? 0.55 + 0.45 * Math.sin(t * 5) : 0; h.material.opacity += (o - h.material.opacity) * 0.2; h.visible = h.material.opacity > 0.01; } }
  if (!anim.ph) { const k = anim.phoneGlow ? 1 + 0.18 * (0.5 + 0.5 * Math.sin(t * 6)) : 1; room.phone.scale.setScalar(room.phone.scale.x + (k - room.phone.scale.x) * 0.2); }
  musicTick();
  if (document.body.classList.contains('lim-on') && $('#limgame').hidden) document.body.classList.remove('lim-on');
  for (const b of document.querySelectorAll('.sk-play')) { const on = !!(skip.play && skip.play.lane === +b.dataset.lane && !skip.play.fading); if (b.classList.contains('on') !== on) b.classList.toggle('on', on); }
  room.updateShards(dt);

  room.frame(dt, t);

  if (vz.kind === 'mir' && engine.song) {
    const root = MAJOR_MAP[HOTLINE.key - 1];
    mir.draw({ song: engine.song, t: engine.time, keyName: `${KEY_MAJOR[HOTLINE.key - 1]} major · ${KEY_MINOR[HOTLINE.key - 1]}`, scale: [0, 2, 4, 5, 7, 9, 11].map((i) => (root + i) % 12) });
  } else if (vz.kind === 'timeline' && engine.song) tl.draw({ song: engine.song, t: engine.time, ring: engine.ring, preview: null, accent: '#ff9f5a', level: engine.ringLevel(), note: engine.ring && engine.ring.params && engine.ring.params.beatMatch ? '⏳ Delayed to the next phrase' : null });
  else if (vz.kind === 'roll' && engine.song) roll.draw(engine.song, mel, engine.time, vz.notif && engine.time < vz.notif.t1 + 1.5 ? vz.notif : null, '#e0479e', Math.min(0.6, level));
  else if (vz.kind === 'skip' && skip.buf) {
    const pos = skipPos();
    if (skip.play && pos != null) {
      const hi = pos >= skip.hiAt;
      // as written: the calm part drags on, so David gets bored and keeps checking his watch
      if (skip.play.lane === 0 && !hi) {
        const w = pos - SKIP.from, b = skip.play.bored || (skip.play.bored = { step: 0 });
        if (b.step === 0 && w > 1.5) { b.step = 1; pose('watch', 0.5); label('bored', at(room.person.neck, 0.15, 0.6, 0), 'How long until the drop?? ⌚', 'speech'); }
        if (b.step === 1 && w > 6) { b.step = 2; pose('stand', 0.5); unlabel('bored'); }
        if (b.step === 2 && w > 9) { b.step = 3; pose('watch', 0.4); label('bored', at(room.person.neck, 0.15, 0.6, 0), 'Come ON… 🥱', 'speech'); }
        if (b.step === 3 && w > 14) { b.step = 4; pose('frustrated', 0.6); label('bored', at(room.person.neck, 0.15, 0.6, 0), 'I’m losing my pump here 😩', 'speech'); }
        if (b.step === 4 && w > 18) { b.step = 5; pose('watch', 0.4); label('bored', at(room.person.neck, 0.15, 0.6, 0), 'Seriously, where’s the drop?!', 'speech'); }
      } else if (labels.has('bored')) unlabel('bored');
      if (hi && !anim.working) { anim.free = true; anim.working = true; anim.reps = 0; pose('rack', 0.4); if (!skip.play.cheered) { skip.play.cheered = true; think(skip.play.lane ? 'There it is! 🔥' : 'Finally… 😮‍💨', skip.play.lane ? 'good' : 'bad', 2400); } }
      if (pos > skip.hiAt + 4 && !skip.play.fading) { skip.play.fading = true; const lane = skip.play; skipStop(3); skip.play = lane; setTimeout(() => { if (skip.play === lane) { skip.play = null; anim.free = false; anim.working = false; pose('stand', 0.5); rackBar(); skipEnded(); } }, 3000); }
    }
    figs.skip.draw(t, { segs: skip.segs, from: SKIP.from - 2, to: SKIP.to, cut: skip.cut, hiAt: skip.hiAt, play: skip.play, pos: skipPos(), start: SKIP.from });
  }
  else if (vz.kind === 'cutplay' && skip.drop) {
    const pos = skip.play && skip.play.lane >= 2 ? skipPos() : null;
    if (pos != null) {
      if (!anim.working) { anim.free = true; anim.working = true; anim.reps = 0; pose('rack', 0.4); }
      if (engine.ctx.currentTime > skip.play.jumpAt + 2.5 && !skip.play.fading) { skip.play.fading = true; const lane = skip.play; skipStop(3); skip.play = lane; setTimeout(() => { if (skip.play === lane) { skip.play = null; anim.free = false; anim.working = false; pose('stand', 0.5); rackBar(); skipEnded(); } }, 3000); }
    }
    figs.cutplay.draw(t, { drop: skip.drop, play: skip.play && skip.play.lane >= 2 ? skip.play : null, pos, jumped: !!(skip.play && engine.ctx.currentTime >= skip.play.jumpAt) });
  }
  else if (vz.kind === 'mv') mv.draw(t);
  else if (figs[vz.kind] && vz.kind !== 'skip' && vz.kind !== 'cutplay') figs[vz.kind].draw(t);
  else if (vz.kind === 'rise' && rise.buf) {
    const pos = rise.active ? risePos() : rise.lastPos || 0;
    if (rise.active) rise.lastPos = pos;
    const ch = rise.segs.find((x) => x.high);
    // only the loop in use: the one coming up, else the last one taken, else the hand-picked one
    const curLoop = rise.adapt ? rise.upcoming || rise.jumps[rise.jumps.length - 1] || rise.choice : null;
    track.draw({ segs: rise.segs, beats: rise.beats, pos, from: Math.min(ch.end - 22, (rise.choice ? rise.choice.dest : ch.end) - 4), to: ch.end + 8, loop: curLoop, upcoming: rise.upcoming && curLoop && rise.upcoming.orig === curLoop.orig && rise.upcoming.dest === curLoop.dest ? rise.upcoming : null, jumps: [], working: anim.working, alert: !rise.adapt && anim.working && !riseSeg(pos).high, now: t });
  }

  // hover: speakers show what is playing
  const hv = room.hoverTarget();
  $('#scene').classList.toggle('pointing', !!hv);
  for (const f of room.frames) { const on = hv === f ? 1 : paperHi && f === room.posterFrames[paperHi] ? 2.2 + 0.4 * Math.sin(t * 5) : 0; f.userData.lift = (f.userData.lift || 0) + (on - (f.userData.lift || 0)) * 0.2; f.userData.pic.position.z = 0.022 + f.userData.lift * 0.03; f.scale.setScalar(1 + f.userData.lift * 0.04); }

  if (hv && hv.userData.hover === 'speaker' && (engine.song || rise.buf || alexAudio)) {
    // at the end, the speakers show whatever David's phone is playing (including Alex's songs)
    const m = curChapter === 5 ? musicNow : null, tp = m && trackPos();
    if (m && tp) {
      const t = m.kind === 'a' ? { title: LIM_SONGS[m.id].title, artist: 'Alexander Wang' } : m.kind === 'w' ? WORKOUT[m.i] : PLAYLIST[m.i].s;
      tip.innerHTML = `<div class="t-k">${tp.playing ? '▶ Now playing' : '❚❚ Paused'}</div><div class="t-t">${t.title}</div><div class="t-a">${t.artist}</div>
      <div class="t-m"><span>${fmt(tp.pos)} / ${fmt(tp.dur)}</span></div>
      <div class="t-bar"><i style="width:${(100 * tp.pos) / tp.dur}%"></i></div><div class="t-a">Click for the next song</div>`;
    } else {
    const isRise = rise.active, title = isRise ? rise.meta.title : HOTLINE.title, artist = isRise ? rise.meta.artist : HOTLINE.artist;
    const bpm = isRise ? Math.round(60 / rise.beatDur) : Math.round(HOTLINE.bpm);
    const pos = isRise ? risePos() : engine.time, dur = isRise ? rise.buf.duration : engine.song.duration;
    const playing = isRise || engine.playing;
    tip.innerHTML = `<div class="t-k">${playing ? '▶ Now playing' : '❚❚ Paused'}</div><div class="t-t">${title}</div><div class="t-a">${artist}</div>
      <div class="t-m"><span>${bpm} BPM</span>${isRise ? '' : `<span>${KEY_MAJOR[HOTLINE.key - 1]} major</span>`}<span>${fmt(pos)} / ${fmt(dur)}</span></div>
      <div class="t-bar"><i style="width:${(100 * pos) / dur}%"></i></div>${!isRise && [0, 1, 2, 5].includes(curChapter) ? '<div class="t-a">Click to change the song</div>' : ''}`;
    }
    tip.style.left = `${room.pointer.x + 18}px`; tip.style.top = `${room.pointer.y + 12}px`;
    tip.hidden = false;
  } else if (hv && hv.userData.hover === 'poster') {
    const i = hv.userData.info;
    tip.innerHTML = `<div class="t-k">${i.venue}</div><div class="t-t">${i.title}</div><div class="t-a">Click to read the poster</div>`;
    tip.style.left = `${room.pointer.x + 18}px`; tip.style.top = `${room.pointer.y + 12}px`; tip.hidden = false;
  } else if (hv && (hv.userData.hover === 'drawer' || hv.userData.hover === 'namecard')) {
    tip.innerHTML = hv.userData.hover === 'drawer' ? `<div class="t-k">Drawer</div><div class="t-t">${room.drawer.userData.target ? 'Close it' : 'Open it'}</div>` : '<div class="t-k">Name card</div><div class="t-t">Alex Wang</div><div class="t-a">Click to read</div>';
    tip.style.left = `${room.pointer.x + 18}px`; tip.style.top = `${room.pointer.y + 12}px`; tip.hidden = false;
  } else if (hv && hv.userData.hover === 'drake') {
    tip.innerHTML = `<div class="t-k">${hv.userData.info.sub}</div><div class="t-t">${hv.userData.info.title}</div>`;
    tip.style.left = `${room.pointer.x + 18}px`; tip.style.top = `${room.pointer.y + 12}px`; tip.hidden = false;
  } else if (hv && hv.userData.hover === 'phone') {
    tip.innerHTML = `<div class="t-call"><img src="img/story/chris.jpg" alt=""><div><div class="t-k">${ringing ? 'Incoming call' : 'Recent call'}</div><div class="t-t">Chris Donahue</div></div></div>`;
    tip.style.left = `${room.pointer.x + 18}px`; tip.style.top = `${room.pointer.y + 12}px`; tip.hidden = false;
  } else tip.hidden = true;

  // position 3D-anchored labels
  for (const { el, anchor } of labels.values()) {
    const s = room.project(anchor());
    // keep every label on screen: below the top bar, clear of the edges
    const w = el.offsetWidth, h = el.offsetHeight;
    const x = Math.max(w / 2 + 12, Math.min(room.w - w / 2 - 12, s.x));
    const y = Math.max(h + 76, Math.min(room.h - 180, s.y));
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- start
$('#begin').addEventListener('click', async () => {
  $('#begin').disabled = true;
  engine.ensureContext();
  await engine.ctx.resume();
  try {
    await loadCommon();
  } catch (e) {
    console.error(e); setLoading(`Couldn’t load audio: ${e.message}`); return;
  }
  $('#intro').classList.add('gone');
  story(0);
});
room.setShot(SHOTS.wide, true);
window.__story = { room, engine, rise, anim, onRep, buff, pose, singFlight, flashJump, get lim() { return lim; }, get mel() { return mel; }, get flightBuf() { return flightBuf; } };
