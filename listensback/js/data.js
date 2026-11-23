// Static data ported from the Unity project (MusicNotification/Assets).
// Song values come from each scene's beatTracking/tempoAdjustment components;
// ringtone values come from the tempoAdjustment/notification components per app.

export const ASSETS = new URL('../assets/', import.meta.url).href; // resolves from this file, so pages elsewhere can use the engine

// Camelot index (1-12) -> major key name / relative minor (tempoAdjustment.cs majorKeyNames).
export const KEY_MAJOR = ['B', 'F♯', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E'];
export const KEY_MINOR = ['G♯m', 'E♭m', 'B♭m', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F♯m', 'C♯m'];
// Semitones above C for each Camelot major key (tempoAdjustment.cs majorMap).
export const MAJOR_MAP = [11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4];

export const keyLabel = (k) => `${KEY_MAJOR[k - 1]} / ${KEY_MINOR[k - 1]}`;

export const SONGS = [
  { id: 'blinding', dir: 'blinding lights', title: 'Blinding Lights', artist: 'The Weeknd', bpm: 85.46, key: 6, firstBeat: 0 },
  { id: 'counting', dir: 'counting stars', title: 'Counting Stars', artist: 'OneRepublic', bpm: 122.33, key: 11, firstBeat: 2 },
  { id: 'happy', dir: 'happy', title: 'Happy', artist: 'Pharrell Williams', bpm: 161.93, key: 4, firstBeat: 1 },
  { id: 'never', dir: 'never', title: 'Never Gonna Give You Up', artist: 'Rick Astley', bpm: 113, key: 3, firstBeat: 0, vocals: 'vocals.mp3', acc: 'accompaniment.mp3' },
  { id: 'nothing', dir: 'nothing on you', title: "Nothin' on You", artist: 'B.o.B ft. Bruno Mars', bpm: 104, key: 6, firstBeat: 0, vocals: 'vocals 1.mp3' },
  { id: 'september', dir: 'september', title: 'September', artist: 'Earth, Wind & Fire', bpm: 126.51, key: 11, firstBeat: 2 },
  { id: 'somebody', dir: 'used to know', title: 'Somebody That I Used to Know', artist: 'Gotye', bpm: 129.14, key: 5, firstBeat: 2, vocals: 'vocal normalized.mp3', acc: 'accomp normalized.mp3' },
  { id: 'toxic', dir: 'toxic', title: 'Toxic', artist: 'Britney Spears', bpm: 143.02, key: 5, firstBeat: 0 },
  { id: 'whatislove', dir: 'whatislove', title: 'What Is Love', artist: 'Haddaway', bpm: 123.86, key: 6, firstBeat: 2 },
  { id: 'brightside', dir: 'brightside', title: 'Mr. Brightside', artist: 'The Killers', bpm: 147.95, key: 2, firstBeat: 1 },
  { id: 'mountain', dir: 'high enough', title: "Ain't No Mountain High Enough", artist: 'Marvin Gaye & Tammi Terrell', bpm: 129.68, key: 9, firstBeat: 0 },
  { id: 'hotline', dir: 'hotline', title: 'Hotline Bling', artist: 'Drake', bpm: 135.14, key: 7, firstBeat: 0 },
];

export const TIMBRES = [
  { id: 'original', label: 'Original' },
  { id: 'piano', label: 'Piano' },
  { id: 'violin', label: 'Violin' },
  { id: 'synth', label: 'Synth' },
];

const R = 'notifications/ringtones/';
const letter = (t) => t[0]; // piano -> p, violin -> v, synth -> s
const Cap = (t) => t[0].toUpperCase() + t.slice(1);

// tempos: the pre-rendered tempo variants; orig: which of them is the unaltered ringtone (default 0); keys: Camelot keys the (scale-ambiguous)
// ringtone fits; native: the tempo the ringtone plays at on a real phone (the unadapted version is
// played at this tempo, stretched from the closest pre-rendered file); length: ringtone length in song beats; pickup: beats before the downbeat.
export const RINGTONES = [
  {
    id: 'discord', name: 'Discord', color: '#8b93ff', tempos: [120, 150, 180], native: 180, keys: [8, 9, 10], length: 16, pickup: 0,
    file: (tb, t) => tb === 'original' ? `${R}discord/discord${t}.mp3` : `${R}discord/alt/${letter(tb)}discord${t}.mp3`,
  },
  {
    id: 'hangouts', name: 'Hangouts', color: '#3ecf8e', tempos: [120, 145, 180], keys: [10, 11, 12], length: 8, pickup: 0,
    file: (tb, t) => tb === 'original'
      ? (t === 145 ? `${R}hangout/hangout ringtone145.mp3` : `${R}hangout/hangout${t}.mp3`)
      : `${R}hangout/alttimbre/${letter(tb)}hangout${t}.mp3`,
  },
  {
    id: 'iphone', name: 'iPhone', color: '#ff9f5a', tempos: [120, 140, 160], native: 135, keys: [6, 7], length: 8, pickup: 2,
    file: (tb, t) => tb === 'original'
      ? (t === 120 ? `${R}iphone/iphone120loop.mp3` : `${R}iphone/iphone${t}.mp3`)
      : `${R}iphone/timbre/${Cap(tb)}/${Cap(tb)[0]}iphone${t}.mp3`,
  },
  {
    id: 'skype', name: 'Skype', color: '#4fc3f7', tempos: [100, 130, 160], keys: [6, 5], length: 8, pickup: 2,
    file: (tb, t) => tb === 'original' ? `${R}skype/skype${t}.mp3` : `${R}skype/alt/${letter(tb)}skype${t}.mp3`,
  },
  {
    id: 'classic', name: 'Classic Phone', color: '#f06292', tempos: [120, 150, 180], native: 175, keys: [8, 9, 10], length: 8, pickup: 0,
    file: (tb, t) => tb === 'original' ? `${R}iphone classic/iphoneclassic${t}.mp3` : `${R}iphone classic/classic${letter(tb).toUpperCase()}${t}.mp3`,
  },
  {
    id: 'line', name: 'LINE', color: '#c5e86c', tempos: [120, 150, 175], keys: [8, 9, 10], length: 8, pickup: 0,
    file: (tb, t) => tb === 'original' ? `${R}line/line${t}.mp3` : `${R}line/long/line${letter(tb).toUpperCase()}${t}.mp3`,
  },
];

export const SCHEDULES = [
  { id: 'now', label: 'Immediately' },
  { id: 'beat', label: 'Next beat' },
  { id: 'bar', label: 'Next bar' },
  { id: 'phrase', label: 'Next phrase' },
  { id: 'quiet', label: 'Quietest spot' },
];

// Parameter defaults mirror parameterControl.cs ranges. The urgency presets follow the
// commented-out urgencyPreset logic in parameterControl.cs (low = blend in, high = cut through)
// plus a "conventional" baseline: ring now and fade the music out.
const BASE = {
  beatMatch: false, keyMatch: false, timbre: 'original', schedule: 'now', repeats: 4,
  volume: 30, fadeIn: false, fadeInSpeed: 0.05, adaptive: 0,
  duckVocals: false, duckSong: false,
  pan: 0, reverbDecay: 2, reverbMix: 0, lowpass: 20000, highpass: 10,
};

export const PRESETS = [
  {
    id: 'conventional', label: 'Conventional', tag: 'Baseline: today’s phones',
    blurb: 'How phones ring today: right away, in its own tempo and key, with the music faded out.',
    params: { ...BASE, schedule: 'now', duckVocals: true, duckSong: true },
  },
  {
    id: 'subtle', label: 'Subtle', tag: 'Low urgency',
    blurb: 'Matched to the tempo and key, waits for the next phrase, and stays tucked into the mix like another instrument.',
    params: { ...BASE, beatMatch: true, keyMatch: true, timbre: 'original', schedule: 'phrase', volume: 24, fadeIn: true, fadeInSpeed: 0.02, adaptive: 5, pan: 12, reverbDecay: 3, reverbMix: 350, lowpass: 7000, highpass: 150 },
  },
  {
    id: 'balanced', label: 'Balanced', tag: 'Medium urgency',
    blurb: 'Tempo and key matched and on the next bar, but the singer steps aside so the ringtone takes the lead.',
    params: { ...BASE, beatMatch: true, keyMatch: true, schedule: 'bar', volume: 28, fadeIn: true, fadeInSpeed: 0.08, adaptive: 5, pan: 5, reverbMix: 120, duckVocals: true },
  },
  {
    id: 'urgent', label: 'Urgent', tag: 'High urgency',
    blurb: 'No blending: lands on the very next beat at full volume while the whole song drops away.',
    params: { ...BASE, schedule: 'beat', duckVocals: true, duckSong: true },
  },
];
