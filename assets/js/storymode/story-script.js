/*
 * StoryMode narrative script.
 *
 * This is intentionally a plain data file, separate from all engine code, so
 * a future authoring tool (the planned local editor) can regenerate it
 * without touching logic. Each entry is one dialogue beat:
 *
 *   {
 *     name: "",        // optional speaker label shown above the text ("" = none)
 *     text: "..."      // the line; typed out one character at a time
 *   }
 *
 * Lines advance on click / Space / Enter. Syllables (vowel groups) drive the
 * spoken "voice" blips — see dialogue.js.
 */
(function (global) {
  'use strict';

  global.StoryMode = global.StoryMode || {};
  global.StoryMode.script = [
    { name: "", text: "You've crossed over. Give your eyes a moment to adjust to the dark." },
    { name: "", text: "This is the other side of my work — the part that never quite fits in a paper." },
    { name: "", text: "I study media that pays attention. Music that bends toward the moment you're living in." },
    { name: "", text: "Every light drifting past is one of those ideas, still taking shape." },
    { name: "", text: "Stay as long as you like. Let it move around you." }
  ];
})(window);
