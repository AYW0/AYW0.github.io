/*
 * StoryMode.MusicEngine — thin wrapper around Tone.js Transport/Part.
 * Plays a placeholder motif on loop today; setMelody/addNote/removeNote
 * are the extension points for real-time adaptive melody generation later.
 */
(function (global) {
  'use strict';

  function MusicEngine() {
    this.synth = null;
    this.part = null;
    this.playing = false;
    this.noteListeners = [];
  }

  MusicEngine.prototype.init = function () {
    if (this.synth) return;
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.02, decay: 0.35, sustain: 0.35, release: 1.4 }
    }).toDestination();
    this.synth.volume.value = -13;

    Tone.Transport.bpm.value = 84;
    Tone.Transport.loop = true;
    Tone.Transport.loopStart = 0;
    Tone.Transport.loopEnd = '4m';
  };

  MusicEngine.prototype.loadPlaceholderMelody = function () {
    this.setMelody([
      { time: '0:0:0', note: 'A3', duration: '2n' },
      { time: '0:2:0', note: 'E4', duration: '4n' },
      { time: '0:3:0', note: 'C4', duration: '4n' },
      { time: '1:0:0', note: 'D4', duration: '2n' },
      { time: '1:2:0', note: 'A3', duration: '4n' },
      { time: '1:3:0', note: 'C4', duration: '4n' },
      { time: '2:0:0', note: 'F3', duration: '2n' },
      { time: '2:2:0', note: 'C4', duration: '4n' },
      { time: '2:3:0', note: 'E4', duration: '4n' },
      { time: '3:0:0', note: 'E3', duration: '1n' }
    ]);
  };

  // notes: array of { time, note, duration } in Tone Transport notation ("bar:beat:sixteenth").
  MusicEngine.prototype.setMelody = function (notes) {
    var self = this;
    if (this.part) this.part.dispose();
    this.part = new Tone.Part(function (time, value) {
      self.synth.triggerAttackRelease(value.note, value.duration, time);
      self.noteListeners.forEach(function (cb) {
        Tone.Draw.schedule(function () { cb(value); }, time);
      });
    }, notes);
    this.part.loop = true;
    this.part.loopEnd = '4m';
    this.part.start(0);
  };

  MusicEngine.prototype.addNote = function (note) { if (this.part) this.part.add(note); };
  MusicEngine.prototype.removeNote = function (note) { if (this.part) this.part.remove(note); };
  MusicEngine.prototype.onNote = function (cb) { this.noteListeners.push(cb); };

  MusicEngine.prototype.play = function () {
    var self = this;
    return Tone.start().then(function () {
      Tone.Transport.start();
      self.playing = true;
    });
  };

  MusicEngine.prototype.pause = function () {
    Tone.Transport.pause();
    this.playing = false;
  };

  MusicEngine.prototype.toggle = function () {
    return this.playing ? Promise.resolve(this.pause()) : this.play();
  };

  global.StoryMode = global.StoryMode || {};
  global.StoryMode.MusicEngine = MusicEngine;
})(window);
