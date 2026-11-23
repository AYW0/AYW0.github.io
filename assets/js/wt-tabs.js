// Step-by-step walkthroughs (.wt.tabbed) shown one step at a time, with numbered tabs.
(function () {
  'use strict';
  document.querySelectorAll('.wt.tabbed').forEach(function (wt) {
    var steps = [].slice.call(wt.querySelectorAll('.wt-step'));
    var nav = document.createElement('div'); nav.className = 'wt-nav';
    steps.forEach(function (st, i) {
      var b = document.createElement('button'); b.type = 'button';
      var t = st.querySelector('.wt-title');
      b.innerHTML = '<span>' + (i + 1) + '</span>' + (t ? t.textContent : 'Step ' + (i + 1));
      b.addEventListener('click', function () { show(i); });
      nav.appendChild(b);
    });
    wt.insertBefore(nav, wt.firstChild);
    function show(i) {
      steps.forEach(function (st, k) { st.hidden = k !== i; });
      [].slice.call(nav.children).forEach(function (b, k) { b.classList.toggle('on', k === i); });
      wt.querySelectorAll('audio').forEach(function (a) { a.pause(); });
    }
    show(0);
  });
})();
