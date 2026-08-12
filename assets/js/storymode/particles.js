/*
 * StoryMode.MeteorField — sparse dark-sky particle field: thick, glowing,
 * gently curving trails (traced from each meteor's real path) with a cheap
 * two-pass bloom. Standalone canvas 2D system, no dependencies. Used only
 * on /storymode/.
 */
(function (global) {
  'use strict';

  var BG = '5,7,13';

  // Weighted palette: mostly blues (dark navy through bright cyan/teal),
  // some warm gold/orange. Each pick gets its own small per-channel jitter
  // so no two meteors are quite the same hue.
  var PALETTE = [
    { c: [45, 80, 175], w: 3 },   // dark/deep blue
    { c: [110, 195, 255], w: 4 }, // bright blue
    { c: [70, 215, 195], w: 2 },  // teal / blue-green
    { c: [255, 170, 60], w: 2 },  // orange/gold
    { c: [255, 214, 140], w: 1 } // pale warm gold
  ];
  var PALETTE_TOTAL = PALETTE.reduce(function (s, p) { return s + p.w; }, 0);

  function rand(min, max) { return min + Math.random() * (max - min); }
  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

  function pickColor() {
    var r = Math.random() * PALETTE_TOTAL;
    var chosen = PALETTE[0].c;
    for (var i = 0; i < PALETTE.length; i++) {
      r -= PALETTE[i].w;
      if (r <= 0) { chosen = PALETTE[i].c; break; }
    }
    return [
      clamp255(chosen[0] + rand(-14, 14)),
      clamp255(chosen[1] + rand(-14, 14)),
      clamp255(chosen[2] + rand(-14, 14))
    ];
  }

  function Meteor(field, opts) {
    this.field = field;
    this.opts = opts || {};
    this.reset();
    // Gentle stagger for the first appearance so they trickle in rather than
    // arriving all at once. Callers can override (e.g. delay:0 for the
    // scripted lead-in gliders). The big "hold until after the intro fade"
    // wait is handled by the caller deferring field.start().
    this.delay = (this.opts.delay != null) ? this.opts.delay : rand(0, 200);
  }

  Meteor.prototype.reset = function () {
    var w = this.field.width, h = this.field.height;
    this.baseAngle = rand(15, 50) * (Math.PI / 180);
    // Lead-in gliders run slow; the rest span the full speed range.
    this.speed = this.opts.slow ? rand(1, 2.6) : rand(2, 9);
    this.age = 0;
    // Heading drifts smoothly around baseAngle via a slow sine wave, instead
    // of a fixed straight vector — reads as a gentle glide, not an arrow. The
    // minimum amount is kept well above zero so none of them ever look
    // perfectly straight.
    this.wobblePhase = rand(0, Math.PI * 2);
    this.wobbleFreq = rand(0.007, 0.02);
    this.wobbleAmount = rand(0.16, 0.4);
    this.vx = Math.cos(this.baseAngle) * this.speed;
    this.vy = Math.sin(this.baseAngle) * this.speed;

    // Always enter from just off the top/left edge — never mid-scene.
    if (Math.random() < 0.5) {
      this.x = rand(-50, w * 0.7);
      this.y = -20;
    } else {
      this.x = -20;
      this.y = rand(-50, h * 0.7);
    }

    this.color = pickColor();
    this.size = rand(2, 3.4);
    // Trail width is deliberately close to the head's diameter, not a
    // fraction of it — the stroke should read as similar heft to the head.
    this.width = rand(3.4, 5.6);
    this.trail = [];
    this.trailLength = Math.random() < 0.2 ? rand(90, 140) : rand(50, 85);
    this.delay = rand(60, 220);
  };

  Meteor.prototype.update = function () {
    if (this.delay > 0) { this.delay--; return; }
    this.age++;
    var angle = this.baseAngle + Math.sin(this.age * this.wobbleFreq + this.wobblePhase) * this.wobbleAmount;
    this.vx = Math.cos(angle) * this.speed;
    this.vy = Math.sin(angle) * this.speed;
    this.x += this.vx;
    this.y += this.vy;
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > this.trailLength) this.trail.shift();

    // Only respawn once the *tail* (the oldest point still attached to this
    // trail) has also exited — checking the head alone cut trails off while
    // most of their length was still visible on screen.
    var w = this.field.width, h = this.field.height;
    var tail = this.trail.length ? this.trail[0] : { x: this.x, y: this.y };
    if (tail.x - 40 > w || tail.y - 40 > h) this.reset();
  };

  // Strokes the meteor's actual traveled path (its trail-point history).
  // t runs from 0 at the tail (oldest point) to 1 at the head (newest).
  // widthExp/alphaExp shape the taper — alpha is meant to decay faster than
  // width, so the tail keeps a sliver of shape but reads as much darker,
  // closer to the pitch-black background, well before the head. tMin lets a
  // caller skip the rear portion entirely (used to keep bloom near the head).
  Meteor.prototype._strokeTrail = function (ctx, scale, alphaMul, widthExp, alphaExp, tMin) {
    var c = this.color;
    var n = this.trail.length;
    if (n < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 1; i < n; i++) {
      var t = i / n;
      if (t < tMin) continue;
      var a = this.trail[i - 1], b = this.trail[i];
      var ew = Math.pow(t, widthExp);
      var ea = Math.pow(t, alphaExp);
      ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (ea * alphaMul) + ')';
      ctx.lineWidth = Math.max(0.5, this.width * ew) * scale;
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
    }
  };

  Meteor.prototype.draw = function (ctx) {
    if (this.delay > 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this._strokeTrail(ctx, 1, 0.85, 1.6, 2.6, 0);

    var n = this.trail.length;
    if (n) {
      var head = this.trail[n - 1];
      var c = this.color;
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',1)';
      ctx.beginPath();
      ctx.arc(head.x, head.y, this.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // Drawn into the low-res glow buffer that gets blurred + added back for
  // bloom. Only the front portion near the head contributes (tMin) so the
  // glow stays concentrated around the head and the tail stays dark — the
  // whole trail glowing evenly was the bug being fixed here.
  Meteor.prototype.drawGlow = function (gctx, scale) {
    if (this.delay > 0) return;
    gctx.save();
    gctx.globalCompositeOperation = 'lighter';
    this._strokeTrail(gctx, scale, 0.85, 2.2, 3.2, 0.45);

    var n = this.trail.length;
    if (n) {
      var head = this.trail[n - 1];
      var c = this.color;
      gctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0.95)';
      gctx.beginPath();
      gctx.arc(head.x * scale, head.y * scale, this.size * 2 * scale, 0, Math.PI * 2);
      gctx.fill();
    }
    gctx.restore();
  };

  function Spark(x, y, color) {
    this.x = x; this.y = y;
    var angle = rand(0, Math.PI * 2);
    var speed = rand(0.6, 2.4);
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.color = color;
    this.life = 0;
    this.maxLife = rand(30, 60);
  }

  Spark.prototype.update = function () {
    this.x += this.vx; this.y += this.vy;
    this.vx *= 0.96; this.vy *= 0.96;
    this.life++;
  };

  Spark.prototype.dead = function () { return this.life >= this.maxLife; };

  Spark.prototype.draw = function (ctx) {
    var c = this.color;
    var t = 1 - this.life / this.maxLife;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (t * 0.9) + ')';
    ctx.beginPath();
    ctx.arc(this.x, this.y, 1.6 * t + 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  Spark.prototype.drawGlow = function (gctx, scale) {
    var c = this.color;
    var t = 1 - this.life / this.maxLife;
    gctx.save();
    gctx.globalCompositeOperation = 'lighter';
    gctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (t * 0.9) + ')';
    gctx.beginPath();
    gctx.arc(this.x * scale, this.y * scale, (2.2 * t + 0.6) * scale, 0, Math.PI * 2);
    gctx.fill();
    gctx.restore();
  };

  // Expanding concentric rings that grow outward and fade — the surface
  // disturbance of something moving through water. Kept faint and thin so
  // they read as ambience, not as hard circles.
  function Ripple(x, y, color, maxRadius) {
    this.x = x; this.y = y;
    this.color = color;
    this.radius = rand(2, 6);
    this.maxRadius = maxRadius || rand(70, 170);
    this.life = 0;
    this.maxLife = rand(90, 170);
    this.rings = Math.random() < 0.5 ? 2 : 3;
    this.spacing = rand(8, 16);
    this.width = rand(0.8, 1.6);
  }

  Ripple.prototype.update = function () {
    this.life++;
    var t = this.life / this.maxLife;
    // Ease-out expansion — fast at first, settling as it spreads, like a
    // real ripple losing energy.
    this.radius = this.maxRadius * (1 - Math.pow(1 - t, 2));
  };

  Ripple.prototype.dead = function () { return this.life >= this.maxLife; };

  Ripple.prototype.draw = function (ctx) {
    var c = this.color;
    var t = this.life / this.maxLife;
    // Brightest the instant it's born (like a droplet strike), decaying as
    // it spreads. Quick decay means the strong start reads as a soft pop,
    // not a hard ring.
    var fade = Math.pow(1 - t, 1.3);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = this.width;
    for (var i = 0; i < this.rings; i++) {
      var r = this.radius - i * this.spacing;
      if (r <= 0) continue;
      var a = fade * 0.32 * (1 - i * 0.35);
      if (a <= 0) continue;
      ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  // Feeds the bloom buffer only while young, so a fresh ripple briefly
  // flares/glows and then settles into a plain thin ring as it fades.
  Ripple.prototype.drawGlow = function (gctx, scale) {
    var t = this.life / this.maxLife;
    var glow = Math.pow(1 - t, 2.4);
    if (glow <= 0.02) return;
    var c = this.color;
    gctx.save();
    gctx.globalCompositeOperation = 'lighter';
    gctx.lineWidth = (this.width + 1.5) * scale;
    for (var i = 0; i < this.rings; i++) {
      var r = (this.radius - i * this.spacing) * scale;
      if (r <= 0) continue;
      var a = glow * 0.5 * (1 - i * 0.35);
      if (a <= 0) continue;
      gctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
      gctx.beginPath();
      gctx.arc(this.x * scale, this.y * scale, r, 0, Math.PI * 2);
      gctx.stroke();
    }
    gctx.restore();
  };

  function MeteorField(canvas, options) {
    options = options || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.count = options.count || 7;
    this.meteors = [];
    this.sparks = [];
    this.ripples = [];
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._running = false;
    this._raf = null;
    this._boundTick = this._tick.bind(this);

    // Offscreen low-res buffer: trails + heads are drawn here too, then
    // blurred (two passes: tight + wide) and added back onto the main
    // canvas each frame for a soft, painterly glow along their full length.
    this.glow = document.createElement('canvas');
    this.glowCtx = this.glow.getContext('2d');
    this.glowScale = 0.5;
    this.glowBlur = options.glowBlur || 8;

    window.addEventListener('resize', this.resize.bind(this));
    document.addEventListener('visibilitychange', this._handleVisibility.bind(this));

    this.resize();
    // Population is now driven by the caller (see main.js) so the scene can
    // open on empty water and script meteors in gradually.
  }

  MeteorField.prototype.resize = function () {
    var w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.fillStyle = 'rgb(' + BG + ')';
    this.ctx.fillRect(0, 0, w, h);

    this.glow.width = Math.max(1, Math.round(w * this.glowScale));
    this.glow.height = Math.max(1, Math.round(h * this.glowScale));
  };

  MeteorField.prototype._handleVisibility = function () {
    if (document.hidden) this.stop(); else this.start();
  };

  MeteorField.prototype.burst = function (x, y, color, count) {
    color = color || pickColor();
    count = count || 8;
    for (var i = 0; i < count; i++) this.sparks.push(new Spark(x, y, color));
  };

  MeteorField.prototype.addMeteor = function (opts) {
    this.meteors.push(new Meteor(this, opts));
  };

  MeteorField.prototype.populate = function (n) {
    n = (n == null) ? this.count : n;
    for (var i = 0; i < n; i++) this.addMeteor();
  };

  MeteorField.prototype.spawnRipple = function (x, y, color, maxRadius) {
    this.ripples.push(new Ripple(x, y, color || pickColor(), maxRadius));
  };

  MeteorField.prototype._tick = function () {
    if (!this._running) return;
    var ctx = this.ctx, w = this.width, h = this.height;
    var gctx = this.glowCtx, scale = this.glowScale;

    // Hard clear to solid black every frame — trail length comes entirely
    // from each meteor's explicit point history (drawn below), not from
    // repeatedly re-fading old pixels. That fade-via-overlay trick leaves a
    // permanent low-level "stuck" residue due to 8-bit rounding once the
    // delta from background gets small, which read as uneven grey smears.
    ctx.fillStyle = 'rgb(' + BG + ')';
    ctx.fillRect(0, 0, w, h);
    gctx.clearRect(0, 0, this.glow.width, this.glow.height);

    // Ripples (spawned on musical notes — see main.js) render under the
    // meteors. drawGlow feeds the bloom buffer so they flare briefly.
    for (var k = this.ripples.length - 1; k >= 0; k--) {
      this.ripples[k].update();
      this.ripples[k].draw(ctx);
      this.ripples[k].drawGlow(gctx, scale);
      if (this.ripples[k].dead()) this.ripples.splice(k, 1);
    }

    for (var i = 0; i < this.meteors.length; i++) {
      var m = this.meteors[i];
      m.update();
      m.draw(ctx);
      m.drawGlow(gctx, scale);
    }

    for (var j = this.sparks.length - 1; j >= 0; j--) {
      this.sparks[j].update();
      this.sparks[j].draw(ctx);
      this.sparks[j].drawGlow(gctx, scale);
      if (this.sparks[j].dead()) this.sparks.splice(j, 1);
    }

    // Two-pass bloom: a tight inner glow plus a faint, wider outer haze.
    // Kept modest — since drawGlow() already restricts what's drawn into
    // this buffer to the head end of each trail, this should read as the
    // head glowing rather than the whole scene glowing evenly.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(' + this.glowBlur + 'px)';
    ctx.drawImage(this.glow, 0, 0, this.glow.width, this.glow.height, 0, 0, w, h);
    ctx.filter = 'blur(' + (this.glowBlur * 1.8) + 'px)';
    ctx.globalAlpha = 0.3;
    ctx.drawImage(this.glow, 0, 0, this.glow.width, this.glow.height, 0, 0, w, h);
    ctx.restore();

    this._raf = requestAnimationFrame(this._boundTick);
  };

  MeteorField.prototype.start = function () {
    if (this._running) return;
    this._running = true;
    this._raf = requestAnimationFrame(this._boundTick);
  };

  MeteorField.prototype.stop = function () {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  };

  global.StoryMode = global.StoryMode || {};
  global.StoryMode.MeteorField = MeteorField;
  global.StoryMode.Colors = {
    BLUE: PALETTE[1].c,
    YELLOW: PALETTE[3].c,
    pick: pickColor
  };
})(window);
