/*
 * StoryMode.DialogueSystem — a visual-novel text engine whose reveal is
 * locked to the music.
 *
 * Both the text and the "voice" are driven by ONE musical clock: on each grid
 * tick (see the clock passed from main.js — a 16th note on the shared
 * transport) exactly one syllable chunk is revealed AND its blip is sounded,
 * at the same scheduled time. That's why they stay in sync — they're the same
 * event, not two timers racing.
 *
 * Syllable chunks are produced by a self-contained grapheme heuristic, with
 * RiTa (window.RiTa, if loaded) refining the count so blips ≈ real syllables.
 *
 * Audio is injected as a `voice` ({ blip(), blipAt(time) }) and the grid as a
 * `clock` ({ start(cb), stop(), draw(fn, time) }), so this file never touches
 * Tone.js directly and degrades to a plain timer if no clock is given.
 */
(function (global) {
  'use strict';

  var VOWELS = 'aeiouy';
  function isV(c) { return VOWELS.indexOf(c) !== -1; }

  // Split one word into grapheme syllable chunks. Heuristic: one chunk per
  // vowel group, breaking the consonants between groups (V-CV, VC-CV, V-V).
  // RiTa then trims any overcount (silent-e, dipthongs) by merging the tail.
  function splitWord(word) {
    var lw = word.toLowerCase();
    var groups = [];
    for (var i = 0; i < lw.length; i++) {
      if (isV(lw[i]) && (i === 0 || !isV(lw[i - 1]))) groups.push(i);
    }
    if (groups.length <= 1) return [word];

    var bounds = [];
    for (var g = 0; g < groups.length - 1; g++) {
      var j = groups[g];
      while (j + 1 < lw.length && isV(lw[j + 1])) j++;  // end of this vowel run
      var consStart = j + 1;
      var nextV = groups[g + 1];
      var k = nextV - consStart;                        // consonants in between
      var boundary;
      if (k <= 0) boundary = nextV;                     // hiatus  V-V
      else if (k === 1) boundary = nextV;               // V-CV
      else boundary = consStart + 1;                    // VC-C..V
      bounds.push(boundary);
    }

    var chunks = [], start = 0;
    for (var b = 0; b < bounds.length; b++) { chunks.push(word.slice(start, bounds[b])); start = bounds[b]; }
    chunks.push(word.slice(start));

    if (global.RiTa && chunks.length > 1) {
      try {
        var syl = global.RiTa.syllables(lw);
        if (syl) {
          var target = (syl.match(/\//g) || []).length + 1;
          while (chunks.length > target && chunks.length > 1) {
            var last = chunks.pop();
            chunks[chunks.length - 1] += last;
          }
        }
      } catch (e) { /* fall back to the heuristic split */ }
    }
    return chunks;
  }

  // Turn a line into an ordered list of reveal steps. Syllable steps carry a
  // blip; separators (spaces/punctuation) fold into the previous step's text;
  // punctuation adds empty "rest" steps that just consume grid ticks (pauses).
  // Each step also stores the cumulative visible text, so revealing is just a
  // textContent assignment.
  function buildSteps(text, rests) {
    rests = rests || {};
    var sentence = rests.sentence || 4;
    var clause = rests.clause || 2;
    var steps = [];
    var re = /([A-Za-z']+)|([^A-Za-z']+)/g;
    var m;
    while ((m = re.exec(text))) {
      if (m[1]) {
        var chunks = splitWord(m[1]);
        for (var c = 0; c < chunks.length; c++) steps.push({ text: chunks[c], blip: true });
      } else {
        var sep = m[2];
        if (steps.length) steps[steps.length - 1].text += sep;
        else steps.push({ text: sep, blip: false });
        var n = 0;
        if (/[.!?]/.test(sep)) n = sentence;
        else if (/[,;:—]/.test(sep)) n = clause;
        for (var r = 0; r < n; r++) steps.push({ text: '', blip: false });
      }
    }
    var acc = '';
    for (var s = 0; s < steps.length; s++) { acc += steps[s].text; steps[s].shown = acc; }
    return steps;
  }

  function DialogueSystem(opts) {
    opts = opts || {};
    this.box = opts.box;
    this.nameEl = opts.nameEl;
    this.textEl = opts.textEl;
    this.nextEl = opts.nextEl;
    this.script = opts.script || [];
    this.clock = opts.clock || null;          // { start(cb), stop(), draw(fn, time) }
    this.voice = opts.voice || null;          // { blip(), blipAt(time) }
    this.revealDelay = opts.revealDelay || 750;
    this.fallbackStep = opts.fallbackStep || 180;
    this.rests = opts.rests || {};
    this.onEnd = opts.onEnd || null;

    this.index = -1;
    this.steps = [];
    this.stepPos = 0;
    this.typing = false;
    this._active = false;
    this._gen = 0;               // line generation, to drop stale scheduled draws
    this._fallbackTimer = null;

    this._onClick = this._advance.bind(this);
    this._onKey = this._onKeydown.bind(this);
    this._tick = this._tick.bind(this);
  }

  DialogueSystem.prototype.start = function () {
    if (!this.box) return;
    this.box.hidden = false;
    var self = this;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { self.box.classList.add('is-visible'); });
    });
    // Let the empty box finish its fade/slide before anything reveals, and
    // only wire up the clock + advance handlers then.
    setTimeout(function () {
      document.addEventListener('click', self._onClick);
      document.addEventListener('keydown', self._onKey);
      if (self.clock) self.clock.start(self._tick);
      else self._fallbackTimer = setInterval(self._tick, self.fallbackStep);
      self.next();
    }, this.revealDelay);
  };

  DialogueSystem.prototype._onKeydown = function (e) {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') {
      e.preventDefault();
      this._advance();
    }
  };

  DialogueSystem.prototype._advance = function (e) {
    if (e && e.target && e.target.closest && e.target.closest('#story-controls')) return;
    if (this.typing) { this._finishLine(); return; }
    this.next();
  };

  DialogueSystem.prototype.next = function () {
    this.index++;
    if (this.index >= this.script.length) { this._end(); return; }
    var line = this.script[this.index];
    this._gen++;

    var name = line && line.name ? line.name : '';
    if (name) { this.nameEl.textContent = name; this.nameEl.hidden = false; }
    else { this.nameEl.hidden = true; }

    this.steps = buildSteps((line && line.text) || '', this.rests);
    this.stepPos = 0;
    this.textEl.textContent = '';
    this.nextEl.classList.remove('is-ready');
    this.typing = true;
    this._active = true;   // the already-running clock will pick this up
  };

  // Apply a reveal, ignoring draws left over from a previous line and never
  // shrinking the visible text (so a snap-to-full can't be undone by a late
  // in-flight draw).
  DialogueSystem.prototype._setText = function (s, gen) {
    if (gen !== this._gen) return;
    if (s.length >= this.textEl.textContent.length) this.textEl.textContent = s;
  };

  DialogueSystem.prototype._tick = function (time) {
    if (!this._active) return;
    if (this.stepPos >= this.steps.length) { this._lineDone(); return; }
    var step = this.steps[this.stepPos++];
    var self = this, gen = this._gen, shown = step.shown;

    if (this.clock && typeof time === 'number') {
      // Sound the blip at the exact grid time and paint the text at the same
      // audio-synced moment — one event, so they can never drift apart.
      this.clock.draw(function () { self._setText(shown, gen); }, time);
      if (step.blip && this.voice && this.voice.blipAt) this.voice.blipAt(time);
    } else {
      this._setText(shown, gen);
      if (step.blip && this.voice && this.voice.blip) this.voice.blip();
    }
  };

  DialogueSystem.prototype._finishLine = function () {
    var full = this.steps.length ? this.steps[this.steps.length - 1].shown : this.textEl.textContent;
    this.stepPos = this.steps.length;
    this._active = false;
    this.textEl.textContent = full;
    this._lineDone();
  };

  DialogueSystem.prototype._lineDone = function () {
    this.typing = false;
    this._active = false;
    this.nextEl.classList.add('is-ready');
  };

  DialogueSystem.prototype._end = function () {
    document.removeEventListener('click', this._onClick);
    document.removeEventListener('keydown', this._onKey);
    if (this.clock) this.clock.stop();
    if (this._fallbackTimer) { clearInterval(this._fallbackTimer); this._fallbackTimer = null; }
    this.box.classList.remove('is-visible');
    var box = this.box;
    setTimeout(function () { box.hidden = true; }, 800);
    if (this.onEnd) this.onEnd();
  };

  global.StoryMode = global.StoryMode || {};
  global.StoryMode.DialogueSystem = DialogueSystem;
})(window);
