/*
 * Poster → play video player. A .vplayer element shows a teaser poster with a
 * play button; on click it swaps in a real <video> from data-video. If that
 * file is missing/unplayable, it falls back to the paper's YouTube embed
 * (data-youtube). Autoplay-with-sound is allowed because activation is a user
 * click. Shared by /home/ and the project pages.
 */
(function () {
  'use strict';

  function youtubeFallback(el, id) {
    if (!id) { return; }
    var frame = document.createElement('div');
    frame.className = 'vplayer-frame';
    var iframe = document.createElement('iframe');
    var start = el.getAttribute('data-start');
    iframe.src = 'https://www.youtube.com/embed/' + id + '?autoplay=1&rel=0' +
      (start ? '&start=' + encodeURIComponent(start) : '');
    iframe.title = 'Video';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.setAttribute('allowfullscreen', '');
    frame.appendChild(iframe);
    el.innerHTML = '';
    el.appendChild(frame);
  }

  function activate(el) {
    if (el.dataset.active) { return; }
    el.dataset.active = '1';

    var src = el.getAttribute('data-video');
    var yt = el.getAttribute('data-youtube');

    if (!src) { youtubeFallback(el, yt); return; }

    var video = document.createElement('video');
    video.className = 'vplayer-media';
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    var fellBack = false;
    video.addEventListener('error', function () {
      if (!fellBack) { fellBack = true; youtubeFallback(el, yt); }
    });

    el.innerHTML = '';
    el.appendChild(video);
    var p = video.play();
    if (p && p.catch) { p.catch(function () {}); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var players = document.querySelectorAll('.vplayer');
    for (var i = 0; i < players.length; i++) {
      (function (el) {
        el.addEventListener('click', function () { activate(el); });
      })(players[i]);
    }
  });
})();
