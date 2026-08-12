/*
 * StoryMode entry point: wires the meteor field, the music engine, and the
 * landing UI together on /storymode/.
 */
(function () {
  'use strict';

  // Intro timing (ms). MASK_FADE must match the CSS transition on .story-mask.
  var MASK_HOLD = 600;    // sit on pure black before the reveal begins
  var MASK_FADE = 4500;   // slow "waking from a dream" fade (CSS transition)
  // The ease-out curve makes the black look gone ~40% into the transition,
  // well before it technically finishes — so time the scene from that
  // perceived clear, not the full duration (otherwise the first glider feels
  // seconds late).
  var REVEAL_CLEARED = MASK_HOLD + MASK_FADE * 0.4;
  var SCENE_DELAY = 0;    // beat after the black clears before the first glider
  var LEAD_GAP = 2600;    // between the two slow lead-in gliders
  var RAMP_START = 4200;  // after scene start, when the rest begin drifting in
  var RAMP_STEP = 650;    // spacing between each of the remaining meteors

  document.addEventListener('DOMContentLoaded', function () {
    var canvas = document.getElementById('meteor-field');
    var field = new window.StoryMode.MeteorField(canvas, { count: 9 });

    var colors = window.StoryMode.Colors;
    var music = new window.StoryMode.MusicEngine();
    music.onNote(function (value) {
      // Each note drops a ripple on the surface, somewhere in the calm
      // middle band of the screen.
      var x = field.width * (0.15 + Math.random() * 0.7);
      var y = field.height * (0.2 + Math.random() * 0.55);
      var color = value.note.indexOf('4') > -1 ? colors.YELLOW : colors.BLUE;
      field.spawnRipple(x, y, color, 60 + Math.random() * 120);
    });

    var landing = document.getElementById('story-landing');
    var controls = document.getElementById('story-controls');
    var enterBtn = document.getElementById('story-enter');
    var playPauseBtn = document.getElementById('story-playpause');
    var exitLink = document.getElementById('story-exit');
    var mask = document.getElementById('story-mask');

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Dialogue reveal is locked to the music: one syllable is revealed and
    // sounded per grid tick. GRID sets that tick (a 32nd note here → ~89ms at
    // 84 BPM, brisk speech) and thus the reading pace. The clock is a thin
    // wrapper over the shared transport — the same global BPM
    // (Tone.Transport.bpm) the music engine sets.
    var GRID = '32n';
    var clock = {
      _id: null,
      start: function (cb) {
        if (this._id !== null) return;
        this._id = Tone.Transport.scheduleRepeat(function (time) { cb(time); }, GRID);
      },
      stop: function () {
        if (this._id !== null) { Tone.Transport.clear(this._id); this._id = null; }
      },
      draw: function (fn, time) { Tone.Draw.schedule(fn, time); }
    };

    // Voice + clock are attached once Tone's context is live (after Start).
    var dialogue = new window.StoryMode.DialogueSystem({
      box: document.getElementById('story-dialogue'),
      nameEl: document.getElementById('story-dialogue-name'),
      textEl: document.getElementById('story-dialogue-text'),
      nextEl: document.getElementById('story-dialogue-next'),
      script: window.StoryMode.script,
      clock: clock,
      // Rests are counted in grid ticks (32nds). Long, exaggerated breaths
      // between sentences; a shorter beat between phrases/clauses.
      rests: { sentence: 20, clause: 8 }
    });

    // A soft, short "spoken" blip. PolySynth so rapid syllables don't clip
    // each other; triangle wave + fast envelope keeps it gentle, not beepy.
    // blipAt(time) sounds it exactly on a grid tick; blip() is the immediate
    // fallback used when there's no clock.
    function makeVoice() {
      var synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 }
      }).toDestination();
      synth.volume.value = -11;
      var notes = ['C5', 'D5', 'E5', 'G5', 'B4'];
      function pick() { return notes[Math.floor(Math.random() * notes.length)]; }
      return {
        blip: function () { synth.triggerAttackRelease(pick(), 0.045); },
        blipAt: function (time) { synth.triggerAttackRelease(pick(), 0.045, time); }
      };
    }

    function revealControls() {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          controls.classList.add('is-visible');
        });
      });
    }

    // Scripted opening: one slow glider crosses the empty water, then a
    // second, and only then does the usual population drift in one at a time.
    function beginScene() {
      field.start();
      field.addMeteor({ slow: true, delay: 0 });
      setTimeout(function () { field.addMeteor({ slow: true, delay: 0 }); }, LEAD_GAP);
      setTimeout(function () {
        var remaining = field.count - field.meteors.length;
        for (var i = 0; i < remaining; i++) {
          setTimeout(function () { field.addMeteor(); }, i * RAMP_STEP);
        }
      }, RAMP_START);
    }

    // The whole scene is already laid out behind the mask; we just fade the
    // mask away — slowly, like drifting awake — rather than animating each
    // element in on its own. Meteors are held back until just after the
    // reveal completes, so the scene opens on quiet, empty black.
    if (reduceMotion) {
      mask.style.transition = 'none';
      mask.classList.add('is-hidden');
      field.start();
      field.populate ? field.populate() : field.addMeteor();
      revealControls();
    } else {
      setTimeout(function () { mask.classList.add('is-hidden'); }, MASK_HOLD);
      setTimeout(revealControls, REVEAL_CLEARED);
      setTimeout(beginScene, REVEAL_CLEARED + SCENE_DELAY);
    }

    function startMusic() {
      music.init();
      music.loadPlaceholderMelody();
      return music.play().then(function () {
        playPauseBtn.textContent = '❚❚';
      });
    }

    enterBtn.addEventListener('click', function () {
      playPauseBtn.hidden = false;
      landing.classList.add('is-hidden');
      startMusic().then(function () {
        dialogue.voice = makeVoice();
        dialogue.start();
      });
    });

    playPauseBtn.addEventListener('click', function () {
      // May be pressed before Enter (it's revealed with the rest of the
      // controls), so start the engine on first press if needed.
      if (!music.synth) {
        startMusic();
        return;
      }
      music.toggle().then(function () {
        playPauseBtn.textContent = music.playing ? '❚❚' : '▶';
      });
    });

    exitLink.addEventListener('click', function (event) {
      event.preventDefault();
      var target = exitLink.getAttribute('href');
      try { sessionStorage.setItem('aw-return-fade', '1'); } catch (e) {}

      if (reduceMotion) {
        window.location.href = target;
        return;
      }

      // Reuse the same mask to fade back to black before leaving, faster
      // than the slow entrance reveal.
      mask.style.transitionDuration = '0.9s';
      mask.classList.remove('is-hidden');
      setTimeout(function () { window.location.href = target; }, 900);
    });
  });
})();
