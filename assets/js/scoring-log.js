/* ============================================================================
 * scoring-log.js — the Official Scoring Log (scoring.html)
 *
 * Official-scorer pending rulings and official scoring changes get their own
 * page, their own store and their own polling loop. Nothing here touches the
 * Replay Feed's alert path: a failure in this file can never silence an alert,
 * and muting the alert sound never stops a ruling from being logged.
 *
 * What is logged, all from the official StatsAPI payload:
 *   - pending  : a completed play whose result.eventType is
 *                os_ruling_pending_primary / os_ruling_pending_prior (the
 *                API's own event-type registry, description "Official Scorer
 *                Ruling Pending"), with the exact wording observed and the
 *                timestamped game state at that moment;
 *   - ruling   : that pending play later carrying a real event type — the
 *                before/after wording and the before/after game state;
 *   - change   : a completed play whose official classification changed between
 *                two polls (eventType / isOut / outs), e.g. hit -> error;
 *   - edit     : a description / RBI / score edit with no reclassification,
 *                logged and flagged for review, never "corrected" here.
 *
 * Persistence (survives refreshes, other tabs, other browsers):
 *   localStorage `mlbp.scoringlog.<date>` + `mlbp.scoringlog.index`,
 *   and — when server.mjs is running — `GET/POST /api/scoring-log` plus the
 *   `GET /api/scoring-log/stream` server-sent-event push. Both layers merge by
 *   record id; nothing is ever overwritten with older wording.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var Reviews = global.Reviews;
  var UI = global.UI;
  var GameState = global.GameState;

  var KEY_PREFIX = 'mlbp.scoringlog.';
  var INDEX_KEY = 'mlbp.scoringlog.index';
  var KEEP_DATES = 14;
  var MAX_RECORDS = 800;
  var MAX_OBSERVATIONS = 30;
  var SAVE_COALESCE_MS = 1000;
  var POLL_MS = 700;              // per-game cadence on this page
  var SCHEDULE_MS = 3000;
  var FINAL_GRACE_MS = 30 * 60 * 1000;

  /* The API's own event types for an undecided official-scorer ruling.
   * (Reviews.PENDING_RULING_TYPES carries the same pair for the feed; the
   * scoring log keeps its own copy so the two surfaces stay independent.) */
  var PENDING_TYPES = ['os_ruling_pending_primary', 'os_ruling_pending_prior'];

  var LEAN_FIELDS = 'dates,games,gamePk,season,status,abstractGameState,codedGameState,' +
    'detailedState,statusCode,reason,startTimeTBD,gameDate,officialDate,teams,away,home,team,id,name';

  var api = { checked: false, available: false, lastError: null };
  var shared = Object.create(null);       // date -> store (for observeGame)
  var saveTimers = Object.create(null);
  var stream = null;
  var streamDate = null;
  var listeners = [];                     // optional onChange subscribers

  /* ------------------------------------------------------------- utilities */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isoSecond(ms) {
    if (GameState && GameState.isoSecond) return GameState.isoSecond(ms);
    var d = new Date(Number(ms) || Date.now());
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + 'Z';
  }

  function localClock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || '';
    try {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch (e) { return String(iso).slice(11, 19); }
  }

  function numOrNull(v) {
    var n = Number(v);
    return (v === null || v === undefined || v === '' || !isFinite(n)) ? null : n;
  }

  function isoNewer(a, b) {
    if (!a) return false;
    if (!b) return true;
    return String(a) > String(b);
  }

  function minIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return String(a) <= String(b) ? a : b;
  }

  function maxIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return String(a) >= String(b) ? a : b;
  }

  /* ------------------------------------------------------------- store I/O */

  function emptyStore(date) {
    return { v: 1, date: date, savedAt: Date.now(), records: [], classes: {}, scanned: {} };
  }

  function normalize(store, date) {
    if (!store || typeof store !== 'object') return emptyStore(date);
    return {
      v: 1,
      date: date,
      savedAt: Number(store.savedAt) || Date.now(),
      records: Array.isArray(store.records) ? store.records.filter(Boolean).slice(0, MAX_RECORDS) : [],
      classes: (store.classes && typeof store.classes === 'object') ? store.classes : {},
      scanned: (store.scanned && typeof store.scanned === 'object') ? store.scanned : {},
    };
  }

  function storageGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function readIndex() {
    try {
      var parsed = JSON.parse(storageGet(INDEX_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function writeIndex(dates) {
    var sorted = dates.slice().sort();
    while (sorted.length > KEEP_DATES) {
      var drop = sorted.shift();
      try { global.localStorage.removeItem(KEY_PREFIX + drop); } catch (e) { /* ignore */ }
    }
    storageSet(INDEX_KEY, JSON.stringify(sorted));
  }

  function loadLocal(date) {
    var raw = storageGet(KEY_PREFIX + date);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1) return null;
      return normalize(parsed, date);
    } catch (e) {
      if (global.console && global.console.warn) {
        global.console.warn('[scoring-log] dropping malformed local log for ' + date);
      }
      return null;
    }
  }

  function saveLocal(date, store) {
    var ok = storageSet(KEY_PREFIX + date, JSON.stringify(store));
    if (ok) {
      var index = readIndex();
      if (index.indexOf(date) === -1) index.push(date);
      writeIndex(index);
    }
    return ok;
  }

  function isStaticHost() {
    var host = (global.location && global.location.hostname) || '';
    return /\.github\.io$/i.test(host);
  }

  function serverFetch(path, opts) {
    return fetch(path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, opts || {}))
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      });
  }

  function loadServer(date) {
    if (isStaticHost()) {
      api.checked = true;
      api.available = false;
      return Promise.resolve(null);
    }
    if (api.checked && !api.available) return Promise.resolve(null);
    return serverFetch('/api/scoring-log?date=' + encodeURIComponent(date))
      .then(function (data) {
        api.checked = true;
        api.available = true;
        return normalize(data, date);
      })
      .catch(function (err) {
        api.checked = true;
        api.available = false;
        api.lastError = err;
        return null;
      });
  }

  function load(date) {
    var local = loadLocal(date);
    return loadServer(date).then(function (remote) {
      if (!remote && !local) return emptyStore(date);
      if (!remote) return local;
      if (!local) {
        saveLocal(date, remote);
        return remote;
      }
      var merged = mergeStores(remote, local, date);
      saveLocal(date, merged);
      return merged;
    });
  }

  function postNow(date) {
    var store = shared[date];
    if (!store) return Promise.resolve(null);
    if (api.checked && !api.available) return Promise.resolve(null);
    return serverFetch('/api/scoring-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(store),
    }).then(function (res) {
      api.available = true;
      api.checked = true;
      /* The server answered — subscribe to its push so records written by
       * another tab or browser show up here without a reload. */
      if (date === page.date && page.store) openStream(date);
      return res;
    }).catch(function (err) {
      api.available = false;
      api.lastError = err;
      return null;
    });
  }

  function save(date, store) {
    var normalized = normalize(store, date);
    /* Keep the LIVE store object shared (never a normalized copy): the page and
     * observeGame() must mutate one store, or a record written by the Replay
     * Feed would vanish from the page's next render. */
    shared[date] = store;
    saveLocal(date, normalized);
    if (saveTimers[date]) return;
    saveTimers[date] = setTimeout(function () {
      saveTimers[date] = null;
      postNow(date);
    }, SAVE_COALESCE_MS);
  }

  /* ------------------------------------------------- live push (SSE)
   * The scoring log keeps its own stream: /api/scoring-log/stream, separate
   * from the Replay Feed's /api/feed-log/stream.  Absent on static hosting,
   * where the local store is the whole log. */

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function emit(store) {
    listeners.forEach(function (fn) {
      try { fn(store); } catch (e) {
        global.console && global.console.warn && global.console.warn('[scoring-log] listener failed', e);
      }
    });
  }

  function openStream(date) {
    if (typeof global.EventSource !== 'function') return null;
    /* Trust a real answer from the server over the hostname heuristic: once a
     * request has proved the endpoint exists, keep the stream open; once it has
     * proved it does not (static hosting), never retry it. */
    if (api.checked ? !api.available : isStaticHost()) return null;
    if (stream && streamDate === date) return stream;
    closeStream();
    try {
      stream = new global.EventSource('/api/scoring-log/stream?date=' + encodeURIComponent(date));
    } catch (e) {
      stream = null;
      return null;
    }
    streamDate = date;
    stream.addEventListener('scoring-log', function (evt) {
      try {
        var remote = normalize(JSON.parse(evt.data), date);
        api.checked = true;
        api.available = true;
        var current = shared[date] || loadLocal(date) || emptyStore(date);
        var merged = mergeStores(remote, current, date);
        shared[date] = merged;
        saveLocal(date, merged);
        if (page.store && page.date === date) {
          page.store = merged;
          render();
        }
        emit(merged);
      } catch (e) {
        global.console && global.console.warn && global.console.warn('[scoring-log] ignoring malformed push frame');
      }
    });
    stream.addEventListener('error', function () {
      /* Browsers retry automatically; stop retrying a stream the server does
       * not have (static hosting) so a missing endpoint is not polled forever. */
      if (api.checked && !api.available) closeStream();
    });
    return stream;
  }

  function closeStream() {
    if (stream) {
      try { stream.close(); } catch (e) { /* ignore */ }
      stream = null;
    }
    streamDate = null;
  }

  /* --------------------------------------------------------------- records */

  function countPitches(play) {
    var n = 0;
    ((play && play.playEvents) || []).forEach(function (ev) {
      if (ev && ev.isPitch === true) n += 1;
    });
    return n;
  }

  function classificationOf(play) {
    var res = (play && play.result) || {};
    var about = (play && play.about) || {};
    var count = (play && play.count) || {};
    var half = about.halfInning || (about.isTopInning === false ? 'bottom' : 'top');
    var inning = numOrNull(about.inning);
    var inningLabel = inning
      ? (String(half).toLowerCase().indexOf('top') === 0 ? 'Top ' : 'Bot ') + inning
      : '';
    return {
      atBatIndex: numOrNull(about.atBatIndex),
      eventType: res.eventType || '',
      description: res.description || '',
      isOut: res.isOut === true,
      outs: numOrNull(count.outs),
      rbi: numOrNull(res.rbi),
      awayScore: numOrNull(res.awayScore),
      homeScore: numOrNull(res.homeScore),
      pitches: countPitches(play),
      inningLabel: inningLabel,
      batter: (play && play.matchup && play.matchup.batter && play.matchup.batter.fullName) || '',
      pitcher: (play && play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName) || '',
      isPending: PENDING_TYPES.indexOf(res.eventType) !== -1,
    };
  }

  function scoreOfClass(c) {
    if (!c || c.awayScore === null || c.homeScore === null) return null;
    return { away: c.awayScore, home: c.homeScore };
  }

  function wordingOf(c) {
    if (!c) return null;
    return {
      eventType: c.eventType || '',
      description: c.description || '',
      isOut: c.isOut === true,
      outs: c.outs,
      rbi: c.rbi,
      score: scoreOfClass(c),
    };
  }

  function sourceUrl(gamePk) {
    return 'https://statsapi.mlb.com/api/v1/game/' + gamePk + '/playByPlay';
  }

  function recordSignature(rec) {
    if (!rec) return '';
    return JSON.stringify([
      rec.kind, rec.status, rec.atBatIndex,
      rec.wordingBefore, rec.wordingAfter,
      rec.stateBefore && rec.stateBefore.capturedAt,
      rec.stateAfter && rec.stateAfter.capturedAt,
      (rec.observations || []).map(function (o) { return o.at + '|' + o.eventType + '|' + o.description; }),
      (rec.history || []).map(function (h) { return h.at + '|' + h.from + '|' + h.to; }),
      rec.resolvedAt, rec.note,
    ]);
  }

  function upsert(store, record, added) {
    var existing = null;
    for (var i = 0; i < store.records.length; i += 1) {
      if (store.records[i] && store.records[i].id === record.id) { existing = store.records[i]; break; }
    }
    if (!existing) {
      store.records.push(record);
      added.push(record.id);
      return true;
    }
    var before = recordSignature(existing);
    if (before === recordSignature(record)) {
      existing.lastObservedAt = record.lastObservedAt || existing.lastObservedAt;
      return false;
    }
    var merged = Object.assign({}, existing, record);
    merged.firstObservedAt = minIso(existing.firstObservedAt, record.firstObservedAt);
    merged.lastObservedAt = maxIso(existing.lastObservedAt, record.lastObservedAt);
    merged.wordingBefore = existing.wordingBefore || record.wordingBefore || null;
    merged.wordingAfter = record.wordingAfter || existing.wordingAfter || null;
    merged.stateBefore = existing.stateBefore || record.stateBefore || null;
    merged.stateAfter = record.stateAfter || existing.stateAfter || null;
    var idx = store.records.indexOf(existing);
    store.records[idx] = merged;
    added.push(merged.id);
    return true;
  }

  /**
   * observe(store, opts)
   *   opts: { gamePk, date, matchupLabel, plays, feed, observedAt,
   *           state (GameState snapshot), prevState }
   * Pure with respect to the network: mutates `store` and returns the ids that
   * were added or changed.
   */
  function observe(store, opts) {
    var added = [];
    var pk = String((opts && opts.gamePk) || '');
    if (!pk) return added;
    var observedAt = Number(opts.observedAt) || Date.now();
    var at = isoSecond(observedAt);
    var plays = opts.plays || [];
    var state = opts.state || null;
    var prevState = opts.prevState || null;
    var matchup = opts.matchupLabel || '';

    /* Record lookup by id: rows are only pushed or replaced in place, so an
     * id → index map stays valid and avoids a linear scan of every stored
     * record for every play, every poll. */
    var idxById = Object.create(null);
    store.records.forEach(function (r, i) {
      if (r && r.id && idxById[r.id] === undefined) idxById[r.id] = i;
    });
    function recById(id) {
      var at = idxById[id];
      if (at !== undefined) return store.records[at] || null;
      for (var j = 0; j < store.records.length; j += 1) {
        if (store.records[j] && store.records[j].id === id) { idxById[id] = j; return store.records[j]; }
      }
      return null;
    }

    var prevClasses = store.classes[pk] || {};
    var nextClasses = Object.create(null);
    var pendingRows = [];
    plays.forEach(function (play) {
      var about = (play && play.about) || {};
      if (about.isComplete !== true) return;
      var c = classificationOf(play);
      if (c.atBatIndex === null) return;
      nextClasses[c.atBatIndex] = c;
      if (c.isPending) pendingRows.push(c);
    });

    /* 1. pending rulings currently in the payload */
    var pendingIds = Object.create(null);
    pendingRows.forEach(function (c) {
      var id = pk + ':' + c.atBatIndex + ':pending';
      pendingIds[id] = true;
      var rec = recById(id);
      var observations = rec && Array.isArray(rec.observations) ? rec.observations.slice() : [];
      var lastObs = observations[observations.length - 1];
      if (!lastObs || lastObs.eventType !== c.eventType || lastObs.description !== c.description) {
        observations.push({ at: at, eventType: c.eventType, description: c.description });
      }
      upsert(store, {
        id: id,
        kind: 'pending',
        gamePk: pk,
        matchupLabel: matchup || (rec && rec.matchupLabel) || '',
        atBatIndex: c.atBatIndex,
        inningLabel: c.inningLabel,
        batter: c.batter,
        pitcher: c.pitcher,
        status: 'open',
        firstObservedAt: (rec && rec.firstObservedAt) || at,
        lastObservedAt: at,
        detectedAt: (rec && rec.detectedAt) || at,
        wordingBefore: (rec && rec.wordingBefore) || wordingOf(c),
        wordingAfter: (rec && rec.wordingAfter) || null,
        stateBefore: (rec && rec.stateBefore) || state,
        stateAfter: (rec && rec.stateAfter) || null,
        observations: observations.slice(-MAX_OBSERVATIONS),
        source: sourceUrl(pk),
        note: 'Official-scorer ruling pending — the at-bat has not been charged yet.',
      }, added);
    });

    /* 2. a pending ruling that has now been decided (or vanished) */
    store.records.forEach(function (rec) {
      if (!rec || String(rec.gamePk) !== pk) return;
      if (rec.kind !== 'pending' || rec.status !== 'open' || pendingIds[rec.id]) return;
      var c = nextClasses[rec.atBatIndex];
      if (!c) {
        var note = 'Pending ruling disappeared from the payload without a final event type — left open for review, not guessed.';
        if (rec.note !== note) {
          rec.status = 'unresolved';
          rec.note = note;
          rec.lastObservedAt = at;
          added.push(rec.id);
        }
        return;
      }
      var observations = (rec.observations || []).slice();
      observations.push({ at: at, eventType: c.eventType, description: c.description });
      rec.status = 'resolved';
      rec.resolvedAt = at;
      rec.lastObservedAt = at;
      rec.wordingAfter = wordingOf(c);
      rec.stateAfter = state || rec.stateAfter || null;
      rec.observations = observations.slice(-MAX_OBSERVATIONS);
      added.push(rec.id);
    });

    /* 3. reclassifications and wording-only edits between two polls */
    Object.keys(nextClasses).forEach(function (key) {
      var after = nextClasses[key];
      var before = prevClasses[key];
      if (!before) return;
      var reclassified = before.eventType !== after.eventType ||
        before.isOut !== after.isOut ||
        (before.outs !== null && after.outs !== null && before.outs !== after.outs);

      if (reclassified) {
        var fromPending = PENDING_TYPES.indexOf(before.eventType) !== -1;
        var id = pk + ':' + after.atBatIndex + (fromPending ? ':ruling' : ':change');
        var rec = recById(id);
        var pendingRec = recById(pk + ':' + after.atBatIndex + ':pending');
        var history = (rec && Array.isArray(rec.history)) ? rec.history.slice() : [];
        var lastHist = history[history.length - 1];
        if (!lastHist || lastHist.from !== before.eventType || lastHist.to !== after.eventType) {
          history.push({
            at: at,
            from: before.eventType,
            to: after.eventType,
            fromDescription: before.description,
            toDescription: after.description,
          });
        }
        upsert(store, {
          id: id,
          kind: fromPending ? 'ruling_resolved' : 'change',
          gamePk: pk,
          matchupLabel: matchup || (rec && rec.matchupLabel) || '',
          atBatIndex: after.atBatIndex,
          inningLabel: after.inningLabel,
          batter: after.batter,
          pitcher: after.pitcher,
          status: 'observed',
          firstObservedAt: (rec && rec.firstObservedAt) || at,
          lastObservedAt: at,
          detectedAt: (rec && rec.detectedAt) || at,
          wordingBefore: (rec && rec.wordingBefore) || wordingOf(before) ||
            (pendingRec && pendingRec.wordingBefore) || null,
          wordingAfter: wordingOf(after),
          stateBefore: (rec && rec.stateBefore) || (pendingRec && pendingRec.stateBefore) || prevState || state,
          stateAfter: state || (rec && rec.stateAfter) || null,
          history: history.slice(-25),
          observations: (rec && Array.isArray(rec.observations) ? rec.observations.slice() : [])
            .concat([{ at: at, eventType: after.eventType, description: after.description }])
            .slice(-MAX_OBSERVATIONS),
          source: sourceUrl(pk),
          note: fromPending
            ? 'Official scorer decided the pending ruling — the initial wording is the pending one.'
            : 'Official scorer / Elias / club review changed the classification of this play.',
        }, added);
      } else if (before.description !== after.description || before.rbi !== after.rbi ||
        before.awayScore !== after.awayScore || before.homeScore !== after.homeScore) {
        var editId = pk + ':' + after.atBatIndex + ':edit';
        var editRec = recById(editId);
        upsert(store, {
          id: editId,
          kind: 'edit',
          gamePk: pk,
          matchupLabel: matchup || (editRec && editRec.matchupLabel) || '',
          atBatIndex: after.atBatIndex,
          inningLabel: after.inningLabel,
          batter: after.batter,
          pitcher: after.pitcher,
          status: 'flagged',
          firstObservedAt: (editRec && editRec.firstObservedAt) || at,
          lastObservedAt: at,
          detectedAt: (editRec && editRec.detectedAt) || at,
          wordingBefore: (editRec && editRec.wordingBefore) || wordingOf(before),
          wordingAfter: wordingOf(after),
          stateBefore: (editRec && editRec.stateBefore) || prevState || state,
          stateAfter: state || (editRec && editRec.stateAfter) || null,
          history: (editRec && editRec.history) || [],
          source: sourceUrl(pk),
          note: 'Payload text / RBI / score edited without reclassification — logged and flagged, not corrected.',
        }, added);
      }
    });

    store.classes[pk] = nextClasses;
    store.scanned[pk] = at;

    if (store.records.length > MAX_RECORDS) {
      store.records.sort(function (x, y) {
        return String(y.detectedAt || y.firstObservedAt || '').localeCompare(String(x.detectedAt || x.firstObservedAt || ''));
      });
      store.records = store.records.slice(0, MAX_RECORDS);
    }
    return added;
  }

  /* ---------------------------------------------------------------- merging */

  function mergeObservations(a, b) {
    var list = [];
    var seen = Object.create(null);
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(function (o) {
      if (!o) return;
      var key = String(o.at) + '|' + String(o.eventType) + '|' + String(o.description);
      if (seen[key]) return;
      seen[key] = true;
      list.push(o);
    });
    list.sort(function (x, y) { return String(x.at || '').localeCompare(String(y.at || '')); });
    return list.slice(-MAX_OBSERVATIONS);
  }

  function mergeHistory(a, b) {
    var list = [];
    var seen = Object.create(null);
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(function (h) {
      if (!h) return;
      var key = String(h.at) + '|' + String(h.from) + '|' + String(h.to);
      if (seen[key]) return;
      seen[key] = true;
      list.push(h);
    });
    list.sort(function (x, y) { return String(x.at || '').localeCompare(String(y.at || '')); });
    return list.slice(-25);
  }

  function recordStatusRank(status) {
    if (status === 'resolved' || status === 'unresolved') return 2;
    if (status === 'flagged') return 1;
    return 0;
  }

  function mergeRecord(prev, next) {
    var merged = Object.assign({}, prev, next);
    merged.firstObservedAt = minIso(prev.firstObservedAt, next.firstObservedAt);
    merged.lastObservedAt = maxIso(prev.lastObservedAt, next.lastObservedAt);
    merged.detectedAt = minIso(prev.detectedAt, next.detectedAt) || merged.detectedAt;
    merged.resolvedAt = minIso(prev.resolvedAt, next.resolvedAt) || merged.resolvedAt || null;
    merged.status = recordStatusRank(next.status) >= recordStatusRank(prev.status) ? next.status : prev.status;
    merged.wordingBefore = prev.wordingBefore || next.wordingBefore || null;
    merged.wordingAfter = next.wordingAfter || prev.wordingAfter || null;
    merged.stateBefore = prev.stateBefore || next.stateBefore || null;
    merged.stateAfter = next.stateAfter || prev.stateAfter || null;
    merged.observations = mergeObservations(prev.observations, next.observations);
    merged.history = mergeHistory(prev.history, next.history);
    merged.note = next.note || prev.note || '';
    merged.source = next.source || prev.source || '';
    return merged;
  }

  function mergeStores(a, b, date) {
    var base = normalize(a || emptyStore(date), date);
    var add = normalize(b || emptyStore(date), date);
    var map = Object.create(null);
    var order = [];

    base.records.forEach(function (r) {
      if (!r || !r.id) return;
      map[r.id] = r;
      order.push(r.id);
    });
    add.records.forEach(function (r) {
      if (!r || !r.id) return;
      var prev = map[r.id];
      if (!prev) {
        map[r.id] = r;
        order.push(r.id);
        return;
      }
      map[r.id] = mergeRecord(prev, r);
    });

    var records = order.map(function (k) { return map[k]; }).filter(Boolean)
      .sort(function (x, y) {
        return String(y.detectedAt || y.firstObservedAt || '').localeCompare(String(x.detectedAt || x.firstObservedAt || ''));
      })
      .slice(0, MAX_RECORDS);

    var classes = Object.assign({}, base.classes);
    Object.keys(add.classes || {}).forEach(function (pk) {
      if (isoNewer(add.scanned && add.scanned[pk], base.scanned && base.scanned[pk])) {
        classes[pk] = add.classes[pk];
      }
    });
    var scanned = Object.assign({}, base.scanned || {});
    Object.keys(add.scanned || {}).forEach(function (pk) {
      scanned[pk] = maxIso(scanned[pk], add.scanned[pk]);
    });

    return {
      v: 1,
      date: date,
      savedAt: Date.now(),
      records: records,
      classes: classes,
      scanned: scanned,
    };
  }

  /* --------------------------------------------------- live observer (feed) */

  /* Called by the Replay Feed for every observation it already paid for. The
   * work happens in a separate store with its own save path; reviews-feed
   * wraps this in try/catch so it can never break alerting. */
  function observeGame(opts) {
    if (!opts) return [];
    var date = opts.date || MLB.todayISO();
    var store = shared[date];
    if (!store) {
      store = loadLocal(date) || emptyStore(date);
      shared[date] = store;
      /* Pull the shared server log once in the background, then merge. */
      loadServer(date).then(function (remote) {
        if (!remote) return;
        shared[date] = mergeStores(remote, shared[date] || store, date);
        saveLocal(date, shared[date]);
      }).catch(function () { /* local-only mode */ });
    }
    var added = observe(store, {
      gamePk: opts.gamePk,
      matchupLabel: opts.matchupLabel,
      plays: opts.plays,
      feed: opts.feed,
      observedAt: opts.observedAt,
      state: opts.state,
      prevState: opts.prevState,
    });
    if (added.length) save(date, store);
    return added;
  }

  /* --------------------------------------------------------- page controller */

  var page = {
    date: null,
    filter: 'all',
    store: null,
    games: [],
    due: Object.create(null),
    inFlight: Object.create(null),
    finalSeen: Object.create(null),
    gameState: Object.create(null),
    prevGameState: Object.create(null),
    lastScheduleAt: 0,
    scheduleInFlight: false,
    timer: null,
    sweepTimer: null,
    lastError: null,
    lastCaptureAt: 0,
    lastSaveAt: 0,
    renderSignature: '',
  };

  function $(id) { return document.getElementById(id); }

  function statusLine(text, isError) {
    var el = $('status-line');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function urlDate() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      var d = params.get('date');
      return MLB.isValidISODate(d) ? d : null;
    } catch (e) { return null; }
  }

  function syncUrl() {
    try {
      var url = new URL(global.location.href);
      if (url.searchParams.get('date') === page.date) return;
      url.searchParams.set('date', page.date);
      global.history.replaceState(null, '', url.toString());
    } catch (e) { /* ignore */ }
  }

  function syncNav() {
    var picker = $('date-picker');
    if (picker && picker.value !== page.date) picker.value = page.date;
    var label = $('date-label');
    if (label) label.textContent = MLB.formatDateLabel(page.date);
    var back = document.querySelector('a.btn[href^="index.html"]');
    if (back) back.setAttribute('href', 'index.html?date=' + encodeURIComponent(page.date));
    var feed = document.querySelector('a.btn[href^="reviews.html"]');
    if (feed) feed.setAttribute('href', 'reviews.html?date=' + encodeURIComponent(page.date));
    syncUrl();
  }

  function statusOf(game) {
    return (game && game.status && game.status.abstractGameState) || '';
  }

  function teamsOf(game) {
    var awayTeam = (game && game.teams && game.teams.away && game.teams.away.team) || {};
    var homeTeam = (game && game.teams && game.teams.home && game.teams.home.team) || {};
    return {
      away: { id: awayTeam.id || null, name: awayTeam.name || '' },
      home: { id: homeTeam.id || null, name: homeTeam.name || '' },
    };
  }

  function matchupOf(game) {
    var t = teamsOf(game);
    return (UI.abbr(t.away) || 'AWY') + ' @ ' + (UI.abbr(t.home) || 'HOME');
  }

  function finalGraceDelay(seen, elapsed) {
    if (elapsed < 2 * 60 * 1000) return 1500;
    if (elapsed < 5 * 60 * 1000) return 3000;
    return 15000;
  }

  function wantsGame(game, now) {
    var status = statusOf(game);
    if (status === 'Live') return true;
    if (status === 'Final') {
      if (!page.finalSeen[game.gamePk]) page.finalSeen[game.gamePk] = now;
      return now - page.finalSeen[game.gamePk] <= FINAL_GRACE_MS;
    }
    return false;
  }

  function cadenceFor(game) {
    var status = statusOf(game);
    if (status === 'Live') return POLL_MS;
    if (status === 'Final') {
      var seen = page.finalSeen[game.gamePk] || Date.now();
      page.finalSeen[game.gamePk] = seen;
      return finalGraceDelay(seen, Date.now() - seen);
    }
    return 60000;
  }

  function refreshSchedule() {
    if (page.scheduleInFlight) return;
    page.scheduleInFlight = true;
    page.lastScheduleAt = Date.now();
    MLB.schedule(page.date, { hydrate: '', fields: LEAN_FIELDS, retries: 0 })
      .then(function (payload) {
        var games = [];
        ((payload && payload.dates) || []).forEach(function (d) {
          (d.games || []).forEach(function (g) { games.push(g); });
        });
        var now = Date.now();
        games.forEach(function (g) {
          if (!g || !g.gamePk) return;
          if (page.due[g.gamePk] === undefined) page.due[g.gamePk] = now;
        });
        page.games = games;
        page.lastError = null;
      })
      .catch(function (err) { page.lastError = err; })
      .then(function () {
        page.scheduleInFlight = false;
        render();
      });
  }

  function fetchGame(game) {
    var pk = game.gamePk;
    if (page.inFlight[pk]) return Promise.resolve();
    page.inFlight[pk] = true;
    page.due[pk] = Date.now() + cadenceFor(game);
    return MLB.liveGame(pk, { retries: 0 })
      .then(function (payload) {
        if (!page.store) return;
        var plays = Reviews.playsOf(payload);
        var observedAt = Date.now();
        var state = GameState.snapshot(payload, { gamePk: pk, at: observedAt });
        var prevState = page.gameState[pk] || null;
        page.prevGameState[pk] = prevState;
        page.gameState[pk] = state;
        var added = observe(page.store, {
          gamePk: pk,
          matchupLabel: matchupOf(game),
          plays: plays,
          feed: payload,
          observedAt: observedAt,
          state: state,
          prevState: prevState,
        });
        page.lastCaptureAt = observedAt;
        if (added.length || !page.lastSaveAt || Date.now() - page.lastSaveAt > 5000) {
          page.lastSaveAt = Date.now();
          save(page.date, page.store);
        }
        render();
      })
      .catch(function (err) {
        if (!(err && err.quiet)) page.lastError = err;
        page.due[pk] = Date.now() + 1200;
      })
      .then(function () { page.inFlight[pk] = false; });
  }

  function poll() {
    if (document.hidden) return;
    var now = Date.now();
    if (now - page.lastScheduleAt >= SCHEDULE_MS) refreshSchedule();
    var due = page.games.filter(function (g) {
      return g && g.gamePk && !page.inFlight[g.gamePk] && now >= (page.due[g.gamePk] || 0) && wantsGame(g, now);
    });
    due.forEach(fetchGame);
    if (!page.games.length) render();
  }

  /* -------------------------------------------------------------- rendering */

  function esc(v) { return UI.esc(v === null || v === undefined ? '' : v); }

  function stateBox(label, s, missingNote) {
    if (!s) {
      return '<div class="state-box is-missing"><div class="state-label">' + esc(label) + '</div>' +
        '<div class="state-missing">' + esc(missingNote || 'not captured') + '</div></div>';
    }
    var status = s.status ? ((s.status.detailedState || s.status.abstractGameState || '') +
      (s.status.reason ? ' — ' + s.status.reason : '')) : '—';
    function row(l, v) {
      return '<dt>' + esc(l) + '</dt><dd>' + esc(v === null || v === undefined || v === '' ? '—' : v) + '</dd>';
    }
    return '<div class="state-box">' +
      '<div class="state-label">' + esc(label) +
        '<span class="state-clock">' + esc(s.localClock || '') + ' · ' + esc(s.capturedAt || '') + '</span></div>' +
      '<dl class="state-grid">' +
        row('Score', s.score ? GameState.scoreText(s.score) : '—') +
        row('Inning', s.inning && s.inning.label ? s.inning.label : '—') +
        row('Count', s.balls === null || s.strikes === null ? '—' : s.balls + '-' + s.strikes) +
        row('Outs', s.outs === null ? '—' : s.outs) +
        row('Batter', s.batter && s.batter.name ? s.batter.name : '—') +
        row('Pitcher', s.pitcher && s.pitcher.name ? s.pitcher.name : '—') +
        row('Pitch count', s.pitchCount && s.pitchCount.total !== null ? String(s.pitchCount.total) : '—') +
        row('Runners', s.onBase ? GameState.basesText(s.onBase) : 'not published') +
        row('Official status', status) +
      '</dl>' +
      (s.lastPlay && s.lastPlay.description ? '<div class="state-play">“' + esc(s.lastPlay.description) + '”</div>' : '') +
    '</div>';
  }

  function wordingBox(rec) {
    var bits = [];
    if (rec.wordingBefore) {
      bits.push('<div class="wording-line"><b>Before — official wording</b>' +
        '<span class="wording-type">' + esc(rec.wordingBefore.eventType || '') + '</span>' +
        (rec.wordingBefore.description ? '“' + esc(rec.wordingBefore.description) + '”' : '') +
        (rec.wordingBefore.score ? ' · score ' + esc(GameState.scoreText(rec.wordingBefore.score)) : '') +
        '</div>');
    }
    if (rec.wordingAfter) {
      bits.push('<div class="wording-line"><b>After — official wording</b>' +
        '<span class="wording-type">' + esc(rec.wordingAfter.eventType || '') + '</span>' +
        (rec.wordingAfter.description ? '“' + esc(rec.wordingAfter.description) + '”' : '') +
        (rec.wordingAfter.score ? ' · score ' + esc(GameState.scoreText(rec.wordingAfter.score)) : '') +
        '</div>');
    }
    return bits.length ? '<div class="state-wording">' + bits.join('') + '</div>' : '';
  }

  function kindChip(rec) {
    if (rec.kind === 'pending') return UI.chip(rec.status === 'open' ? 'Pending ruling' : 'Pending → ' + rec.status, 'chip-warn');
    if (rec.kind === 'ruling_resolved') return UI.chip('Pending ruling resolved', 'chip-ok');
    if (rec.kind === 'edit') return UI.chip('Text/score edit flagged', 'chip-warn');
    return UI.chip('Scoring change', 'chip-scoring');
  }

  function statusChip(rec) {
    if (rec.status === 'open') return UI.chip('Open', 'chip-warn');
    if (rec.status === 'resolved') return UI.chip('Resolved', 'chip-ok');
    if (rec.status === 'unresolved') return UI.chip('Unresolved — flagged', 'chip-danger');
    if (rec.status === 'flagged') return UI.chip('Flagged for review', 'chip-danger');
    return UI.chip('Recorded', '');
  }

  function recordCard(rec) {
    var href = 'game.html?gamePk=' + encodeURIComponent(rec.gamePk) + '&date=' + encodeURIComponent(page.date);
    var observations = (rec.observations || []).map(function (o) {
      return '<li><span class="obs-time">' + esc(localClock(o.at)) + '</span> ' +
        '<span class="wording-type">' + esc(o.eventType || '') + '</span> ' + esc(o.description || '') + '</li>';
    }).join('');
    var history = (rec.history || []).map(function (h) {
      return '<li><span class="obs-time">' + esc(localClock(h.at)) + '</span> ' +
        esc(h.from || '—') + ' → ' + esc(h.to || '—') +
        (h.toDescription ? ' — “' + esc(h.toDescription) + '”' : '') + '</li>';
    }).join('');
    return '<article class="scoring-card ' + (rec.status === 'open' ? 'is-open' : '') + '">' +
      '<div class="scoring-head">' +
        '<a href="' + href + '"><b>' + esc(rec.matchupLabel || '') + '</b></a>' +
        '<span>' + esc(rec.inningLabel || '') + '</span>' +
        '<span class="scoring-time" title="Detected at (local, to the second)">detected ' +
          esc(localClock(rec.detectedAt || rec.firstObservedAt)) + '</span>' +
        '<a href="' + esc(rec.source || '#') + '" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
      '</div>' +
      '<div class="scoring-title">' + esc(rec.batter || '') +
        (rec.pitcher ? ' vs ' + esc(rec.pitcher) : '') + '</div>' +
      '<div class="feed-chips">' + kindChip(rec) + statusChip(rec) +
        UI.chip('At-bat #' + rec.atBatIndex, '') +
        (rec.observations && rec.observations.length > 1 ? UI.chip(rec.observations.length + ' observations', '') : '') +
      '</div>' +
      wordingBox(rec) +
      '<div class="state-pair">' +
        stateBox('Before', rec.stateBefore, 'not captured before the change was detected') +
        stateBox('After', rec.stateAfter, 'not captured yet') +
      '</div>' +
      (observations ? '<details class="scoring-more"><summary>Observation journal (' + (rec.observations || []).length + ')</summary><ul>' + observations + '</ul></details>' : '') +
      (history ? '<details class="scoring-more"><summary>Change history (' + (rec.history || []).length + ')</summary><ul>' + history + '</ul></details>' : '') +
      (rec.note ? '<div class="scoring-note">' + esc(rec.note) + '</div>' : '') +
    '</article>';
  }

  function sortedRecords() {
    return (page.store ? page.store.records.slice() : []).sort(function (a, b) {
      return String(b.detectedAt || b.firstObservedAt || '').localeCompare(String(a.detectedAt || a.firstObservedAt || ''));
    });
  }

  function matches(rec, filter) {
    if (!rec) return false;
    if (filter === 'pending') return rec.kind === 'pending';
    if (filter === 'changes') return rec.kind === 'change' || rec.kind === 'ruling_resolved';
    if (filter === 'edits') return rec.kind === 'edit';
    if (filter === 'open') return rec.status === 'open';
    return true;
  }

  function renderStats(records) {
    var el = $('scoring-stats');
    if (!el) return;
    var open = records.filter(function (r) { return r.kind === 'pending' && r.status === 'open'; }).length;
    var resolved = records.filter(function (r) { return r.kind === 'pending' && r.status !== 'open'; }).length;
    var changes = records.filter(function (r) { return r.kind === 'change' || r.kind === 'ruling_resolved'; }).length;
    var edits = records.filter(function (r) { return r.kind === 'edit'; }).length;
    var live = page.games.filter(function (g) { return statusOf(g) === 'Live'; }).length;
    var tiles = [
      { n: open, label: 'Pending rulings', cls: 'is-risk' },
      { n: resolved, label: 'Pending resolved', cls: '' },
      { n: changes, label: 'Scoring changes', cls: '' },
      { n: edits, label: 'Text/score edits', cls: '' },
      { n: live, label: 'Live games', cls: '' },
      { n: records.length, label: 'Logged records', cls: '' },
    ];
    el.innerHTML = tiles.map(function (t) {
      return '<div class="stat-tile ' + t.cls + '"><div class="stat-num">' + t.n + '</div>' +
        '<div class="stat-label">' + esc(t.label) + '</div></div>';
    }).join('');
  }

  function renderTabs(records) {
    var nav = $('scoring-tabs');
    if (!nav) return;
    var tabs = [
      { id: 'all', label: 'All' },
      { id: 'open', label: 'Open / pending' },
      { id: 'pending', label: 'Pending rulings' },
      { id: 'changes', label: 'Scoring changes' },
      { id: 'edits', label: 'Flagged edits' },
    ];
    nav.innerHTML = tabs.map(function (t) {
      var count = records.filter(function (r) { return matches(r, t.id); }).length;
      return '<button class="tab-btn' + (page.filter === t.id ? ' tab-on' : '') + '" data-filter="' + t.id + '">' +
        esc(t.label) + (count ? ' <span class="tab-badge">' + count + '</span>' : '') + '</button>';
    }).join('');
  }

  function renderSignature(records) {
    return page.filter + '|' + page.games.length + '|' +
      page.games.map(function (g) { return g.gamePk + statusOf(g); }).join(',') + '|' +
      records.map(function (r) {
        return [r.id, r.status, r.lastObservedAt, r.resolvedAt,
          r.wordingAfter && r.wordingAfter.eventType,
          r.stateAfter && r.stateAfter.capturedAt].join(':');
      }).join('|') + '|' + (page.lastError ? 'e' : 'ok');
  }

  function render(force) {
    if (!page.store) return;
    var records = sortedRecords();
    var sig = renderSignature(records);
    if (!force && sig === page.renderSignature) return;
    page.renderSignature = sig;
    renderStats(records);
    renderTabs(records);

    var visible = records.filter(function (r) { return matches(r, page.filter); });
    var pending = visible.filter(function (r) { return r.kind === 'pending'; });
    var changes = visible.filter(function (r) { return r.kind !== 'pending'; });

    var pendingEl = $('scoring-pending');
    if (pendingEl) {
      pendingEl.innerHTML = pending.length
        ? pending.map(recordCard).join('')
        : '<div class="feed-empty">No official-scorer pending rulings logged for this date yet. A pending ruling is the API\'s own os_ruling_pending_primary / os_ruling_pending_prior event type — it is captured the first poll after it appears.</div>';
    }
    var changesEl = $('scoring-changes');
    if (changesEl) {
      changesEl.innerHTML = changes.length
        ? changes.map(recordCard).join('')
        : '<div class="feed-empty">No scoring changes or flagged edits logged for this date yet. Each completed play\'s official classification is snapshotted every poll and diffed, so a hit changed to an error (or back) is recorded with the wording and the game state before and after.</div>';
    }

    var label = $('countdown');
    if (label) label.textContent = document.hidden ? 'paused' : 'live';
    var dot = $('live-dot');
    if (dot) dot.style.opacity = page.lastError ? '0.3' : '1';

    if (page.lastError) {
      statusLine('Scan problem: ' + (page.lastError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = page.games.filter(function (g) { return statusOf(g) === 'Live'; }).length;
      statusLine(page.games.length + ' game(s) on ' + MLB.formatDateLabel(page.date) +
        ' · ' + live + ' live · ' + records.length + ' logged record(s)' +
        ' · last capture ' + (page.lastCaptureAt ? GameState.localClock(page.lastCaptureAt) : '—') +
        ' · saved ' + (api.available ? 'locally + shared server log' : 'locally in this browser') +
        ' · storage: ' + KEY_PREFIX + page.date);
    }
  }

  /* --------------------------------------------------------------- public API */

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === page.date) return;
    page.date = clean;
    page.games = [];
    page.due = Object.create(null);
    page.inFlight = Object.create(null);
    page.finalSeen = Object.create(null);
    page.gameState = Object.create(null);
    page.prevGameState = Object.create(null);
    page.lastScheduleAt = 0;
    page.store = null;
    page.lastCaptureAt = 0;
    syncNav();
    statusLine('Loading the official scoring log for ' + MLB.formatDateLabel(clean) + '…');
    load(clean).then(function (store) {
      if (page.date !== clean) return;
      page.store = store;
      shared[clean] = store;
      render();
      openStream(clean);
      poll();
    });
  }

  function setFilter(filter) {
    page.filter = filter;
    render();
  }

  function exportJson() {
    if (!page.store) return false;
    var payload = JSON.stringify({
      exportedAt: isoSecond(Date.now()),
      date: page.date,
      store: page.store,
    }, null, 2);
    try {
      var blob = new global.Blob([payload], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'official-scoring-log-' + page.date + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
      statusLine('Exported ' + sortedRecords().length + ' record(s) for ' + page.date + ' as JSON.', false);
      return true;
    } catch (err) {
      if (global.console && global.console.warn) global.console.warn('[scoring-log] export failed', err);
      statusLine('Export failed in this browser — the log is still saved locally.', true);
      return false;
    }
  }

  function init() {
    page.date = urlDate() || MLB.todayISO();
    syncNav();

    var tabs = $('scoring-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }
    var refresh = $('refresh-btn');
    if (refresh) refresh.addEventListener('click', function () { refreshSchedule(); poll(); });
    var exportBtn = $('export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportJson);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { refreshSchedule(); poll(); }
    });

    load(page.date).then(function (store) {
      page.store = store;
      shared[page.date] = store;
      render();
      openStream(page.date);
      poll();
    });

    /* Fully independent poll loop: the scoring log keeps working even if the
     * replay-feed code (or its sound) is disabled entirely. */
    page.timer = setInterval(poll, 250);
    page.sweepTimer = setInterval(render, 1000);
  }

  global.ScoringLog = {
    init: init,
    observe: observe,
    observeGame: observeGame,
    classificationOf: classificationOf,
    mergeStores: mergeStores,
    mergeRecord: mergeRecord,
    emptyStore: emptyStore,
    normalize: normalize,
    load: load,
    save: save,
    onChange: onChange,
    openStream: openStream,
    closeStream: closeStream,
    isPendingType: function (t) { return PENDING_TYPES.indexOf(t) !== -1; },
    PENDING_TYPES: PENDING_TYPES,
    setDate: setDate,
    setFilter: setFilter,
    prevDay: function () { setDate(MLB.shiftISODate(page.date, -1)); },
    nextDay: function () { setDate(MLB.shiftISODate(page.date, 1)); },
    today: function () { setDate(MLB.todayISO()); },
    pickDate: function () {
      var input = $('date-picker');
      var value = input && input.value;
      setDate(MLB.isValidISODate(value) ? value : page.date);
    },
    exportJson: exportJson,
    state: page,
    api: api,
    MAX_RECORDS: MAX_RECORDS,
    KEY_PREFIX: KEY_PREFIX,
  };

  function boot() {
    if (!$('scoring-pending') && !$('scoring-changes')) return;
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}(window));
