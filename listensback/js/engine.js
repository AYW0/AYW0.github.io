// Audio engine: the Web Audio port of beatTracking.cs, tempoAdjustment.cs,
// notification.cs, audioEffects.cs and muteSelf.cs.
import { ASSETS, MAJOR_MAP, RINGTONES } from './data.js';
import { stretchBuffer } from './stretch.js';

const dbToGain = (db) => Math.pow(10, db / 20);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const url = (p) => ASSETS + p.split('/').map(encodeURIComponent).join('/');

// Per-band ranges used to normalise FrequencyMap.csv (beatTracking.cs mapRangeMin/Max).
const MAP_MAX = [32.19865, 42.57510, 47.26473, 45.46424, 43.82999, 40.08769, 37.99331];
const MAP_MIN = [-11.45751, -3.32113, -18.06523, -19.86837, -22.54942, -22.81399, -23.54567];
// Average ringtone spectrum, used by the "quietest spot" schedule (beatTracking.cs nextBestBeat).
const NOTIF_SPECTRUM = [66, 68, 60, 45, 32, 25, 14];
const DUCK_DB = -30;
const DUCK_TAU = 0.09; // ≈ Mathf.Lerp(…, 0.2) per 20 ms FixedUpdate

function parseCsvRows(text) {
  return text.trim().split(/\r?\n/).map((l) => l.split(',').map((x) => parseFloat(x)));
}

// Nearest-index search over a sorted array (beatTracking.cs search()).
function nearest(arr, v) {
  let lo = 0, hi = arr.length - 1;
  if (v <= arr[0]) return 0;
  if (v >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  return v - arr[lo] < arr[hi] - v ? lo : hi;
}

// A loop from late in the song back to early on: both ends on a phrase start, chosen where the
// 7-band spectrum around the two points matches best, so the jump sounds like the song continuing.
function findLoop(song) {
  const a = song.analysis, B = a.beats, F = a.freq, P = a.phraseIdx, dur = song.duration;
  const energy = (i) => { let e = 0; for (let f = 0; f < 7; f++) e += F[f][i] || 0; return e; };
  const dist = (i, j) => { let d = 0; for (let f = 0; f < 7; f++) d += Math.abs((F[f][i] || 0) - (F[f][j] || 0)); return d; };
  let best = null;
  for (const i of P) {
    if (B[i] < dur * 0.55 || i + 8 >= B.length || B[i] > dur - 4) continue;
    if (energy(i) < 2) continue;
    for (const j of P) {
      if (B[j] > dur * 0.4 || j < 8 || B[i] - B[j] < 40) continue;
      let d = 0;
      for (let k = -8; k < 8; k++) d += dist(i + k, j + k);
      d -= (B[i] / dur) * 2;
      if (!best || d < best.d) best = { d, from: B[i], to: B[j] };
    }
  }
  return best && { from: best.from, to: best.to };
}

// Gain that brings a set of buffers (played together) to a common RMS level, so songs mastered
// louder or quieter come out at about the same loudness. Capped so quiet songs aren't blown up.
export function normGain(bufs, target = 0.11) {
  let sum = 0, n = 0;
  const len = Math.max(...bufs.map((b) => b.length)), step = 7;
  for (let i = 0; i < len; i += step) {
    let v = 0;
    for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); if (i < d.length) v += d[i] / b.numberOfChannels; }
    sum += v * v; n++;
  }
  const rms = Math.sqrt(sum / Math.max(1, n)) || target;
  return Math.max(0.2, Math.min(1.6, target / rms));
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.song = null;
    this.playing = false;
    this.offset = 0;
    this.startAt = 0;
    this.sources = [];
    this.ring = null;
    this.bufferCache = new Map();
    this.processedCache = new Map();
    this.rms = 0;
    this.metronome = false;
    this.nextClickBeat = -1;
    this.params = null;
    this.irDecay = null;
  }

  // ---------- setup ----------
  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));

    this.master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 6; limiter.ratio.value = 8;
    // loudness normalization for the current song, applied to the whole mix (song + ringtone +
    // voice) so their balance is unchanged
    this.songNorm = ctx.createGain();
    this.master.connect(this.songNorm).connect(limiter).connect(ctx.destination);

    // Song: separated vocals + accompaniment, each with its own fader (audioEffects.cs).
    this.songBus = ctx.createGain();
    this.vocalGain = ctx.createGain();
    this.accGain = ctx.createGain();
    this.vocalGain.connect(this.songBus);
    this.accGain.connect(this.songBus);
    this.songBus.connect(this.master);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.songBus.connect(this.analyser);
    this.anaBuf = new Float32Array(this.analyser.fftSize);

    // Ringtone chain: fade → volume → adaptive → highpass → lowpass → pan → dry/reverb.
    this.rtIn = ctx.createGain();
    this.rtFade = ctx.createGain();
    this.rtVol = ctx.createGain();
    this.rtAdapt = ctx.createGain();
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass';
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass';
    this.panner = ctx.createStereoPanner();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.rtIn.connect(this.rtFade).connect(this.rtVol).connect(this.rtAdapt)
      .connect(this.hp).connect(this.lp).connect(this.panner);
    this.panner.connect(this.dry).connect(this.master);
    this.panner.connect(this.convolver).connect(this.wet).connect(this.master);
    this.rtAnalyser = ctx.createAnalyser();
    this.rtAnalyser.fftSize = 512;
    this.panner.connect(this.rtAnalyser);
    this.rtBuf = new Float32Array(this.rtAnalyser.fftSize);

    this.clickGain = ctx.createGain();
    this.clickGain.gain.value = 0.35;
    this.clickGain.connect(this.master);
    this.loadBuffer('notifications/click.mp3').then((b) => (this.clickBuf = b)).catch(() => {});

    if (this.params) this.applyParams(this.params);
    return ctx;
  }

  async loadBuffer(path) {
    if (this.bufferCache.has(path)) return this.bufferCache.get(path);
    const p = (async () => {
      const res = await fetch(url(path));
      if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    })();
    this.bufferCache.set(path, p);
    p.catch(() => this.bufferCache.delete(path));
    return p;
  }

  // ---------- song ----------
  async loadSong(song, onProgress = () => {}) {
    this.ensureContext();
    this.stop();
    const dir = `music/${song.dir}/`;
    const text = async (f) => {
      const r = await fetch(url(dir + f));
      if (!r.ok) throw new Error(`Missing ${dir + f}`);
      return r.text();
    };
    onProgress('Reading beat analysis…');
    const [beatsT, downT, freqT, balT] = await Promise.all([
      text('timeStamps.csv'), text('DownbeatTimeStamps.csv'), text('FrequencyMap.csv'), text('StereoBalance.csv'),
    ]);
    const beats = parseCsvRows(beatsT)[0];
    const downTimes = parseCsvRows(downT)[0];
    const freqRaw = parseCsvRows(freqT).slice(0, 7);
    const balance = parseCsvRows(balT)[0];

    // Downbeats → beat indices; every 4th downbeat (offset by firstBeat) starts a phrase.
    const downbeatIdx = [];
    const phraseIdx = [];
    const isDown = new Uint8Array(beats.length);
    const isPhrase = new Uint8Array(beats.length);
    downTimes.forEach((t, i) => {
      const idx = nearest(beats, t);
      downbeatIdx.push(idx);
      isDown[idx] = 1;
      if (i % 4 === song.firstBeat) { phraseIdx.push(idx); isPhrase[idx] = 1; }
    });
    const freq = freqRaw.map((row, b) =>
      Float32Array.from(beats, (_, i) => clamp((row[i] - MAP_MIN[b]) / (MAP_MAX[b] - MAP_MIN[b]), 0, 1)));
    const diffs = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
    const beatDur = diffs[diffs.length >> 1] || 0.5;

    onProgress('Loading vocals and instruments…');
    const [vocals, acc] = await Promise.all([
      this.loadBuffer(dir + (song.vocals || 'vocals.mp3')),
      this.loadBuffer(dir + (song.acc || 'accompaniment.mp3')),
    ]);
    // Free decoded audio of other songs; keep ringtones.
    for (const k of this.bufferCache.keys()) if (k.startsWith('music/') && !k.startsWith(dir)) this.bufferCache.delete(k);

    this.songNorm.gain.value = normGain([vocals, acc]);
    this.song = {
      ...song, vocals, acc,
      duration: Math.max(vocals.duration, acc.duration),
      analysis: { beats, downbeatIdx, phraseIdx, isDown, isPhrase, freq, balance, beatDur },
    };
    this.song.loop = findLoop(this.song);
    this.offset = 0;
    this.dispatchEvent(new Event('songchange'));
    return this.song;
  }

  get time() {
    if (!this.song) return 0;
    if (this.pendingJump && this.ctx.currentTime >= this.pendingJump.c) { this.offset = this.pendingJump.to; this.startAt = this.pendingJump.c; this.pendingJump = null; }
    return this.playing ? this.offset + (this.ctx.currentTime - this.startAt) : this.offset;
  }

  play() {
    if (!this.song || this.playing) return;
    this.fadeToken = (this.fadeToken || 0) + 1;
    if (this.songBus) { this.songBus.gain.cancelScheduledValues(0); this.songBus.gain.setValueAtTime(1, this.ctx.currentTime); }
    this.ensureContext();
    this.ctx.resume();
    if (this.offset >= this.song.duration - 0.1) this.offset = 0;
    const when = this.ctx.currentTime + 0.06;
    this.pendingJump = null;
    this.sources = this.startSources(when, this.offset, 0);
    this.sources[1].onended = () => {
      if (this.playing && this.time >= this.song.duration - 0.2) {
        this.playing = false;
        this.offset = 0;
        this.dismiss();
        this.dispatchEvent(new Event('statechange'));
      }
    };
    this.startAt = when;
    this.playing = true;
    this.nextClickBeat = -1;
    this.dispatchEvent(new Event('statechange'));
  }

  // vocals + accompaniment, each through its own gain so a loop can crossfade
  startSources(when, offset, fade) {
    return [[this.song.vocals, this.vocalGain], [this.song.acc, this.accGain]].map(([buf, dest]) => {
      const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
      s.buffer = buf; s.connect(g); g.connect(dest); s._g = g;
      if (fade) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + fade); }
      s.start(when, Math.max(0, offset));
      return s;
    });
  }

  // Seamless loop: at loop.from the song jumps back to loop.to (both bar-aligned, similar sound).
  loopTick() {
    const L = this.song.loop;
    if (!L || !this.playing || this.pendingJump) return;
    const t = this.time;
    if (t < L.from - 0.4 || t >= L.from) return;
    const xf = 0.03, c = this.ctxTime(L.from);
    for (const s of this.sources) { s.onended = null; s._g.gain.setValueAtTime(1, c - xf); s._g.gain.linearRampToValueAtTime(0, c + xf); try { s.stop(c + xf + 0.02); } catch {} }
    this.sources = this.startSources(c - xf, L.to - xf, 2 * xf);
    this.pendingJump = { c, to: L.to };
  }

  stop() {
    if (!this.playing) return;
    this.pendingJump = null;
    this.offset = this.time;
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch {} }
    this.sources = [];
    this.playing = false;
    this.dismiss();
    this.dispatchEvent(new Event('statechange'));
  }

  toggle() { this.playing ? this.stop() : this.play(); }

  // fade the song out over `sec` seconds, then stop (the bus gain is restored for the next play)
  fadeStop(sec = 2) {
    if (!this.playing) return;
    const g = this.songBus.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + sec);
    const token = (this.fadeToken = (this.fadeToken || 0) + 1);
    setTimeout(() => { if (this.fadeToken !== token) return; this.stop(); g.cancelScheduledValues(0); g.setValueAtTime(1, this.ctx.currentTime); }, sec * 1000 + 30);
  }

  seek(t) {
    if (!this.song) return;
    const was = this.playing;
    this.stop();
    this.offset = clamp(t, 0, this.song.duration - 0.5);
    if (was) this.play();
    this.dispatchEvent(new Event('statechange'));
  }

  // Song time → AudioContext time.
  ctxTime(songT) { return this.startAt + (songT - this.offset); }

  nextBeatIndex(t = this.time) {
    const b = this.song.analysis.beats;
    let lo = 0, hi = b.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  }

  // ---------- parameters ----------
  applyParams(p) {
    this.params = p;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.rtVol.gain.setTargetAtTime(dbToGain(p.volume - 30), now, 0.03);
    this.hp.frequency.setTargetAtTime(p.highpass, now, 0.03);
    this.lp.frequency.setTargetAtTime(p.lowpass, now, 0.03);
    const mix = p.reverbMix / 1000;
    this.wet.gain.setTargetAtTime(mix * 1.2, now, 0.03);
    this.dry.gain.setTargetAtTime(1 - 0.6 * mix, now, 0.03);
    if (mix > 0 && this.irDecay !== p.reverbDecay) this.buildImpulse(p.reverbDecay);
    if (this.ring) this.applyDucking(this.ring);
  }

  buildImpulse(decay) {
    this.irDecay = decay;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * Math.min(decay, 10));
    const ir = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        // Exponential decay reaching −60 dB at `decay` seconds (RT60).
        d[i] = (Math.random() * 2 - 1) * Math.pow(10, (-3 * i) / (sr * decay)) * 0.5;
      }
    }
    this.convolver.buffer = ir;
  }

  // ---------- ringtone preparation (tempoAdjustment.cs) ----------
  matchPlan(rt, p) {
    const song = this.song;
    // Closest pre-rendered tempo; with beat match off, use the original (first) file.
    // Unlike the Unity version, also consider half/double time, so a slow song (85 BPM)
    // pairs with a ringtone at 171 BPM instead of dragging a 120 BPM ringtone down to ×0.71.
    // Unadapted: the file closest to the phone's own tempo, stretched to exactly that tempo.
    let tempoIdx = rt.native ? rt.tempos.reduce((b, t, i) => (Math.abs(t - rt.native) < Math.abs(rt.tempos[b] - rt.native) ? i : b), 0) : rt.orig ?? 0, mult = 1;
    if (p.beatMatch) {
      let diff = Infinity;
      for (const m of [1, 2, 0.5]) {
        rt.tempos.forEach((t, i) => {
          const d = Math.abs(Math.log((song.bpm * m) / t));
          if (d < diff - 1e-9) { diff = d; tempoIdx = i; mult = m; }
        });
      }
    }
    const tempo = rt.tempos[tempoIdx];
    const target = song.bpm * mult;
    const speed = p.beatMatch ? target / tempo : rt.native ? rt.native / tempo : 1;
    // Ringtone length in song beats (rt.length assumes mult = 1).
    const beats = Math.max(1, Math.round(rt.length / mult));

    // Least pitch shift from any key the ringtone fits into to the song key (findLeastPitchShift).
    let best = null;
    for (const k of rt.keys) {
      let d = MAJOR_MAP[song.key - 1] - MAJOR_MAP[k - 1];
      if (d > 6) d -= 12;
      if (d < -6) d += 12;
      if (!best || Math.abs(d) < Math.abs(best.shift)) best = { key: k, shift: d };
    }
    const semis = p.keyMatch ? best.shift : 0;
    return { tempoIdx, tempo, target, mult, beats, speed, semis, ringKey: best.key, file: rt.file(p.timbre, tempo) };
  }

  async prepare(rt, p) {
    const plan = this.matchPlan(rt, p);
    const rate = Math.pow(2, plan.semis / 12);
    const cacheKey = `${plan.file}|${plan.speed.toFixed(4)}|${plan.semis}`;
    let buffer = this.processedCache.get(cacheKey);
    if (!buffer) {
      const raw = await this.loadBuffer(plan.file);
      // Stretch to rate/speed × length, then playbackRate=rate → tempo ×speed, pitch ×rate.
      buffer = stretchBuffer(this.ctx, raw, rate / plan.speed);
      if (this.processedCache.size > 24) this.processedCache.clear();
      this.processedCache.set(cacheKey, buffer);
    }
    return { ...plan, buffer, rate, dur: buffer.duration / rate };
  }

  // ---------- scheduling (beatTracking.cs nextBestBeatRingtone / nextBestBeat) ----------
  planStart(rt, p, lead = 0.08) {
    const a = this.song.analysis;
    const t = this.time + lead;
    const nb = this.nextBeatIndex(t);
    if (nb >= a.beats.length) return null;
    const pick = (list) => {
      for (const idx of list) if (nb + rt.pickup <= idx) return Math.max(nb, idx - rt.pickup);
      return nb;
    };
    switch (p.schedule) {
      case 'now': return { beat: null, t, wait: lead };
      case 'beat': break;
      case 'bar': { const b = pick(a.downbeatIdx); return { beat: b, t: a.beats[b] }; }
      case 'phrase': {
        // leave room for a countdown before the ringtone enters
        const lead = p.minLead || 0;
        let b = pick(a.phraseIdx);
        if (b < nb + lead) b = a.phraseIdx.find((x) => x - rt.pickup >= nb + lead) - rt.pickup || b;
        // A sweet spot (e.g. where the bass drops back in) shortly after the phrase start is worth
        // waiting a little longer for: the ringtone's downbeat lands on it.
        if (p.sweet) for (const sw of p.sweet) {
          const st = sw - rt.pickup;
          if (st < nb + (p.minLead || 0)) continue;
          if (st <= b + (p.lenient || 0)) return { beat: st, t: a.beats[st], sweet: sw };
          break;
        }
        return { beat: b, t: a.beats[b] };
      }
      case 'quiet': {
        // Least spectral collision with the ringtone, penalising waiting (lookAheadRange 32).
        let bestScore = Infinity, bestIdx = nb;
        for (let i = nb; i < Math.min(a.beats.length, nb + 32); i++) {
          let s = 0;
          for (let f = 0; f < 7; f++) s += NOTIF_SPECTRUM[f] * a.freq[f][i] * 100;
          s = s / 7 + (i - nb) ** 2;
          if (s < bestScore) { bestScore = s; bestIdx = i; }
        }
        return { beat: bestIdx, t: a.beats[bestIdx] };
      }
    }
    return { beat: nb, t: a.beats[nb] };
  }

  // ---------- ring (notification.cs) ----------
  async trigger(rt, p) {
    if (!this.song) return;
    this.ensureContext();
    this.dismiss();
    if (!this.playing) this.play();
    const prep = await this.prepare(rt, p);
    const start = this.planStart(rt, p);
    if (!start) return;
    const a = this.song.analysis;

    // Repeats: beat-matched rings re-align to the song's beat grid every `length` beats;
    // otherwise they play back to back.
    const plays = [];
    for (let k = 0; k < p.repeats; k++) {
      let t;
      if (k === 0) t = start.t;
      else if (p.beatMatch && start.beat != null && a.beats[start.beat + k * prep.beats] != null) t = a.beats[start.beat + k * prep.beats];
      else t = plays[k - 1].t + prep.dur;
      if (t > this.song.duration) break;
      plays.push({ t, dur: prep.dur });
    }

    const nodes = plays.map(({ t }) => {
      const s = this.ctx.createBufferSource();
      s.buffer = prep.buffer;
      s.playbackRate.value = prep.rate;
      s.connect(this.rtIn);
      s.start(Math.max(this.ctx.currentTime, this.ctxTime(t)));
      return s;
    });

    const ring = {
      rt, prep, plays, nodes, start,
      params: { ...p },
      t0: plays[0].t,
      t1: plays[plays.length - 1].t + prep.dur,
      wait: plays[0].t - this.time,
    };
    this.ring = ring;

    // Fade-in: start 30 dB down and glide up (audioEffects.cs fadeInSpeed lerp at 50 Hz).
    const c0 = Math.max(this.ctx.currentTime, this.ctxTime(ring.t0));
    const g = this.rtFade.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(p.fadeIn ? dbToGain(-30) : 1, c0);
    if (p.fadeIn) g.setTargetAtTime(1, c0, 0.02 / -Math.log(1 - p.fadeInSpeed));
    this.applyDucking(ring);
    this.dispatchEvent(new CustomEvent('ring', { detail: ring }));
    return ring;
  }

  applyDucking(ring) {
    const p = this.params;
    const c0 = Math.max(this.ctx.currentTime, this.ctxTime(ring.t0));
    const c1 = this.ctxTime(ring.t1);
    for (const [gain, on] of [[this.vocalGain.gain, p.duckVocals], [this.accGain.gain, p.duckSong]]) {
      gain.cancelScheduledValues(0);
      gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      if (on) {
        gain.setTargetAtTime(dbToGain(DUCK_DB), c0, DUCK_TAU);
        gain.setTargetAtTime(1, c1, DUCK_TAU * 3);
      }
    }
  }

  dismiss() {
    if (!this.ring || !this.ctx) { this.ring = null; return; }
    const now = this.ctx.currentTime;
    this.rtFade.gain.cancelScheduledValues(0);
    this.rtFade.gain.setTargetAtTime(0, now, 0.03);
    for (const s of this.ring.nodes) { try { s.stop(now + 0.2); } catch {} }
    for (const g of [this.vocalGain.gain, this.accGain.gain]) {
      g.cancelScheduledValues(0);
      g.setTargetAtTime(1, now, 0.15);
    }
    this.ring = null;
    this.dispatchEvent(new Event('ringend'));
  }

  // ---------- per-frame work ----------
  tick() {
    if (!this.ctx || !this.song) return;
    const now = this.ctx.currentTime;
    const p = this.params;
    const a = this.song.analysis;
    this.loopTick();
    if (!p) return;
    const t = this.time;

    // Song loudness (RMS), smoothed like audioEffects.cs.
    this.analyser.getFloatTimeDomainData(this.anaBuf);
    let sum = 0;
    for (const v of this.anaBuf) sum += v * v;
    this.rms += (Math.sqrt(sum / this.anaBuf.length) - this.rms) * 0.1;

    if (this.playing) {
      // Pan the ringtone toward where the music currently sits (muteSelf.cs).
      const nb = Math.min(this.nextBeatIndex(t), a.balance.length - 1);
      this.panner.pan.setTargetAtTime(clamp((a.balance[nb] || 0) * p.pan, -1, 1), now, 0.05);
      // Adaptive volume: louder song → louder ringtone, capped at +5 dB overall.
      const base = p.volume - 30;
      const target = Math.min(base + this.rms * p.adaptive * 10, 5);
      this.rtAdapt.gain.setTargetAtTime(dbToGain(target - base), now, 0.1);

      if (this.metronome && this.clickBuf) this.scheduleClicks(t);
      if (this.ring && t > this.ring.t1 + 0.3) {
        this.ring = null;
        this.dispatchEvent(new Event('ringend'));
      }
    }
  }

  scheduleClicks(t) {
    const b = this.song.analysis.beats;
    let i = this.nextClickBeat < 0 ? this.nextBeatIndex(t) : this.nextClickBeat;
    while (i < b.length && b[i] < t + 0.15) {
      if (b[i] >= t) {
        const s = this.ctx.createBufferSource();
        s.buffer = this.clickBuf;
        s.connect(this.clickGain);
        s.start(this.ctxTime(b[i]));
      }
      i++;
    }
    this.nextClickBeat = i;
  }

  ringLevel() {
    if (!this.ctx) return 0;
    this.rtAnalyser.getFloatTimeDomainData(this.rtBuf);
    let m = 0;
    for (const v of this.rtBuf) m = Math.max(m, Math.abs(v));
    return m;
  }
}

export { RINGTONES };
