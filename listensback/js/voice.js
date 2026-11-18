// Speech → song DSP for the musical assistant (Wang, Lindlbauer & Donahue, UIST 2024).
//
// Paper pipeline: TTS → forced alignment → syllable onsets → Anticipatory Music Transformer
// melody (one note per syllable, ±1/16 of the speech rhythm) → TD-PSOLA re-pitch → replace vocals.
// Simplified here: syllables are found from the loudness envelope of the TTS audio, the
// speech rhythm is snapped to the nearest 16th note, and each note's pitch is read off the
// song's own (source-separated) vocal line with YIN, then the speech is re-pitched with TD-PSOLA.

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// Downmix + resample (part of) an AudioBuffer with the browser's resampler.
export async function toMono(buf, sr, t0 = 0, t1 = buf.duration) {
  t0 = Math.max(0, t0); t1 = Math.min(buf.duration, t1);
  const len = Math.max(1, Math.ceil((t1 - t0) * sr));
  const off = new OfflineAudioContext(1, len, sr);
  const s = off.createBufferSource();
  s.buffer = buf;
  s.connect(off.destination);
  s.start(0, t0, t1 - t0);
  return (await off.startRendering()).getChannelData(0);
}

// ---------------------------------------------------------------- pitch tracking (YIN)
export function yin(x, sr, { hop = 0.01, fmin = 80, fmax = 900, thresh = 0.2, gateDb = -42 } = {}) {
  const H = Math.max(1, Math.round(hop * sr));
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.ceil(sr / fmin);
  const W = tauMax;
  const n = Math.max(0, Math.floor((x.length - W - tauMax) / H) + 1);
  const f0 = new Float32Array(n), conf = new Float32Array(n), rms = new Float32Array(n);
  const d = new Float32Array(tauMax + 1);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const gate = peak * Math.pow(10, gateDb / 20);

  for (let k = 0; k < n; k++) {
    const s = k * H;
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    rms[k] = Math.sqrt(e / W);
    if (rms[k] < gate) continue;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const v = x[s + j] - x[s + j + tau]; sum += v * v; }
      d[tau] = sum;
    }
    // Cumulative-mean-normalised difference.
    let run = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; d[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < thresh) { while (t + 1 <= tauMax && d[t + 1] < d[t]) t++; tau = t; break; }
    }
    if (tau < 0) continue;
    // Parabolic interpolation around the dip.
    let ft = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const den = a - 2 * b + c;
      if (den > 0) ft = tau + (0.5 * (a - c)) / den;
    }
    f0[k] = sr / ft;
    conf[k] = 1 - d[tau];
  }
  const t0 = W / sr; // frame k is centred near k*hop + W/sr
  return { f0, conf, rms, hop: H / sr, t0, timeOf: (k) => t0 + (k * H) / sr };
}

// Median-filter f0 and drop isolated voiced blips (speech tracks are noisy at consonants).
function cleanTrack(f0, w = 2) {
  const out = new Float32Array(f0.length);
  for (let k = 0; k < f0.length; k++) {
    if (!f0[k]) continue;
    const win = [];
    for (let j = Math.max(0, k - w); j <= Math.min(f0.length - 1, k + w); j++) if (f0[j]) win.push(f0[j]);
    if (win.length >= w + 1) out[k] = median(win);
  }
  return out;
}

// ---------------------------------------------------------------- syllables from text
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numWords(n % 100) : '');
  return String(n).split('').map((c) => ONES[+c]).join(' ');
}

export function normalizeText(text) {
  return text
    .replace(/(\d+)\s*(am|pm|a\.m\.|p\.m\.)/gi, (_, n, s) => `${n} ${s.replace(/\./g, '').split('').join(' ')}`)
    .replace(/\d+/g, (n) => ' ' + numWords(Math.min(+n, 999999)) + ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Rough English syllabification: vowel groups, minus a silent final e. Returns display chunks.
export function syllabify(text) {
  const words = normalizeText(text).toLowerCase().match(/[a-z']+/g) || [];
  const out = [];
  for (const w of words) {
    if (w.length <= 3) { out.push(w); continue; }
    const groups = [];
    const re = /[aeiouy]+/g;
    let m;
    while ((m = re.exec(w))) groups.push([m.index, m.index + m[0].length]);
    // silent e / -es / -ed endings
    const last = groups[groups.length - 1];
    if (groups.length > 1 && last && last[1] === w.length && /[^aeiouyl]e$/.test(w)) groups.pop();
    else if (groups.length > 1 && /[^aeiouy](es|ed)$/.test(w) && !/(ted|ded|ses|zes|ces|ges)$/.test(w)) groups.pop();
    if (groups.length <= 1) { out.push(w); continue; }
    // split between vowel groups: keep one consonant with the following syllable
    let start = 0;
    for (let i = 0; i < groups.length - 1; i++) {
      const gapStart = groups[i][1], gapEnd = groups[i + 1][0];
      const cut = gapEnd - gapStart <= 1 ? gapStart : gapEnd - 1;
      out.push(w.slice(start, cut));
      start = cut;
    }
    out.push(w.slice(start));
  }
  return out;
}

// ---------------------------------------------------------------- syllables from audio
function biquad(x, sr, type, f, q = 0.707) {
  const w = (2 * Math.PI * f) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; } else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// Find syllable nuclei as prominent, voiced peaks of the 250–3000 Hz loudness envelope
// (after de Jong & Wempe, 2009), keeping the `n` most prominent. Syllables start at the
// envelope dip before each nucleus. Stands in for the paper's forced aligner.
// words (optional): [{ start, end, n }] word boundaries from an aligner; syllables are then only
// split inside each word, at its n−1 deepest loudness dips.
export function segmentSyllables(x, sr, n, track, words = null) {
  const band = biquad(biquad(x, sr, 'lp', 3000), sr, 'hp', 250);
  const hop = Math.round(0.005 * sr), win = Math.round(0.03 * sr);
  const K = Math.max(1, Math.floor((x.length - win) / hop));
  const env = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let e = 0;
    for (let j = 0; j < win; j++) { const v = band[k * hop + j]; e += v * v; }
    env[k] = 10 * Math.log10(e / win + 1e-12);
  }
  const sm = env.map((_, k) => (env[Math.max(0, k - 2)] + env[Math.max(0, k - 1)] + env[k] + env[Math.min(K - 1, k + 1)] + env[Math.min(K - 1, k + 2)]) / 5);
  const top = Math.max(...sm);
  const floor = top - 32;
  const tOf = (k) => (k * hop + win / 2) / sr;
  let first = 0, last = K - 1;
  while (first < K - 1 && sm[first] < floor) first++;
  while (last > first && sm[last] < floor) last--;

  const voicedAt = (t) => {
    if (!track) return true;
    const k = Math.round((t - track.t0) / track.hop);
    for (let j = k - 3; j <= k + 3; j++) if (track.f0[j]) return true;
    return false;
  };
  let out;
  if (words) {
    out = [];
    for (const w of words) {
      const ka = Math.max(0, Math.round(((w.start + 0.04) * sr - win / 2) / hop)), kb = Math.min(K - 1, Math.round(((w.end - 0.04) * sr - win / 2) / hop));
      // choose n−1 cuts among the loudness dips: deep dips, near an even split, ≥ 70 ms apart
      const minGap = Math.round(0.07 / (hop / sr));
      const dips = [];
      for (let k = ka + 1; k < kb; k++) if (sm[k] <= sm[k - 1] && sm[k] < sm[k + 1]) dips.push(k);
      const want = Array.from({ length: w.n - 1 }, (_, i) => ka + ((kb - ka) * (i + 1)) / w.n);
      let cuts = want.map(Math.round), bestCost = Infinity;
      const span = Math.max(1, kb - ka), top = Math.max(...sm.slice(ka, kb + 1));
      const choose = (start, picked) => {
        if (picked.length === w.n - 1) {
          // every syllable must contain a voiced vowel (≥ 40 ms): an unvoiced tail like the
          // "ks" of "Alex" can't be a syllable of its own
          if (track) {
            const edges = [ka, ...picked, kb];
            for (let q = 0; q + 1 < edges.length; q++) {
              let v = 0;
              for (let k = edges[q]; k < edges[q + 1]; k++) { const fk = Math.round((tOf(k) - track.t0) / track.hop); if (track.f0[fk]) v++; }
              if (v * hop / sr < 0.04) return;
            }
          }
          let c = 0;
          picked.forEach((k, i) => { c += (sm[k] - top) / 6 + 8 * Math.pow((k - want[i]) / span, 2) * w.n; });
          if (c < bestCost) { bestCost = c; cuts = picked.slice(); }
          return;
        }
        for (let d = start; d < dips.length; d++) {
          const k = dips[d], prev = picked.length ? picked[picked.length - 1] : ka;
          if (k - prev < minGap || kb - k < minGap * (w.n - 1 - picked.length)) continue;
          picked.push(k); choose(d + 1, picked); picked.pop();
        }
      };
      if (w.n > 1 && dips.length <= 40) choose(0, []);
      cuts.sort((p, q) => p - q);
      const edges = [w.start, ...cuts.map(tOf), w.end];
      for (let i = 0; i < w.n; i++) {
        const k0 = Math.round((edges[i] * sr - win / 2) / hop), k1 = Math.round((edges[i + 1] * sr - win / 2) / hop);
        let kp = Math.max(0, k0); for (let k = kp; k <= Math.min(K - 1, k1); k++) if (sm[k] > sm[kp]) kp = k;
        out.push({ start: edges[i], peak: tOf(kp), end: edges[i + 1] });
      }
    }
  } else {
  const all = [];
  for (let k = first + 1; k < last; k++) {
    if (!(sm[k] >= sm[k - 1] && sm[k] > sm[k + 1]) || sm[k] < floor + 4) continue;
    let l = sm[k], r = sm[k];
    for (let j = k - 1; j >= first && sm[j] <= sm[k]; j--) l = Math.min(l, sm[j]);
    for (let j = k + 1; j <= last && sm[j] <= sm[k]; j++) r = Math.min(r, sm[j]);
    all.push({ k, prom: sm[k] - Math.max(l, r), voiced: voicedAt(tOf(k)) });
  }
  all.sort((a, b) => b.prom - a.prom);
  const minGap = Math.round(0.075 / (hop / sr));
  // Strict first (voiced, ≥1.5 dB dips); relax until the text's syllable count is reached.
  let chosen = [];
  for (const [minProm, needVoice] of [[1.5, true], [0.6, true], [0.6, false], [0.2, false]]) {
    chosen = [];
    for (const c of all) {
      if (n && chosen.length >= n) break;
      if (c.prom < minProm || (needVoice && !c.voiced)) continue;
      if (chosen.every((o) => Math.abs(o.k - c.k) >= minGap)) chosen.push(c);
    }
    if (!n || chosen.length >= n) break;
  }
  chosen.sort((a, b) => a.k - b.k);
  if (!chosen.length) chosen.push({ k: (first + last) >> 1 });

  const starts = [first];
  for (let i = 1; i < chosen.length; i++) {
    let mk = chosen[i - 1].k;
    for (let j = chosen[i - 1].k; j <= chosen[i].k; j++) if (sm[j] < sm[mk]) mk = j;
    starts.push(mk);
  }
  out = chosen.map((c, i) => ({
    start: tOf(starts[i]) - (i === 0 ? 0.01 : 0),
    peak: tOf(c.k),
    end: i + 1 < chosen.length ? tOf(starts[i + 1]) : Math.min(x.length / sr, tOf(last) + 0.03),
  }));
  // Still short of the text's count (e.g. "p m" run together): split the longest syllables
  // at their deepest internal dip.
  while (n && out.length < n) {
    let li = -1, ld = 0.16;
    out.forEach((s, i) => { if (s.end - s.start > ld) { ld = s.end - s.start; li = i; } });
    if (li < 0) break;
    const s = out[li];
    const ka = Math.round((s.start + 0.3 * (s.end - s.start)) * sr / hop), kb = Math.round((s.start + 0.7 * (s.end - s.start)) * sr / hop);
    let mk = ka;
    for (let k = ka; k <= kb && k < K; k++) if (sm[k] < sm[mk]) mk = k;
    const cut = tOf(mk);
    out.splice(li, 1, { start: s.start, peak: Math.min(s.peak, cut), end: cut }, { start: cut, peak: Math.max(s.peak, cut), end: s.end });
  }
  // Too-short syllables (< 90 ms) are spurious peaks: merge each into its shorter neighbour,
  // then split the longest syllable at its deepest dip to keep the count.
  const splitLongest = () => {
    let li = -1, ld = 0.16;
    out.forEach((q, i) => { if (q.end - q.start > ld) { ld = q.end - q.start; li = i; } });
    if (li < 0) return false;
    const q = out[li];
    const ka = Math.round(((q.start + 0.3 * (q.end - q.start)) * sr) / hop), kb = Math.round(((q.start + 0.7 * (q.end - q.start)) * sr) / hop);
    let mk = ka;
    for (let k = ka; k <= kb && k < K; k++) if (sm[k] < sm[mk]) mk = k;
    const cut = tOf(mk);
    out.splice(li, 1, { start: q.start, peak: Math.min(q.peak, cut), end: cut }, { start: cut, peak: Math.max(q.peak, cut), end: q.end });
    return true;
  };
  for (let guard = 0; guard < 2 * out.length; guard++) {
    const i = out.findIndex((q) => q.end - q.start < 0.09);
    if (i < 0 || out.length < 2) break;
    const prev = out[i - 1], next = out[i + 1];
    const intoPrev = !next || (prev && prev.end - prev.start <= next.end - next.start);
    if (intoPrev) { prev.end = out[i].end; out.splice(i, 1); }
    else { next.start = out[i].start; next.peak = Math.max(next.peak, out[i].peak); out.splice(i, 1); }
    if (n && out.length < n && !splitLongest()) break;
  }
  // The last syllable keeps its trailing consonants (e.g. the "x" in "Alex"): extend it to
  // where the broadband energy finally falls away.
  {
    let e2 = 0; for (let i = 0; i < x.length; i++) e2 = Math.max(e2, Math.abs(x[i]));
    const thr = e2 * 0.02, w = Math.round(0.01 * sr);
    let endS = x.length - 1;
    while (endS > 0) { let m = 0; for (let j = Math.max(0, endS - w); j <= endS; j++) m = Math.max(m, Math.abs(x[j])); if (m > thr) break; endS -= w; }
    out[out.length - 1].end = Math.max(out[out.length - 1].end, Math.min(x.length / sr, endS / sr + 0.02));
  }
  }
  // Vowel onset: where the envelope first rises to within 6 dB of the syllable's peak.
  // This is the perceptual onset that should sit on the beat; the consonant leads it.
  for (const s of out) {
    const ka = Math.max(0, Math.round((s.start * sr - win / 2) / hop));
    let kp = Math.round((s.peak * sr - win / 2) / hop);
    const kb = Math.min(K - 1, Math.round((s.end * sr - win / 2) / hop));
    for (let k = ka; k <= kb; k++) if (sm[k] > sm[kp]) kp = k;
    let kv = kp;
    for (let k = ka; k <= kp; k++) if (sm[k] >= sm[kp] - 6) { kv = k; break; }
    s.vowel = Math.min(s.end - 0.02, Math.max(s.start, tOf(kv)));
    s.level = sm[kp];
  }
  return out;
}

// ---------------------------------------------------------------- rhythm
// Standard one-beat rhythm cells, as 16th-note onsets within the beat, with a simplicity cost.
// Every syllable lands on one of these, so the result reads as ordinary sung rhythm
// (quarters, 8ths, dotted 8th + 16th, …) rather than arbitrary positions on a fine grid.
export const CELLS = [
  { on: [0], cost: 0, name: '♩' },
  { on: [0, 2], cost: 0, name: '♫' },
  { on: [], cost: 0.35, name: 'rest' },
  { on: [0, 3], cost: 0.45, name: 'dotted ♪ + 16th' },
  { on: [0, 2, 3], cost: 0.5, name: '8th + two 16ths' },
  { on: [0, 1, 2], cost: 0.55, name: 'two 16ths + 8th' },
  { on: [2], cost: 0.6, name: 'off-beat 8th' },
  { on: [0, 1, 2, 3], cost: 0.9, name: 'four 16ths' },
];

// Fit syllables to a sequence of rhythm cells (dynamic programming over beats).
// Targets come from the spoken vowel onsets, scaled so the typical syllable gap becomes the
// chosen pace (8th or 16th note; 0 = whichever is closer to the speech rate). Costs: distance
// from the spoken timing, cell complexity, and loud syllables on weak 16th positions.
// Output slots are 16th notes from the downbeat.
export function quantize(syl, { beatDur, grid = 0, maxBeats = 8, fitTempo = true }) {
  const on = syl.map((s) => s.vowel ?? s.start);
  const N = on.length;
  const iois = on.slice(1).map((t, i) => t - on[i]).sort((a, b) => a - b);
  const medIoi = iois.length ? iois[iois.length >> 1] : 0.2;
  // 8th notes unless the song is so slow that 8ths drag (sung syllables ≳ 0.32 s).
  const pace = grid || (beatDur / 2 <= 0.32 ? 2 : 4);
  const g16 = beatDur / 4;
  const total = Math.max(on[N - 1] - on[0] + 0.15, 0.1);
  let alpha = fitTempo ? Math.min(1.8, Math.max(0.55, beatDur / pace / medIoi)) : 1;
  alpha = Math.min(alpha, ((maxBeats * 4 - 2) * g16) / total);
  const raw = on.map((t) => ((t - on[0]) * alpha) / g16);
  const lv = syl.map((s) => s.level ?? 0);
  const lmax = Math.max(...lv), lmin = Math.min(...lv);
  const stress = lv.map((l) => (lmax > lmin ? (l - lmin) / (lmax - lmin) : 0.5));
  const posCost = (i, slot) => {
    const d = slot - raw[i];
    const weak = slot % 2 ? 0.45 : slot % 4 ? 0.12 : slot % 16 ? 0 : -0.1;
    return 0.12 * d * d + stress[i] * weak;
  };

  // dp[b][n]: best cost having placed n syllables in the first b beats.
  const B = maxBeats;
  const INF = 1e9;
  const dp = Array.from({ length: B + 1 }, () => new Float64Array(N + 1).fill(INF));
  const from = Array.from({ length: B + 1 }, () => new Int32Array(N + 1).fill(-1));
  dp[0][0] = 0;
  for (let b = 0; b < B; b++) {
    for (let n = 0; n <= N; n++) {
      if (dp[b][n] >= INF) continue;
      CELLS.forEach((c, ci) => {
        const k = c.on.length;
        if (n + k > N) return;
        if (n === 0 && b === 0 && c.on[0] !== 0) return; // first syllable on the downbeat
        if (n === N && k) return;
        let cost = dp[b][n] + (n === N ? 0 : c.cost);
        // a rest in the middle of a word costs more
        if (!k && n > 0 && n < N && syl[n].start - syl[n - 1].end < 0.02 && !(on[n] - on[n - 1] > 1.6 * medIoi)) cost += 0.6;
        for (let j = 0; j < k; j++) cost += posCost(n + j, b * 4 + c.on[j]);
        if (cost < dp[b + 1][n + k]) { dp[b + 1][n + k] = cost; from[b + 1][n + k] = ci; }
      });
    }
  }
  let bEnd = -1, best = INF;
  for (let b = 1; b <= B; b++) if (dp[b][N] < best) { best = dp[b][N]; bEnd = b; }
  const slots = new Array(N);
  const cells = [];
  for (let b = bEnd, n = N; b > 0; b--) {
    const c = CELLS[from[b][n]];
    cells.unshift(c);
    n -= c.on.length;
    c.on.forEach((o, j) => { slots[n + j] = (b - 1) * 4 + o; });
  }
  while (cells.length && !cells[cells.length - 1].on.length) cells.pop();

  const notes = syl.map((s, i) => ({ i, slot: slots[i], raw: raw[i], src: [s.start, s.end], vowel: on[i] }));
  notes.forEach((nt, i) => {
    const next = notes[i + 1];
    // last note rings to the end of its beat, at least a quarter
    nt.slots = next ? next.slot - nt.slot : Math.max(4, 4 - (nt.slot % 4) + (nt.slot % 4 ? 4 : 0));
    nt.start = nt.slot * g16;
    nt.dur = nt.slots * g16;
  });
  const last = notes[N - 1];
  return { notes, g: g16, grid: 4, pace, alpha, cells, slots: last.slot + last.slots };
}

// PSOLA segments that put each vowel onset exactly on its note: the syllable's leading
// consonant is placed just before the note at (nearly) natural speed, and the vowel plus
// coda is stretched to fill the note. Times are relative to `origin` (song time).
export function buildSegments(notes, origin, maxLead = 0.14) {
  const segs = [];
  notes.forEach((nt, i) => {
    const cons = nt.vowel - nt.src[0];
    const room = i ? (nt.t - notes[i - 1].t) * 0.45 : maxLead;
    const lead = Math.min(cons, maxLead, room);
    const prevMidi = i ? notes[i - 1].midi : null;
    if (lead > 0.012) segs.push({ s0: nt.src[0], s1: nt.vowel, t: nt.t - lead - origin, dur: lead, midi: nt.midi, prevMidi });
    const nextLead = notes[i + 1] ? Math.min(notes[i + 1].vowel - notes[i + 1].src[0], maxLead, (notes[i + 1].t - nt.t) * 0.45) : 0;
    const end = notes[i + 1] ? notes[i + 1].t - (nextLead > 0.012 ? nextLead : 0) : nt.t1;
    segs.push({ s0: nt.vowel, s1: nt.src[1], t: nt.t - origin, dur: Math.max(0.03, end - nt.t), midi: nt.midi, prevMidi: lead > 0.012 ? null : prevMidi });
  });
  return segs;
}

// ---------------------------------------------------------------- melody
// Pitch of the song's vocal line under [t0, t1): median voiced YIN pitch, in MIDI.
export function pitchUnder(mel, t0, t1, minConf = 0.75) {
  const k0 = Math.max(0, Math.floor((t0 - mel.t0) / mel.hop));
  const k1 = Math.min(mel.f0.length - 1, Math.ceil((t1 - mel.t0) / mel.hop));
  const v = [];
  for (let k = k0; k <= k1; k++) if (mel.f0[k] && mel.conf[k] >= minConf) v.push(hzToMidi(mel.f0[k]));
  return v.length ? median(v) : null;
}

export function voicedFraction(mel, t0, t1, minConf = 0.75) {
  const k0 = Math.max(0, Math.floor((t0 - mel.t0) / mel.hop));
  const k1 = Math.min(mel.f0.length - 1, Math.ceil((t1 - mel.t0) / mel.hop));
  let c = 0;
  for (let k = k0; k <= k1; k++) if (mel.f0[k] && mel.conf[k] >= minConf) c++;
  return k1 >= k0 ? c / (k1 - k0 + 1) : 0;
}

const snapToScale = (m, pcs) => {
  let best = m, bd = Infinity;
  for (let d = -6; d <= 6; d++) {
    const c = Math.round(m) + d;
    if (pcs.includes(((c % 12) + 12) % 12) && Math.abs(c - m) < bd) { bd = Math.abs(c - m); best = c; }
  }
  return best;
};

// Assign one pitch per note from the original vocal melody; each note carries the song-time
// window [ma, mb) of the vocal line it borrows its pitch from.
export function assignPitches(notes, mel, { beatDur, scalePcs, tonic, voiceMidi }) {
  const raw = notes.map((nt) => {
    const a = nt.ma, b = Math.max(nt.mb, a + 0.08);
    let m = pitchUnder(mel, a, b);
    if (m == null) m = pitchUnder(mel, a - beatDur / 2, b + beatDur / 2);
    return m;
  });
  // Fill gaps from neighbours, then the tonic.
  for (let i = 0; i < raw.length; i++) if (raw[i] == null) raw[i] = raw[i - 1] ?? null;
  for (let i = raw.length - 1; i >= 0; i--) if (raw[i] == null) raw[i] = raw[i + 1] ?? null;
  const fromSong = raw.map((m) => m != null);
  // Fold octave errors (and backing-vocal jumps) to within a sixth of the line's centre.
  const known = raw.filter((m) => m != null);
  const centre = known.length ? median(known) : 60 + tonic;
  const folded = raw.map((m) => {
    if (m == null) return m;
    while (m - centre > 7) m -= 12;
    while (centre - m > 7) m += 12;
    return m;
  });
  const pitches = folded.map((m) => snapToScale(m ?? 60 + tonic, scalePcs));
  // Move by octaves to sit near the TTS voice, so PSOLA shifts stay small.
  const med = median(pitches);
  const k = Math.round((voiceMidi + 2 - med) / 12);
  return { pitches: pitches.map((m) => m + 12 * k), octave: k, fromSong };
}

// ---------------------------------------------------------------- TD-PSOLA
function pitchMarks(x, sr, tr) {
  const f0 = cleanTrack(tr.f0);
  const fAt = (pos) => {
    const k = Math.round((pos / sr - tr.t0) / tr.hop);
    return k >= 0 && k < f0.length ? f0[k] : 0;
  };
  const marks = [];
  const uvP = Math.round(0.005 * sr);
  let pos = 0, prevVoiced = false;
  while (pos < x.length) {
    const f = fAt(pos);
    if (f > 0) {
      const P = sr / f;
      // Align epochs to waveform peaks so successive grains stay in phase.
      const lo = Math.round(prevVoiced ? pos - 0.2 * P : pos), hi = Math.round(pos + (prevVoiced ? 0.2 : 1) * P);
      let best = Math.max(0, Math.min(x.length - 1, lo));
      for (let j = Math.max(0, lo); j < Math.min(x.length, hi); j++) if (x[j] > x[best]) best = j;
      if (marks.length && best <= marks[marks.length - 1].pos) best = Math.round(marks[marks.length - 1].pos + P);
      marks.push({ pos: best, P, voiced: true });
      pos = best + P;
      prevVoiced = true;
    } else {
      marks.push({ pos: Math.round(pos), P: uvP, voiced: false });
      pos += uvP;
      prevVoiced = false;
    }
  }
  return marks;
}

const hannCache = new Map();
function hann(L) {
  let w = hannCache.get(L);
  if (!w) {
    w = new Float32Array(L);
    for (let i = 0; i < L; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / L);
    hannCache.set(L, w);
  }
  return w;
}

// segs: [{ s0, s1 (seconds in x), t (seconds in output), dur, midi, prevMidi }]
export function psola(x, sr, tr, segs, outDur, { vibrato = 0.25, glide = 0.035, maxStretch = 2.2 } = {}) {
  const marks = pitchMarks(x, sr, tr);
  const out = new Float32Array(Math.ceil(outDur * sr) + sr);
  const nearestMark = (p) => {
    let lo = 0, hi = marks.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (marks[m].pos <= p) lo = m; else hi = m; }
    return Math.abs(marks[lo].pos - p) <= Math.abs(marks[hi].pos - p) ? marks[lo] : marks[hi];
  };
  segs.forEach((sg, si) => {
    const srcA = sg.s0 * sr, srcB = sg.s1 * sr;
    const full = sg.dur * sr;
    // Don't smear a short syllable over a long note: sing it at most `maxStretch` long, then rest.
    const L = Math.min(full, (srcB - srcA) * maxStretch);
    const outA = sg.t * sr;
    const next = segs[si + 1];
    const gapAfter = !next || next.t * sr > outA + L + 1;
    const fadeOut = gapAfter ? Math.min(L * 0.3, 0.03 * sr) : 0;
    let tout = 0;
    while (tout < L) {
      const sec = tout / sr;
      let midi = sg.midi;
      if (sg.prevMidi != null && sec < glide) midi = sg.prevMidi + (sg.midi - sg.prevMidi) * (sec / glide);
      if (sec > 0.25) midi += vibrato * Math.sin(2 * Math.PI * 5.5 * (sec - 0.25)) * Math.min(1, (sec - 0.25) / 0.2);
      const srcPos = srcA + (tout / L) * (srcB - srcA);
      const m = nearestMark(srcPos);
      const step = m.voiced ? sr / midiToHz(midi) : m.P;
      const P = Math.round(m.P);
      const w = hann(2 * P);
      const gain = Math.min(2, Math.max(0.5, step / P)) * (fadeOut && tout > L - fadeOut ? (L - tout) / fadeOut : 1);
      const c = Math.round(outA + tout);
      for (let j = -P; j < P; j++) {
        const si2 = m.pos + j, oi = c + j;
        if (si2 < 0 || si2 >= x.length || oi < 0 || oi >= out.length) continue;
        out[oi] += x[si2] * w[j + P] * gain;
      }
      tout += step;
    }
  });
  return out;
}

export function rmsOf(x) {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-4) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}
