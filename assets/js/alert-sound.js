/* ============================================================================
 * alert-sound.js — the Replay Feed alert sound
 *
 * One signature sound, roughly three seconds long: a soft rain bed under a
 * handful of water-drop plinks that bloom into a warm, low chime and fade out.
 * It is synthesized with the Web Audio API (no audio file to download, no
 * network request) and is deliberately quiet — this has to be bearable for a
 * whole season — with a gentle compressor between the mix and the speakers.
 *
 *   AlertSound.play()        play the alert (respects the on/off preference)
 *   AlertSound.test()        play it even while muted, so you can verify audio
 *   AlertSound.toggle()/setEnabled(bool)/isEnabled()
 *   AlertSound.setVolume(0..1)/getVolume()
 *
 * Behaviour that keeps it usable all day:
 *   - events that land together do not stack: at most MAX_QUEUE alerts wait in
 *     line, one every ~900 ms, and duplicates within 2 s are dropped;
 *   - a muted preference is stored per browser (localStorage) under the same
 *     `mlbp.pref.sound` key the Replay Feed has always used;
 *   - browsers block audio until a user gesture, so the AudioContext is
 *     unlocked on the first pointer/key event and an alert requested before
 *     that is simply not played (never an error).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var PREF_KEY = 'mlbp.pref.sound';
  var VOLUME_KEY = 'mlbp.pref.sound.volume';
  var DURATION_MS = 3000;
  /* Sounds never overlap: the next queued alert waits for the previous one to
   * finish, so a busy inning cannot turn into a pile of noise. */
  var MIN_GAP_MS = 3100;
  var MAX_QUEUE = 2;
  var DEDUPE_MS = 4000;

  var ctx = null;
  var enabled = loadBool(PREF_KEY, false);
  var volume = loadNumber(VOLUME_KEY, 0.55);
  var lastPlayedAt = 0;
  var queue = [];
  var draining = false;
  var unlocked = false;

  /* Observable counters: `attempts` is every alert the app asked for while the
   * sound was enabled; `requests` is those that actually entered the audio
   * queue; `lastAttemptAt` is the epoch ms of the last attempt. They exist so
   * the checks can prove "this event alerts / this one does not" without
   * needing an audible device. */
  var stats = {
    attempts: 0,
    requests: 0,
    played: 0,
    unsupported: 0,
    lastAttemptAt: 0,
    lastPlayedAt: 0,
    lastKind: null,
  };

  function loadBool(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw === null ? fallback : raw === '1';
    } catch (e) { return fallback; }
  }

  function loadNumber(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (raw === null) return fallback;
      var n = Number(raw);
      return isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
    } catch (e) { return fallback; }
  }

  function store(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function AudioCtor() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function supported() { return !!AudioCtor(); }

  function context() {
    var Ctor = AudioCtor();
    if (!Ctor) return null;
    if (!ctx) {
      try { ctx = new Ctor(); } catch (e) { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume(); } catch (e) { /* gesture still pending */ }
    }
    return ctx;
  }

  /* Unlock on the first real user gesture (required by every modern browser). */
  function unlock() {
    if (unlocked) return;
    var c = context();
    if (!c) return;
    unlocked = true;
    /* A silent one-sample buffer moves the context to "running" inside the gesture. */
    try {
      var buf = c.createBuffer(1, 1, c.sampleRate || 44100);
      var src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
  }

  function attachUnlock() {
    if (!global || typeof global.addEventListener !== 'function') return;
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (evt) {
      global.addEventListener(evt, unlock, { once: true, passive: true });
    });
  }

  /* ------------------------------------------------------------ synthesis */

  function noiseBuffer(c, seconds) {
    var length = Math.max(1, Math.floor((c.sampleRate || 44100) * seconds));
    var buf = c.createBuffer(1, length, c.sampleRate || 44100);
    var data = buf.getChannelData(0);
    for (var i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* Soft rain bed: band-limited noise with a slow swell in and out. */
  function rainBed(c, dest, t0, level) {
    var src = c.createBufferSource();
    src.buffer = noiseBuffer(c, DURATION_MS / 1000 + 0.2);

    var band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(2400, t0);
    band.frequency.linearRampToValueAtTime(1900, t0 + DURATION_MS / 1000);
    band.Q.value = 0.7;

    var shelf = c.createBiquadFilter();
    shelf.type = 'highpass';
    shelf.frequency.value = 700;

    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.6);
    gain.gain.linearRampToValueAtTime(level * 0.8, t0 + 1.8);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + DURATION_MS / 1000);

    src.connect(band);
    band.connect(shelf);
    shelf.connect(gain);
    gain.connect(dest);
    src.start(t0);
    src.stop(t0 + DURATION_MS / 1000 + 0.1);
  }

  /* One water drop: a sine that falls slightly in pitch, a tiny filtered noise
   * splash for the surface tension, then a long gentle decay. */
  function drop(c, dest, t, freq, peak, decay) {
    var osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.92, t + decay);

    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    var body = c.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.setValueAtTime(Math.min(9000, freq * 4), t);

    osc.connect(g);
    g.connect(body);
    body.connect(dest);
    osc.start(t);
    osc.stop(t + decay + 0.05);

    /* splash transient */
    var n = c.createBufferSource();
    n.buffer = noiseBuffer(c, 0.09);
    var ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(peak * 0.18, t + 0.006);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    var hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    n.connect(hp);
    hp.connect(ng);
    ng.connect(dest);
    n.start(t);
    n.stop(t + 0.1);
  }

  function render(kind) {
    var c = context();
    if (!c) return false;

    var now = c.currentTime + 0.02;
    var master = c.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.9, now + 0.08);
    master.gain.setValueAtTime(0.9, now + (DURATION_MS - 450) / 1000);
    master.gain.exponentialRampToValueAtTime(0.0001, now + DURATION_MS / 1000);

    var comp = c.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.knee.value = 24;
    comp.ratio.value = 2.2;
    comp.attack.value = 0.006;
    comp.release.value = 0.28;

    var out = c.createGain();
    out.gain.value = Math.max(0.02, Math.min(1, volume)) * 0.55;

    master.connect(comp);
    comp.connect(out);
    out.connect(c.destination);

    /* A small stereo-ish echo for depth: two taps with light feedback. */
    var wet = c.createGain();
    wet.gain.value = 0.3;
    [[0.13, 0.24], [0.23, 0.18]].forEach(function (tap) {
      var d = c.createDelay(0.6);
      d.delayTime.value = tap[0];
      var fb = c.createGain();
      fb.gain.value = tap[1];
      var lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;
      master.connect(d);
      d.connect(lp);
      lp.connect(fb);
      fb.connect(d);
      lp.connect(wet);
    });
    wet.connect(comp);

    rainBed(c, master, now, 0.05);

    /* Drop schedule: a gentle irregular pattern, pentatonic so any overlap
     * sounds consonant.  The pitch of each drop falls into the next. */
    var drops = [
      [0.02, 1046.50, 0.32, 0.55],
      [0.31, 880.00, 0.28, 0.62],
      [0.63, 1318.51, 0.30, 0.52],
      [0.97, 783.99, 0.25, 0.78],
      [1.39, 1174.66, 0.26, 0.72],
      [1.83, 659.25, 0.22, 1.0],
    ];
    if (kind === 'risk') {
      /* Runs at risk: the same water, one extra brighter drop on top. */
      drops.push([1.12, 1567.98, 0.18, 0.45]);
      drops.push([2.05, 1396.91, 0.16, 0.6]);
    } else if (kind === 'scoring') {
      /* Official scoring change: one extra late drop, same family. */
      drops.push([2.16, 987.77, 0.2, 0.7]);
    }
    drops.forEach(function (d) { drop(c, master, now + d[0], d[1], d[2], d[3]); });

    /* Warm low pad underneath, barely there — it rounds off the tail. */
    var pad = c.createOscillator();
    pad.type = 'sine';
    pad.frequency.setValueAtTime(196.00, now);
    var padGain = c.createGain();
    padGain.gain.setValueAtTime(0.0001, now);
    padGain.gain.linearRampToValueAtTime(0.035, now + 0.5);
    padGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.9);
    pad.connect(padGain);
    padGain.connect(master);
    pad.start(now);
    pad.stop(now + 3.0);

    /* Tear the graph down once the tail has decayed (no leaked nodes). */
    try {
      global.setTimeout(function () {
        try { out.disconnect(); } catch (e) { /* already gone */ }
      }, DURATION_MS + 400);
    } catch (e) { /* ignore */ }

    return true;
  }

  /* ------------------------------------------------------------- playback */

  function drain() {
    if (draining) return;
    if (!queue.length) return;
    draining = true;
    var kind = queue.shift();
    var wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastPlayedAt));
    global.setTimeout(function () {
      if (render(kind)) stats.played += 1;
      stats.lastPlayedAt = Date.now();
      lastPlayedAt = Date.now();
      draining = false;
      drain();
    }, wait);
  }

  function request(kind, force) {
    if (!force && !enabled) return false;
    stats.attempts += 1;
    stats.lastAttemptAt = Date.now();
    stats.lastKind = kind || 'alert';
    if (!supported()) {
      stats.unsupported += 1;
      return false;
    }
    if (!force) {
      /* A burst of events is one alert: an identical alert inside the dedupe
       * window is dropped, and only MAX_QUEUE sounds can ever be waiting. */
      if (queue.length >= MAX_QUEUE) return false;
      if (queue.length && queue[queue.length - 1] === kind) return false;
      if (!queue.length && Date.now() - lastPlayedAt < DEDUPE_MS) return false;
    } else {
      /* "Test alert" must be audible right away, muted or not. */
      queue = [];
      lastPlayedAt = 0;
    }
    queue.push(kind || 'alert');
    stats.requests += 1;
    drain();
    return true;
  }

  function setEnabled(value) {
    enabled = !!value;
    store(PREF_KEY, enabled ? '1' : '0');
    if (enabled) unlock();
    return enabled;
  }

  function toggle() { return setEnabled(!enabled); }

  function setVolume(value) {
    var n = Number(value);
    if (!isFinite(n)) return volume;
    volume = Math.min(1, Math.max(0.05, n));
    store(VOLUME_KEY, String(volume));
    return volume;
  }

  attachUnlock();

  global.AlertSound = {
    play: function (kind) { return request(kind, false); },
    test: function (kind) { unlock(); return request(kind || 'preview', true); },
    preview: function () { return request('preview', true); },
    toggle: toggle,
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    isSupported: supported,
    setVolume: setVolume,
    getVolume: function () { return volume; },
    unlock: unlock,
    stats: stats,
    resetStats: function () {
      stats.attempts = 0; stats.requests = 0; stats.played = 0; stats.unsupported = 0;
      stats.lastAttemptAt = 0; stats.lastPlayedAt = 0; stats.lastKind = null;
    },
    DURATION_MS: DURATION_MS,
    MIN_GAP_MS: MIN_GAP_MS,
    MAX_QUEUE: MAX_QUEUE,
  };
}(window));
