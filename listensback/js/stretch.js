// WSOLA time-stretch (waveform-similarity overlap-add).
// Replaces Unity's "speed up the AudioSource + pitch-shifter effect on the mixer" trick:
// we stretch offline to `factor` × the original length, keeping pitch, then the caller
// resamples with playbackRate to get the final tempo/pitch combination.

const N = 1024;   // frame size
const HS = N / 2; // synthesis hop (50% overlap; Hann windows sum to 1)
const TOL = 256;  // search tolerance in samples

let hann = null;
function window() {
  if (!hann) {
    hann = new Float32Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  }
  return hann;
}

export function stretchBuffer(ctx, buf, factor) {
  if (Math.abs(factor - 1) < 1e-3) return buf;
  const inLen = buf.length;
  const chs = buf.numberOfChannels;
  const ins = [];
  for (let c = 0; c < chs; c++) ins.push(buf.getChannelData(c));

  // Mono guide signal for alignment search.
  const mono = new Float32Array(inLen);
  for (let c = 0; c < chs; c++) {
    const d = ins[c];
    for (let i = 0; i < inLen; i++) mono[i] += d[i] / chs;
  }

  const outLen = Math.max(1, Math.ceil(inLen * factor));
  const out = ctx.createBuffer(chs, outLen, buf.sampleRate);
  const outs = [];
  for (let c = 0; c < chs; c++) outs.push(out.getChannelData(c));

  const win = window();
  const ha = HS / factor;
  const maxStart = Math.max(0, inLen - N);
  let prev = 0;

  for (let k = 0; k * HS < outLen; k++) {
    const outPos = k * HS;
    let start = 0;
    if (k > 0) {
      const nominal = Math.min(maxStart, Math.round(k * ha));
      const natural = prev + HS;
      start = nominal;
      if (natural + N <= inLen) {
        const lo = Math.max(0, nominal - TOL);
        const hi = Math.min(maxStart, nominal + TOL);
        let best = -Infinity;
        for (let s = lo; s <= hi; s += 2) {
          let corr = 0;
          for (let i = 0; i < N; i += 4) corr += mono[s + i] * mono[natural + i];
          if (corr > best) { best = corr; start = s; }
        }
      }
    }
    for (let c = 0; c < chs; c++) {
      const o = outs[c], src = ins[c];
      for (let i = 0; i < N; i++) {
        const oi = outPos + i, si = start + i;
        if (oi >= outLen || si >= inLen) break;
        // First frame: no fade-in, so the ringtone's attack stays crisp.
        const w = k === 0 && i < HS ? 1 : win[i];
        o[oi] += w * src[si];
      }
    }
    prev = start;
  }
  return out;
}
