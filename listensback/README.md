# MARingBA web demo

A browser version of the MARingBA Unity project in `../MusicNotification`. MARingBA (Music-Adaptive Ringtones for Blended Audio notifications) was published at CHI 2024 by Wang, Cheng and Lindlbauer: https://doi.org/10.1145/3613904.3642376. Pick a song, ring a notification, and switch between the conventional baseline and the adaptive styles to hear the difference.

## Run

```sh
cd web
python3 serve.py 8765   # like http.server, but tells the browser not to cache
# open http://localhost:8765
```

There is no build step and there are no dependencies. Audio comes from `web/assets`, which is a symlink to `../MusicNotification/Assets`. The page has to be served over HTTP, because opening `index.html` directly from disk won't load the audio.

## How it maps to the Unity code

| Web | Unity | What it does |
| --- | --- | --- |
| `engine.js` `loadSong` | `beatTracking.cs` | Loads the beat, downbeat, frequency-map and stereo-balance CSVs. Every 4th downbeat (offset by `firstBeat`) starts a phrase. |
| `engine.js` `matchPlan` | `tempoAdjustment.cs` | Picks the closest of the ringtone's pre-rendered tempos and the key shift with the fewest semitones (Camelot map). |
| `stretch.js` | AudioSource pitch + mixer pitch shifter | WSOLA time-stretch followed by resampling, so tempo and pitch can be set independently. |
| `engine.js` `planStart` | `nextBestBeatRingtone` / `nextBestBeat` | Schedules the ring for immediately, the next beat, the next bar or the next phrase (with pickup offset), or the "quietest spot" by spectral overlap. |
| `engine.js` `trigger` | `notification.cs` | Plays the ring and its repeats. Beat-matched repeats realign to the song's beat grid. |
| `engine.js` mix chain | `audioEffects.cs`, `muteSelf.cs` | Vocal and instrument ducking, fade-in, adaptive volume, panning that follows the music, reverb, low-pass and high-pass. |

Differences from the Unity version:
- Beat matching also considers half and double time. A slow song (Blinding Lights, 85 BPM) is paired with the ringtone's 180 BPM version played at 171 BPM, instead of slowing the 120 BPM version down to ×0.71.
- Adaptive volume is scaled up so its effect can be heard.
- Ringtone volume applies whether or not fade-in is on.
- The four style presets are approximations. They follow the commented-out `urgencyPreset` logic in `parameterControl.cs`, and their values were not taken from the paper.

## Musical assistant (`sing.html`)

A simplified version of "Towards Music-Aware Virtual Assistants" (Wang, Lindlbauer and Donahue, UIST 2024): https://doi.org/10.1145/3654777.3676416. A spoken notification is sung in place of the singer, to the song's beat and the singer's own melody. Open http://localhost:8765/sing.html.

| Step | Paper | This demo (`js/voice.js`, `js/sing.js`) |
| --- | --- | --- |
| Speech | gTTS | Presets: macOS `say -v Samantha`, pre-rendered into `tts/`. Typed text: meSpeak (eSpeak compiled to JS, `vendor/mespeak.js`) |
| Syllable onsets | Charsiu forced alignment, phonemes grouped into syllables | Prominent voiced peaks of the 250–3000 Hz loudness envelope. The count is matched to a text-based syllable estimate |
| Melody | Anticipatory Music Transformer fine-tuned on Hooktheory, one note per syllable within ±1/16 of the speech timing | The speech timing is snapped to the nearest 16th note from the next downbeat. Each note takes the pitch the original singer sings at that moment, from YIN on the separated vocal stem, snapped to the key. If nobody sings in those bars, the melody is borrowed from the nearest bars where someone does |
| Voice | TD-PSOLA on the TTS audio | TD-PSOLA in JS, with a short glide and light vibrato |
| Mix | Spleeter vocals replaced, accompaniment slightly lowered | The existing vocal stem is muted for those bars, and the band is lowered 3 dB |

To re-render a preset message: `say -v Samantha -r 170 -o tts/<id>.wav --data-format=LEI16@22050 "<text>"`, then add it to `MESSAGES` in `js/sing.js`. meSpeak is GPL-licensed.

## RISE workout demo (`rise.html`)

An interactive version of "RISE: Adaptive Music Playback for Realtime Intensity Synchronization with Exercise" (Wang, Donahue and Jain, ISMIR 2025): https://arxiv.org/abs/2509.17112. Open http://localhost:8765/rise.html, pick a song and press Play. Steer the song with **Loop** (`L`), **Skip ahead** (`S`) and **Play normally** (`N`). The athlete follows the music: it squats on the beat while a high-intensity section plays, sits down to rest when the music is calm, and shows each rep count in a speech bubble.

- Data: `web/rise-assets` is a symlink to `../rise-unity/segmentation/Cutpoints/Assets/music`, which was extracted from `RISE-unity.zip`. Each song folder holds `beat_times.csv` and `combined_segments.json`. The segment start and end and the transition pairs are beat indices.
- Songs: `js/rise-songs.json`. "User study songs" are the 12 listed in `Scenes/participant.unity`. The rest are the 25-song pool in `Scenes/Main.unity`.
- Cuts follow `AudioController.cs`:
  - Only the study's in-section cutpoints are used.
  - Each pair works in both directions.
  - Loop takes the longest backward jump, and Skip the longest forward jump.
  - At the end of the song it starts again.
- Audio: there are no filters, compression or time-stretching. Cuts are sample-scheduled with a 25 ms crossfade.

## Story (`story.html`)

A short interactive story that ties the three projects together in one line-drawn living room (three.js, `js/story-scene.js`): navy outlines with halftone-dot shading, drag to look around, pointer parallax, hover the speakers to see what is playing. A narrator walks through four beats, each with a jarring "today" version and the adapted version, using the real systems: MARingBA ringtones (`engine.js`), a sung voice-assistant message (`voice.js`, the flight reminder), and a RISE loop on HUMBLE. that keeps the chorus going through a squat set.

The songs are copyrighted and are for local research use only. Don't host this publicly with the music included.
