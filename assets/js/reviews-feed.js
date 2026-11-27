/* ============================================================================
 * reviews-feed.js — the all-games Replay Feed (reviews.html)
 *
 * Scans every game on the slate for review events and renders them as a live,
 * chat-style feed:
 *   - manager challenges (M*), umpire/crew-chief reviews (N*), instant replay
 *     (IH), boundary calls (umpire-side home run / fair-foul / stadium-boundary
 *     reviews; charged manager challenges of those plays stay challenges)
 *   - ABS pitch challenges (MJ/NJ) with count before/after
 *   - official-scorer pending rulings (os_ruling_pending_*)
 *   - official scoring changes, detected by diffing each completed play's
 *     classification between polls
 *
 * Every tracked entry is persisted through feed-log.js (localStorage + the
 * optional server store) and restored on the next visit.
 *
 * Latency design (all pull-only, no server of its own to add a hop):
 *   - ONE projected feed/live request per game per scan returns the play-by-play,
 *     the official linescore (score/outs/count/runners), the current plate
 *     appearance AND the official challenge counters (api.js `liveGame`).
 *   - Each game runs on its own timer, staggered across the slate, instead of
 *     the whole slate firing simultaneously every tick.
 *   - A game with a review in progress is polled every 150 ms; other live games
 *     every 250 ms; the hydrated schedule is refreshed every 3 s while a 125 ms
 *     lean status sweep keeps every game's official status current and pulls a
 *     game out of band the instant it flips into a review.
 *   - Every observation is turned into a timestamped official game state
 *     (game-state.js) so each alert row can show the state and the exact
 *     official wording before and after the event.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;
  var GameState = global.GameState;
  var AlertSound = global.AlertSound;

  var SCAN_MS = 250;               // normal live per-game cadence
  var REVIEW_SCAN_MS = 150;        // cadence for a game with a review in progress
  var TICK_MS = 100;               // scheduler tick: picks up every game that is due
  var SCHEDULE_REFRESH_MS = 3000;  // hydrated schedule refresh (teams / new games)
  var STATUS_SWEEP_MS = 125;       // lean official status sweep for the whole slate
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var RENDER_MIN_MS = 400;         // live-state panel repaint floor

  var FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'abs', label: 'ABS' },
    { id: 'challenges', label: 'Challenges' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'boundary', label: 'Boundary Calls' },
    { id: 'under', label: 'Under Review' },
    { id: 'risk', label: '⚠️ Runs at Risk' },
    { id: 'scoring', label: '✏️ Scoring Changes' },
  ];

  var state = {
    date: MLB.todayISO(),
    dateSeq: 0,
    filter: 'all',
    games: [],
    log: null,
    entries: [],
    snapshots: Object.create(null),
    irregularities: Object.create(null),
    finalSeen: Object.create(null),
    nextDue: Object.create(null),
    statusByPk: Object.create(null),
    inFlight: Object.create(null),
    reviewInProgress: Object.create(null),
    gameState: Object.create(null),
    prevGameState: Object.create(null),
    primed: Object.create(null),
    scanning: false,
    scanError: null,
    soundOn: false,
    notifyOn: false,
    lastScanAt: 0,
    lastScheduleAt: 0,
    scheduleInFlight: false,
    timers: { scan: null, sweep: null, countdown: null, persist: null },
    nextScanAt: 0,
    lastRenderSignature: '',
    lastLiveRenderAt: 0,
    liveSignature: '',
    counterCache: Object.create(null),
    lastGameDate: undefined,
    lookingForRecent: false,
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

  /* Keep the address bar in step with the selected date (shareable links).
   * Guarded: history.replaceState is not writable in every embedding context. */
  function syncUrl() {
    try {
      var url = new URL(global.location.href);
      if (url.searchParams.get('date') === state.date) return;
      url.searchParams.set('date', state.date);
      global.history.replaceState(null, '', url.toString());
    } catch (e) { /* ignore */ }
  }

  function syncNav() {
    var picker = $('date-picker');
    if (picker && picker.value !== state.date) picker.value = state.date;
    var label = $('date-label');
    if (label) label.textContent = MLB.formatDateLabel(state.date);
    var backLink = document.querySelector('a.btn[href^="index.html"]');
    if (backLink) backLink.setAttribute('href', 'index.html?date=' + encodeURIComponent(state.date));
    syncUrl();
  }

  function parseDate() {
    /* A ?date=YYYY-MM-DD deep link (reviews.html?date=2026-10-28) wins over the
     * picker, so a shared or bookmarked URL always opens the date it names. */
    var fromUrl = urlDate();
    if (fromUrl) return fromUrl;
    var input = $('date-picker');
    var value = input && input.value;
    return MLB.isValidISODate(value) ? value : MLB.todayISO();
  }

  /* ------------------------------------------------------------ log helpers */

  function upsertEntry(entry) {
    if (!entry || !entry.id) return false;
    var index = -1;
    for (var i = 0; i < state.entries.length; i += 1) {
      if (state.entries[i].id === entry.id) { index = i; break; }
    }
    var now = Date.now();
    if (index === -1) {
      entry.firstSeen = entry.firstSeen || now;
      entry.lastSeen = now;
      state.entries.push(entry);
      return true;
    }
    var prev = state.entries[index];
    var merged = Object.assign({}, prev, entry);
    merged.firstSeen = prev.firstSeen || now;
    merged.lastSeen = now;
    if (prev.scoreTracker && entry.scoreTracker) {
      merged.scoreTracker = Object.assign({}, prev.scoreTracker, entry.scoreTracker);
      /* Never overwrite an observed "before" score with a later guess. */
      if (prev.scoreTracker.before && !entry.scoreTracker.before) {
        merged.scoreTracker.before = prev.scoreTracker.before;
      }
    }
    state.entries[index] = merged;
    return false;
  }

  function noteIrregularity(gamePk, text) {
    if (!gamePk || !text) return;
    var list = state.irregularities[gamePk] || [];
    if (list.indexOf(text) === -1) {
      list.push(text);
      state.irregularities[gamePk] = list.slice(-30);
    }
  }

  function persist(expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!state.log) state.log = FeedLog.emptyPayload(state.date);
    state.log.entries = state.entries.slice();
    state.log.snapshots = state.snapshots;
    state.log.irregularities = state.irregularities;
    state.log.savedAt = Date.now();
    FeedLog.save(state.date, state.log);
  }

  function adoptLog(log) {
    if (!log) return;
    if (log.date && MLB.isValidISODate(log.date) && log.date !== state.date) return;
    state.log = log;
    state.entries = Array.isArray(log.entries)
      ? log.entries.filter(function (e) {
          return !e || !e.officialDate || e.officialDate === state.date;
        })
      : [];
    state.snapshots = log.snapshots || Object.create(null);
    state.irregularities = log.irregularities || Object.create(null);
    /* Restored rows were not observed live: pre-mark runs-at-risk rows so the
     * warning state stays visible but the chime does not fire on restore. */
    state.entries.forEach(function (e) {
      if (e && e.review && e.review.runsAtRiskCount > 0) e.warned = true;
    });
  }

  /* ------------------------------------------------------------- scan cycle */

  function flattenGames(payload) {
    var out = [];
    ((payload && payload.dates) || []).forEach(function (d) {
      (d.games || []).forEach(function (g) { out.push(g); });
    });
    return out;
  }

  function teamsOf(game) {
    return {
      away: {
        id: game.teams && game.teams.away && game.teams.away.team ? game.teams.away.team.id : null,
        name: game.teams && game.teams.away && game.teams.away.team ? game.teams.away.team.name : '',
      },
      home: {
        id: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.id : null,
        name: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.name : '',
      },
    };
  }

  function finalGraceDelay(finalFirstSeen, elapsed) {
    if (elapsed < 2 * 60 * 1000) return 1000;
    if (elapsed < 5 * 60 * 1000) return 2500;
    return 15000;
  }

  function isLiveGame(game) {
    return !!game && !!game.status && game.status.abstractGameState === 'Live';
  }

  function statusOfGame(game) {
    return (game && game.status && game.status.abstractGameState) || '';
  }

  /* Per-game cadence. A game with a live review is the thing the feed exists
   * for, so it gets the fastest cadence; a normal live game 250 ms; a game that
   * has just gone final is re-scanned 1 s -> 2.5 s -> 15 s inside a bounded
   * 30-minute grace (that is when the official scorer publishes changes). */
  function cadenceFor(game) {
    var pk = game.gamePk;
    if (isLiveGame(game)) return state.reviewInProgress[pk] ? REVIEW_SCAN_MS : SCAN_MS;
    if (statusOfGame(game) === 'Final') {
      var seen = state.finalSeen[pk] || Date.now();
      state.finalSeen[pk] = seen;
      return finalGraceDelay(seen, Date.now() - seen);
    }
    return 60000;
  }

  function wantsGame(game, now) {
    var status = statusOfGame(game);
    if (status === 'Live') return true;
    if (status === 'Final') {
      if (!state.finalSeen[game.gamePk]) state.finalSeen[game.gamePk] = now;
      return now - state.finalSeen[game.gamePk] <= FINAL_GRACE_MS;
    }
    return false;
  }

  function gameByPk(pk) {
    for (var i = 0; i < state.games.length; i += 1) {
      if (state.games[i] && Number(state.games[i].gamePk) === Number(pk)) return state.games[i];
    }
    return null;
  }

  /* Fetch one game and ingest it.  One request (MLB.liveGame) carries the
   * events, the linescore, the current PA and the official counters. */
  function startFetch(game) {
    var pk = game.gamePk;
    if (!pk || state.inFlight[pk]) return Promise.resolve();
    var seq = state.dateSeq;
    var date = state.date;
    state.inFlight[pk] = true;
    state.nextDue[pk] = Date.now() + cadenceFor(game);

    return MLB.liveGame(pk, { retries: 0 })
      .then(function (payload) {
        if (seq !== state.dateSeq || date !== state.date) return;
        ingestGame({ game: game, payload: payload }, seq, date);
      })
      .catch(function (err) {
        if (seq !== state.dateSeq || date !== state.date) return;
        if (err && err.quiet) {
          state.nextDue[pk] = Date.now() + 1000;
          return;
        }
        state.scanError = err;
        state.nextDue[pk] = Date.now() + 1000;
      })
      .then(function () {
        state.inFlight[pk] = false;
      });
  }

  function runLimited(items, limit, worker) {
    var index = 0;
    var active = 0;
    return new Promise(function (resolve) {
      if (!items.length) { resolve(); return; }
      function next() {
        if (index >= items.length && active === 0) { resolve(); return; }
        while (active < limit && index < items.length) {
          var item = items[index];
          index += 1;
          active += 1;
          worker(item).then(function () {
            active -= 1;
            next();
          });
        }
      }
      next();
    });
  }

  /* Stagger the first poll of every game across the slate instead of firing
   * every request in the same millisecond. */
  function assignDueTimes(now) {
    var live = state.games.filter(isLiveGame);
    var liveCount = Math.max(1, live.length);
    var liveIndex = 0;
    state.games.forEach(function (game) {
      if (!game || !game.gamePk) return;
      var pk = game.gamePk;
      if (state.nextDue[pk] !== undefined) return;
      if (isLiveGame(game)) {
        state.nextDue[pk] = now + Math.round(liveIndex * (SCAN_MS / liveCount));
        liveIndex += 1;
      } else {
        state.nextDue[pk] = now;
      }
    });
  }

  /* Merge a freshly loaded slate into state.games without throwing away the
   * state we already captured (status, due time, in-flight flags). */
  function mergeGames(games, now) {
    var byPk = Object.create(null);
    games.forEach(function (g) { if (g && g.gamePk) byPk[g.gamePk] = g; });
    var merged = [];
    games.forEach(function (g) {
      if (!g || !g.gamePk) return;
      var existing = gameByPk(g.gamePk);
      if (existing) {
        var wasLive = isLiveGame(existing);
        existing.teams = g.teams || existing.teams;
        existing.gameDate = g.gameDate || existing.gameDate;
        existing.officialDate = g.officialDate || existing.officialDate;
        existing.review = g.review || existing.review;
        if (g.status) existing.status = g.status;
        if (!wasLive && isLiveGame(existing)) state.nextDue[g.gamePk] = 0;
        merged.push(existing);
      } else {
        merged.push(g);
        state.nextDue[g.gamePk] = 0;
        state.primed[g.gamePk] = false;
      }
    });
    state.games = merged;
    assignDueTimes(now);
  }

  function refreshSchedule() {
    if (state.scheduleInFlight) return;
    var seq = state.dateSeq;
    var date = state.date;
    state.scheduleInFlight = true;
    state.lastScheduleAt = Date.now();
    MLB.schedule(date, { ttl: 0, retries: 0 })
      .then(function (payload) {
        if (seq !== state.dateSeq || date !== state.date) return;
        mergeGames(flattenGames(payload), Date.now());
        state.scanError = null;
      })
      .catch(function (err) {
        if (seq !== state.dateSeq || date !== state.date) return;
        state.scanError = err;
      })
      .then(function () {
        if (seq === state.dateSeq && date === state.date) state.scheduleInFlight = false;
        else state.scheduleInFlight = false;
        updateChrome();
      });
  }

  /* ------------------------------------------------------------- scan cycle */

  var persistPending = false;
  function persistSoon() {
    if (state.timers.persist) return;
    state.timers.persist = setTimeout(function () {
      state.timers.persist = null;
      persist();
      renderIfChanged();
    }, 500);
  }

  function tick() {
    if (document.hidden) {
      state.scanning = false;
      scheduleTick(1000);
      return;
    }
    var now = Date.now();
    if (now - state.lastScheduleAt >= SCHEDULE_REFRESH_MS) refreshSchedule();

    var due = [];
    state.games.forEach(function (game) {
      if (!game || !game.gamePk) return;
      if (state.inFlight[game.gamePk]) return;
      if (now < (state.nextDue[game.gamePk] || 0)) return;
      if (!wantsGame(game, now)) {
        state.nextDue[game.gamePk] = now + 5000;
        return;
      }
      due.push(game);
    });

    state.lastScanAt = now;
    if (due.length) {
      state.scanning = true;
      /* In-review games first: they are the ones a human is watching. */
      due.sort(function (a, b) {
        var ar = state.reviewInProgress[a.gamePk] ? 0 : 1;
        var br = state.reviewInProgress[b.gamePk] ? 0 : 1;
        return ar - br;
      });
      runLimited(due, FETCH_CONCURRENCY, function (game) {
        var seq = state.dateSeq;
        var date = state.date;
        if (seq !== state.dateSeq || date !== state.date) return Promise.resolve();
        return startFetch(game);
      }).then(function () {
        state.scanning = false;
        updateChrome();
      });
    } else {
      state.scanning = false;
    }

    updateChrome();
    scheduleTick(TICK_MS);
  }

  /* Compatibility entry point: the Refresh button and the public API call this. */
  function scan() {
    if (document.hidden) { scheduleTick(1000); return; }
    refreshSchedule();
    state.games.forEach(function (game) {
      if (game && game.gamePk && wantsGame(game, Date.now())) state.nextDue[game.gamePk] = 0;
    });
    scheduleTick(0);
  }

  function scheduleTick(delay) {
    clearTimeout(state.timers.scan);
    state.nextScanAt = Date.now() + delay;
    state.timers.scan = setTimeout(tick, delay);
  }

  /* 125 ms official status sweep: catches a review the moment MLB flips it. */
  function sweep() {
    if (document.hidden) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    if (!state.games.length) return;
    MLB.slateStatus(sweepDate).then(function (payload) {
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      games.forEach(function (g) {
        var local = gameByPk(g.gamePk);
        if (local && g.status) {
          var before = statusOfGame(local);
          local.status = g.status;
          if (before !== statusOfGame(local)) {
            /* Official status changed: poll this game now, not on its cadence. */
            state.nextDue[local.gamePk] = 0;
            if (statusOfGame(local) === 'Live') startFetch(local);
          }
        }
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev !== nextKey) {
          state.statusByPk[g.gamePk] = nextKey;
          if (review) {
            /* A review just started: pull this game out of band immediately. */
            state.nextDue[g.gamePk] = 0;
            var target = local || gameByPk(g.gamePk);
            if (target) startFetch(target);
          }
        }
      });
    }).catch(function () { /* the scan owns error reporting */ });
  }

  function ingestGame(result, expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!result || !result.payload) {
      if (result && result.error && !(result.error && result.error.quiet)) {
        state.scanError = result.error;
      }
      return;
    }
    var game = result.game;
    var payload = result.payload;
    var plays = Reviews.playsOf(payload);
    var teams = teamsOf(game);
    var meta = { gamePk: game.gamePk, teams: teams, feed: payload };

    /* ---- official game state, captured when THIS observation landed ---- */
    var observedAt = Date.now();
    var snap = null;
    try {
      snap = GameState.snapshot(payload, { gamePk: game.gamePk, at: observedAt });
    } catch (err) {
      snap = null;
      noteIrregularity(game.gamePk, 'Could not build a game-state snapshot from the payload this poll.');
    }
    var prevSnap = state.gameState[game.gamePk] || null;
    if (snap) {
      state.prevGameState[game.gamePk] = prevSnap;
      state.gameState[game.gamePk] = snap;
    }

    /* The first observation of a game is a baseline: it restores/creates the
     * rows but does not sound an alert for history that was already in the
     * payload when the page opened. */
    var primed = state.primed[game.gamePk] === true;
    var newEvents = 0;

    /* ---- reviews */
    var reviews = Reviews.extractReviews(plays, meta);
    reviews.forEach(function (review) {
      var existing = state.entries.find(function (e) { return e.id === review.id; });
      var before = existing && existing.scoreTracker && existing.scoreTracker.before ? existing.scoreTracker.before : null;

      var scoreTracker = {
        before: before,
        possible: null,
        actual: null,
      };

      if (review.inProgress) {
        /* Call-on-field score while the review is still open = the score the
         * review is deciding on.  Taken from the official linescore/result. */
        scoreTracker.before = review.score || before;
      } else {
        scoreTracker.actual = review.scoreAfter || null;
        if (!scoreTracker.before) {
          /* Never infer or fill in the pre-ruling score when the page opened
           * after resolution (README §"Before / Possible / Actual score tracker"). */
          noteIrregularity(game.gamePk, 'Before-review score was not observed for ' + review.id + ' (page opened after the ruling).');
        }
      }
      if (scoreTracker.before && review.runsAtRiskCount > 0) {
        scoreTracker.possible = {
          away: scoreTracker.before.away,
          home: scoreTracker.before.home,
        };
        scoreTracker.possible[review.battingSide] = Math.max(0, scoreTracker.possible[review.battingSide] - review.runsAtRiskCount);
      }

      var entry = {
        id: review.id,
        kind: 'review',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        review: review,
        scoreTracker: scoreTracker,
        firstSeenLabel: MLB.formatGameTime(game.gameDate),
      };

      /* Before / after state: "before" is the first state this page observed
       * for the event and is never overwritten; "after" is the first state
       * observed once the official ruling exists. */
      if (existing && existing.stateBefore) entry.stateBefore = existing.stateBefore;
      else if (review.inProgress && snap) entry.stateBefore = snap;
      if (existing && existing.stateAfter) entry.stateAfter = existing.stateAfter;
      else if (!review.inProgress && snap) entry.stateAfter = snap;
      if (!review.inProgress && !entry.stateBefore) entry.beforeNotObserved = true;

      /* Exact official wording, captured at each observation (the payload
       * rewrites the play description when a call is overturned). */
      var wording = (existing && existing.wording) || {};
      var nextWording = { before: wording.before || null, after: wording.after || null };
      if (!nextWording.before && review.description) nextWording.before = review.description;
      if (!review.inProgress && !nextWording.after && review.description) nextWording.after = review.description;
      if (nextWording.before || nextWording.after) entry.wording = nextWording;
      if (snap) {
        entry.statusBefore = entry.stateBefore && entry.stateBefore.status ? entry.stateBefore.status : entry.statusBefore;
        entry.statusAfter = entry.stateAfter && entry.stateAfter.status ? entry.stateAfter.status : entry.statusAfter;
      }

      var isNew = upsertEntry(entry);
      /* Always operate on the stored entry: upsertEntry merges into the
       * existing object, so flags like `warned` live there. */
      entry = state.entries.find(function (e) { return e.id === entry.id; }) || entry;
      if (isNew) newEvents += 1;

      /* Every event that lands in the feed alerts — including ABS pitch
       * challenges, which are logged and shown in the ABS tab. */
      if (isNew && primed) chime('review');
      if (review.runsAtRiskCount > 0 && !entry.warned) {
        /* The moment an active review could remove a run, once per entry. */
        entry.warned = true;
        if (primed) {
          chime('risk');
          notifyRunAtRisk(review, teams);
        }
      }
    });
    state.reviewInProgress[game.gamePk] = reviews.some(function (r) { return r.inProgress; });

    /* ---- official-scorer pending rulings */
    var pending = Reviews.pendingRulings(plays, meta);
    var pendingIds = Object.create(null);
    pending.forEach(function (row) {
      pendingIds[row.id] = true;
      var existing = state.entries.find(function (e) { return e.id === row.id; });
      var next = {
        id: row.id,
        kind: 'pending',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        pending: row,
        review: {
          typeLabel: 'Official Scorer Ruling Pending',
          reason: row.eventType === 'os_ruling_pending_primary' ? 'Primary event ruling pending' : 'Prior event ruling pending',
          inningLabel: row.inningLabel,
          description: row.description,
          batter: { name: row.batter },
          pitcher: { name: row.pitcher },
          outcome: 'Pending',
          isABS: false,
          isBoundary: false,
          runsAtRiskCount: 0,
          family: 'pending',
        },
      };
      if (snap) {
        next.stateBefore = (existing && existing.stateBefore) || snap;
        next.stateAfter = (existing && existing.stateAfter) || null;
      }
      var nextWording = {
        before: (existing && existing.wording && existing.wording.before) || row.description || null,
        after: (existing && existing.wording && existing.wording.after) || null,
      };
      next.wording = nextWording;
      var isNewPending = upsertEntry(next);
      if (isNewPending) {
        newEvents += 1;
        if (primed) chime('pending');
      }
    });

    /* A pending row that is no longer flagged in the payload has been ruled on:
     * attach the final official wording and state, and keep the row. */
    var playByAtBat = Object.create(null);
    plays.forEach(function (p) {
      var i = Number(p && p.about && p.about.atBatIndex);
      if (isFinite(i)) playByAtBat[i] = p;
    });
    state.entries.forEach(function (entry) {
      if (!entry || entry.gamePk !== game.gamePk || entry.kind !== 'pending' || entry.resolved) return;
      if (pendingIds[entry.id]) return;
      var atBatIndex = Number(entry.pending && entry.pending.atBatIndex);
      var play = playByAtBat[atBatIndex];
      if (!play) {
        entry.resolutionNote = 'Pending ruling is no longer in the payload and the at-bat was not found — left unresolved for review.';
        return;
      }
      var res = play.result || {};
      entry.resolved = true;
      entry.resolvedAt = snap ? snap.capturedAt : GameState.isoSecond(Date.now());
      if (snap) entry.stateAfter = snap;
      entry.resolution = {
        eventType: res.eventType || '',
        description: res.description || '',
        isOut: res.isOut === true,
        rbi: typeof res.rbi === 'number' ? res.rbi : null,
        score: Reviews.scoreOf(play, payload),
      };
      entry.wording = Object.assign({}, entry.wording, { after: res.description || null });
      entry.review = Object.assign({}, entry.review, {
        outcome: 'Resolved' + (res.eventType ? ' → ' + res.eventType : ''),
        description: res.description || entry.review.description,
      });
      newEvents += 1;
      if (primed) chime('pending');
    });

    /* ---- official scoring changes */
    var snapshot = Reviews.snapshotPlays(plays);
    var previous = state.snapshots[game.gamePk];
    var diff = Reviews.diffSnapshots(previous, snapshot);
    state.snapshots[game.gamePk] = snapshot;

    diff.changes.forEach(function (change) {
      var id = game.gamePk + ':' + change.atBatIndex + ':scoring-change';
      var existing = state.entries.find(function (e) { return e.id === id; });
      var entry = {
        id: id,
        kind: 'scoring_change',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        change: change,
        review: {
          typeLabel: 'Official Scoring Change',
          reason: '',
          inningLabel: change.inningLabel,
          description: 'Initial call: ' + (change.from.description || '') + ' → Final: ' + (change.to.description || ''),
          batter: { name: change.batter },
          pitcher: { name: '' },
          outcome: 'Reclassified',
          isABS: false,
          isBoundary: false,
          runsAtRiskCount: 0,
          family: 'scoring',
        },
      };
      if (existing && existing.stateBefore) entry.stateBefore = existing.stateBefore;
      else if (prevSnap) entry.stateBefore = prevSnap;
      if (snap) entry.stateAfter = snap;
      entry.wording = {
        before: (existing && existing.wording && existing.wording.before) || change.from.description || '',
        after: change.to.description || (existing && existing.wording && existing.wording.after) || '',
      };
      var history = (existing && existing.changeHistory) || [];
      history = history.concat([{
        observedAt: snap ? snap.capturedAt : GameState.isoSecond(Date.now()),
        from: change.from.eventType || '',
        to: change.to.eventType || '',
        descriptionAfter: change.to.description || '',
        scoreAfter: change.scoreAfter || null,
      }]);
      entry.changeHistory = history.slice(-25);

      var isNewChange = upsertEntry(entry);
      if (isNewChange) {
        newEvents += 1;
        if (primed) chime('scoring');
      }
      if (state.log) {
        state.log.grace = state.log.grace || {};
        state.log.grace[game.gamePk] = Date.now();
      }
    });

    diff.edits.forEach(function (edit) {
      noteIrregularity(game.gamePk, 'Play ' + edit.atBatIndex + ' edited without reclassification (' +
        edit.inningLabel + ') — flagged, not corrected.');
    });
    diff.vanished.forEach(function (gone) {
      noteIrregularity(game.gamePk, 'Play ' + gone.atBatIndex + ' (' + gone.inningLabel +
        ') disappeared from the payload after being observed — flagged, not corrected.');
    });

    /* ---- counter regressions & official MGR / ABS counters (same payload) */
    state.counterCache = state.counterCache || Object.create(null);
    var prevCached = state.counterCache[game.gamePk] || null;
    var gdCounters = payload.gameData || null;
    var rawMgr = (gdCounters && gdCounters.review) || payload.review || (game.review || null);
    var rawAbs = (gdCounters && gdCounters.absChallenges) || payload.absChallenges || null;
    var reviewCounters = Reviews.managerCounters(rawMgr) || (prevCached && prevCached.manager) || null;
    var absCounters = Reviews.absCounters(rawAbs) || (prevCached && prevCached.abs) || null;

    var regression = Reviews.counterRegression(prevCached, {
      manager: reviewCounters, abs: absCounters,
    });
    if (regression) {
      regression.forEach(function (note) {
        noteIrregularity(game.gamePk, 'Official counter ' + note + ' — flagged, not corrected.');
      });
    }
    state.counterCache[game.gamePk] = {
      manager: reviewCounters,
      abs: absCounters,
      awayAbbr: UI.abbr(teams.away),
      homeAbbr: UI.abbr(teams.home),
    };

    /* ---- this observation is complete: arm alerts for the game ---- */
    state.primed[game.gamePk] = true;
    state.lastScanAt = Date.now();
    state.scanError = null;
    if (newEvents) persistSoon();

    /* ---- the independent official-scoring log (separate store, separate
     *      failure domain: a bug there can never stop an alert) ---- */
    if (global.ScoringLog && typeof global.ScoringLog.observeGame === 'function') {
      try {
        global.ScoringLog.observeGame({
          gamePk: game.gamePk,
          matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
          teams: teams,
          plays: plays,
          feed: payload,
          observedAt: observedAt,
          state: snap,
          prevState: prevSnap,
        });
      } catch (err) {
        if (global.console && global.console.warn) {
          global.console.warn('[replay-feed] scoring log observer failed (alerts unaffected)', err);
        }
      }
    }

    renderLiveState();
    renderIfChanged();
  }

  /* ------------------------------------------------------------- sound/notify */

  /* The sound itself lives in alert-sound.js: one ~3 s rain-drop signature,
   * queued (never overlapping) and muted by a stored preference. Every event
   * that lands in the feed asks for an alert; the first observation of each
   * game primes it silently so opening the page mid-game does not fire a burst
   * for history that was already in the payload. */
  function chime(kind) {
    /* One source of truth for the preference: alert-sound.js (the toggle writes
     * it and state.soundOn mirrors it). Every event that lands in the feed asks
     * for an alert, including ABS pitch challenges, pending rulings and scoring
     * changes; the module queues them so sounds never overlap. */
    if (!AlertSound) return;
    try { AlertSound.play(kind || 'alert'); } catch (e) { /* audio is a nicety */ }
  }

  function notifyRunAtRisk(review, teams) {
    if (!state.notifyOn) return;
    if (typeof global.Notification !== 'function') return;
    if (global.Notification.permission !== 'granted') return;
    try {
      var title = '⚠️ Run at risk — ' + UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
      var body = review.typeLabel + (review.reason ? ' (' + review.reason + ')' : '') +
        ' · ' + review.inningLabel + ' — ' + review.runsAtRiskCount + ' run(s) credited to the reviewed play.';
      new global.Notification(title, { body: body, tag: review.id });
    } catch (e) { /* ignore */ }
  }

  function loadPref(key, fallback) {
    try {
      var raw = global.localStorage.getItem('mlbp.pref.' + key);
      return raw === null ? fallback : raw === '1';
    } catch (e) { return fallback; }
  }

  function savePref(key, value) {
    try { global.localStorage.setItem('mlbp.pref.' + key, value ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ render */

  function entryMatches(entry, filter) {
    if (!entry) return false;
    if (filter === 'all') return (entry.kind === 'review' || entry.kind === 'pending' || entry.kind === 'scoring_change') && !(entry.review && entry.review.isABS);
    if (filter === 'abs') return entry.review && entry.review.isABS;
    if (filter === 'challenges') return entry.review && entry.review.family === 'manager';
    if (filter === 'reviews') return entry.review && (entry.review.family === 'umpire' || entry.review.family === 'replay');
    if (filter === 'boundary') return entry.review && entry.review.isBoundary;
    if (filter === 'under') return entry.review && entry.review.inProgress;
    if (filter === 'risk') return entry.review && entry.review.runsAtRiskCount > 0;
    if (filter === 'scoring') return entry.kind === 'scoring_change';
    return true;
  }

  function visibleEntries() {
    return state.entries.filter(function (e) { return entryMatches(e, state.filter); })
      .sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  }

  function statsFor() {
    var s = { total: 0, manager: 0, umpire: 0, abs: 0, boundary: 0, under: 0, risk: 0, scoring: 0 };
    state.entries.forEach(function (e) {
      if (e.kind === 'scoring_change') { s.scoring += 1; return; }
      if (e.kind !== 'review') return;
      var r = e.review;
      if (!r) return;
      if (r.isABS) s.abs += 1; else s.total += 1;
      if (r.family === 'manager') s.manager += 1;
      if (r.family === 'umpire' || r.family === 'replay') s.umpire += 1;
      if (r.isBoundary) s.boundary += 1;
      if (r.inProgress) s.under += 1;
      if (r.runsAtRiskCount > 0) s.risk += 1;
    });
    return s;
  }

  function renderTabs() {
    var nav = $('feed-tabs');
    if (!nav) return;
    nav.innerHTML = FILTERS.map(function (f) {
      var count = state.entries.filter(function (e) { return entryMatches(e, f.id); }).length;
      return '<button class="tab-btn' + (state.filter === f.id ? ' tab-on' : '') + '" data-filter="' + f.id + '">' +
        UI.esc(f.label) + (count ? ' <span class="tab-badge">' + count + '</span>' : '') + '</button>';
    }).join('');
  }

  function renderStats() {
    var el = $('feed-stats');
    if (!el) return;
    var s = statsFor();
    var tiles = [
      { n: s.total, label: 'Reviews', cls: '' },
      { n: s.manager, label: 'Challenges', cls: '' },
      { n: s.umpire, label: 'Umpire reviews', cls: '' },
      { n: s.abs, label: 'ABS challenges', cls: '' },
      { n: s.boundary, label: 'Boundary calls', cls: '' },
      { n: s.under, label: 'Under review', cls: '' },
      { n: s.risk, label: 'Runs at risk', cls: 'is-risk' },
      { n: s.scoring, label: 'Scoring changes', cls: '' },
    ];
    el.innerHTML = tiles.map(function (t) {
      return '<div class="stat-tile ' + t.cls + '"><div class="stat-num">' + t.n + '</div>' +
        '<div class="stat-label">' + UI.esc(t.label) + '</div></div>';
    }).join('');
  }

  function renderBanner() {
    var el = $('banner');
    if (!el) return;
    var atRisk = state.entries.filter(function (e) {
      return e.review && e.review.inProgress && e.review.runsAtRiskCount > 0;
    });
    if (!atRisk.length) { el.innerHTML = ''; return; }
    el.innerHTML = atRisk.map(function (e) {
      var r = e.review;
      return '<div class="banner-item">' +
        '⚠️ <strong>' + UI.esc(r.runsAtRiskCount + ' run' + (r.runsAtRiskCount === 1 ? '' : 's') + ' at risk') + '</strong>' +
        ' — <a class="banner-link" href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '">' +
        UI.esc(e.matchupLabel || '') + '</a> · ' + UI.esc(r.typeLabel + (r.reason ? ': ' + r.reason : '')) +
        (r.inningLabel ? ' (' + UI.esc(r.inningLabel) + ')' : '') +
      '</div>';
    }).join('');
  }

  function renderActiveStrip() {
    var el = $('active-strip');
    if (!el) return;
    var active = state.entries.filter(function (e) { return e.review && e.review.inProgress; });
    if (!active.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="active-strip"><h3>Under review</h3><div class="active-items">' +
      active.map(function (e) {
        var r = e.review;
        var cached = state.counterCache && state.counterCache[e.gamePk];
        var bothSummary = cached ? Reviews.countersSummary(cached) : '';
        return '<div class="active-item">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(e.matchupLabel || '') + '</b></a>' +
          UI.chip(r.typeLabel + (r.reason ? ': ' + r.reason : ''), r.isABS ? 'chip-abs' : 'chip-review') +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.runsAtRiskCount ? UI.chip('⚠️ ' + r.runsAtRiskCount + ' run(s) at risk', 'chip-danger') : '') +
          (bothSummary ? '<span class="counter-note">' + UI.esc(bothSummary) + '</span>' : '') +
          '</div>';
      }).join('') + '</div></div>';
  }

  function scoreLine(label, score) {
    if (!score) return '';
    return '<dt>' + UI.esc(label) + '</dt><dd>' + UI.esc(score.away) + '–' + UI.esc(score.home) + '</dd>';
  }

  /* One captured official game state, rendered as a labelled box. Every value
   * is read from the snapshot (game-state.js); a field the payload did not
   * publish reads "—" rather than a guess. */
  function stateRow(label, value) {
    return '<dt>' + UI.esc(label) + '</dt><dd>' + UI.esc(value === null || value === undefined || value === '' ? '—' : value) + '</dd>';
  }

  function stateBlock(label, s, missingNote) {
    if (!s) {
      return '<div class="state-box is-missing">' +
        '<div class="state-label">' + UI.esc(label) + '</div>' +
        '<div class="state-missing">' +
        UI.esc(missingNote || 'not captured by this page') +
        '</div></div>';
    }
    var status = s.status
      ? (s.status.detailedState || s.status.abstractGameState || '') +
        (s.status.reason ? ' — ' + s.status.reason : '')
      : '—';
    var batters = s.onBase ? GameState.basesText(s.onBase) : 'not published by this endpoint';
    return '<div class="state-box">' +
      '<div class="state-label">' + UI.esc(label) +
        '<span class="state-clock" title="Captured by this page at the second shown">' +
          UI.esc(s.localClock || '') + ' · ' + UI.esc(s.capturedAt || '') +
        '</span></div>' +
      '<dl class="state-grid">' +
        stateRow('Score', s.score ? GameState.scoreText(s.score) : '—') +
        stateRow('Inning', s.inning && s.inning.label ? s.inning.label : '—') +
        stateRow('Count', s.balls === null || s.strikes === null ? '—' : s.balls + '-' + s.strikes) +
        stateRow('Outs', s.outs === null ? '—' : s.outs) +
        stateRow('Batter', s.batter && s.batter.name ? s.batter.name : '—') +
        stateRow('Pitcher', s.pitcher && s.pitcher.name ? s.pitcher.name : '—') +
        stateRow('Pitch count', s.pitchCount && s.pitchCount.total !== null ? String(s.pitchCount.total) : '—') +
        stateRow('Runners', batters) +
        stateRow('Official status', status) +
      '</dl>' +
      (s.lastPlay && s.lastPlay.description
        ? '<div class="state-play">“' + UI.esc(s.lastPlay.description) + '”</div>'
        : '') +
      (s.source === 'playByPlay'
        ? '<div class="state-note">Runners on base are not published by the playByPlay fallback — not shown rather than guessed.</div>'
        : '') +
    '</div>';
  }

  /* The exact official wording observed before and after the event. */
  function wordingBlock(entry) {
    var w = entry.wording;
    if (!w || (!w.before && !w.after)) return '';
    var bits = [];
    if (w.before) bits.push('<div class="wording-line"><b>Before — official wording</b>“' + UI.esc(w.before) + '”</div>');
    if (w.after) bits.push('<div class="wording-line"><b>After — official wording</b>“' + UI.esc(w.after) + '”</div>');
    if (entry.kind === 'pending' && entry.resolution) {
      bits.push('<div class="wording-line"><b>Final ruling</b>' +
        UI.esc(entry.resolution.eventType || '') +
        (entry.resolution.description ? ' — “' + UI.esc(entry.resolution.description) + '”' : '') +
        (entry.resolution.score ? ' · score after ' + UI.esc(GameState.scoreText(entry.resolution.score)) : '') +
        '</div>');
    }
    return '<div class="state-wording">' + bits.join('') + '</div>';
  }

  function statePairHtml(entry) {
    if (!entry.stateBefore && !entry.stateAfter) return '';
    return '<div class="state-pair">' +
      stateBlock('Before', entry.stateBefore,
        entry.beforeNotObserved ? 'not observed before the ruling (the page opened after it)' : 'not captured') +
      stateBlock('After', entry.stateAfter, 'not captured yet') +
      '</div>' + wordingBlock(entry);
  }

  function renderRow(entry) {
    var r = entry.review || {};
    var tracker = entry.scoreTracker || {};
    var cls = 'feed-row';
    if (r.inProgress) cls += ' is-live';
    if (r.runsAtRiskCount) cls += ' is-at-risk';

    var avatar = r.isABS ? '🎯' : r.isBoundary ? '📏' : entry.kind === 'scoring_change' ? '✏️' : entry.kind === 'pending' ? '📝' : '🚨';

    var chips = [];
    chips.push(UI.chip(r.typeLabel || 'Review', r.isABS ? 'chip-abs' : 'chip-review'));
    if (r.reason) chips.push(UI.chip(r.reason, 'chip-review'));
    if (r.isBoundary) chips.push(UI.chip('Boundary call', 'chip-warn'));
    if (r.inProgress) chips.push(UI.chip('Under review', 'chip-warn'));
    else if (r.outcome) chips.push(UI.chip(r.outcome, r.outcome === 'Overturned' ? 'chip-ok' : ''));
    if (r.runsAtRiskCount) chips.push(UI.chip('⚠️ ' + r.runsAtRiskCount + ' run(s) at risk', 'chip-danger'));

    var trackerHtml = '';
    if (entry.kind === 'review' && (tracker.before || tracker.possible || tracker.actual)) {
      trackerHtml = '<dl class="score-track">' +
        (tracker.before ? scoreLine('Before review', tracker.before) : '<dt>Before review</dt><dd>— (not observed before ruling)</dd>') +
        (tracker.possible ? scoreLine('Possible after (conditional)', tracker.possible)
          : (r.isBoundary && !(r.runsAtRiskCount > 0)
            /* README: "A boundary review with no currently credited run says
             * 'score impact pending' and does not invent an alternate score." */
            ? '<dt>Possible after (conditional)</dt><dd>score impact pending</dd>'
            : (r.runsAtRiskCount > 0
              ? '<dt>Possible after (conditional)</dt><dd>— (not observed before ruling)</dd>'
              : ''))) +
        scoreLine('Actual after (official)', tracker.actual) +
        '</dl>';
    }

    var absLine = '';
    if (r.isABS && r.absCountBefore) {
      absLine = '<div class="feed-sub">Pitch ' + UI.esc(r.absPitchNumber) +
        ' · count before ' + r.absCountBefore.balls + '-' + r.absCountBefore.strikes +
        (r.absCountAfter ? ' · after ' + r.absCountAfter.balls + '-' + r.absCountAfter.strikes : '') + '</div>';
    }

    var counterText = '';
    var counterSummaryTitle = '';
    var cached = state.counterCache && state.counterCache[entry.gamePk];
    /* README counter examples prefix the challenging team's abbreviation
     * ("CIN: 2 ABS challenges left now (…)" / "PIT: 1 manager challenge left
     * now (0 used)"). */
    var challengerLabel = (r.challengerSide && entry.teams && entry.teams[r.challengerSide])
      ? UI.abbr(entry.teams[r.challengerSide]) : '';
    if (cached) {
      counterSummaryTitle = Reviews.countersSummary(cached);
      if (r.family === 'manager' && r.challengerSide && cached.manager && cached.manager[r.challengerSide]) {
        counterText = Reviews.counterLine({ manager: cached.manager, side: r.challengerSide, label: challengerLabel });
      }
      if (r.isABS && r.challengerSide && cached.abs && cached.abs[r.challengerSide]) {
        counterText = Reviews.counterLine({ abs: cached.abs, side: r.challengerSide, label: challengerLabel });
      }
      if (!counterText && counterSummaryTitle) {
        counterText = counterSummaryTitle;
      }
    }

    var changeHtml = '';
    if (entry.kind === 'scoring_change' && entry.change) {
      changeHtml = '<div class="feed-sub">Initial call: ' + UI.esc(entry.change.from && entry.change.from.description ? entry.change.from.description : '') +
        '</div><div class="feed-sub">Final ruling: ' + UI.esc(entry.change.to && entry.change.to.description ? entry.change.to.description : '') + '</div>' +
        (entry.change.scoreAfter ? '<div class="feed-sub">Official score after the play: ' +
          UI.esc(entry.change.scoreAfter.away) + '–' + UI.esc(entry.change.scoreAfter.home) + '</div>' : '') +
        '<div class="feed-irregular">Attribution: ' + UI.esc(entry.change.attribution || '') + '</div>';
    }

    var pendingHtml = '';
    if (entry.kind === 'pending' && entry.pending) {
      pendingHtml = '<div class="feed-sub">' + UI.esc(entry.pending.description || '') + '</div>' +
        '<div class="feed-irregular">Source: ' + UI.esc(entry.pending.source || '') + '</div>';
    }

    /* Irregularity notes that name this entry's id belong on this row only —
     * never repeat a game's first note on every row. Game-level notes (no
     * entry id) render once as flagged rows in renderList. */
    var irregularity = '';
    (state.irregularities[entry.gamePk] || []).some(function (n) {
      if (entry.id && n.indexOf(entry.id) !== -1) { irregularity = n; return true; }
      return false;
    });

    return '<div class="' + cls + '">' +
      '<div class="feed-avatar">' + avatar + '</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.challengerSide && r.challengerSide !== 'unknown' && r.challenger
            ? '<span>Challenged by ' + UI.esc(r.challenger) + (r.challengerRole ? ' (' + UI.esc(r.challengerRole) + ')' : '') + '</span>' : '') +
          '<span>' + new Date(entry.lastSeen || Date.now()).toLocaleTimeString() + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc((r.batter && r.batter.name) || '') +
          (r.pitcher && r.pitcher.name ? ' vs ' + UI.esc(r.pitcher.name) : '') + '</div>' +
        (r.description ? '<div class="feed-sub">' + UI.esc(r.description) + '</div>' : '') +
        absLine + changeHtml + pendingHtml +
        statePairHtml(entry) +
        (trackerHtml ? trackerHtml : '') +
        (counterText ? '<div class="counter-note"' + (counterSummaryTitle ? ' title="' + UI.esc(counterSummaryTitle) + '"' : '') + '>' + UI.esc(counterText) + '</div>' : '') +
        (irregularity ? '<div class="feed-irregular">⚠️ ' + UI.esc(irregularity) + '</div>' : '') +
        '<div class="feed-chips">' + chips.join('') + '</div>' +
      '</div>' +
    '</div>';
  }

  /* Same idea as the scoreboard: only touch the DOM when the tracked data
   * actually changed, so a 250 ms scan does not re-create identical rows. */
  function offerRecentDate() {
    if (state.lastGameDate !== undefined || state.lookingForRecent) return;
    state.lookingForRecent = true;
    var reqSeq = state.dateSeq;
    var reqDate = state.date;
    var from = MLB.shiftISODate(reqDate, -180);
    MLB.scheduleRange(from, reqDate)
      .then(function (payload) {
        if (reqSeq !== state.dateSeq || reqDate !== state.date) return;
        var dates = ((payload && payload.dates) || []).filter(function (d) {
          return d && d.totalGames > 0;
        });
        state.lastGameDate = dates.length ? dates[dates.length - 1].date : null;
      })
      .catch(function () {
        if (reqSeq === state.dateSeq && reqDate === state.date) state.lastGameDate = null;
      })
      .then(function () {
        if (reqSeq !== state.dateSeq || reqDate !== state.date) return;
        state.lookingForRecent = false;
        if (state.lastGameDate) render();
      });
  }

  function entriesSignature() {
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|' + state.entries.map(function (e) {
      return [e.id, e.review && e.review.outcome, e.review && e.review.inProgress,
        e.review && e.review.description,
        e.scoreTracker && e.scoreTracker.actual ? e.scoreTracker.actual.away + '-' + e.scoreTracker.actual.home : '',
        e.scoreTracker && e.scoreTracker.before ? e.scoreTracker.before.away + '-' + e.scoreTracker.before.home : '',
        e.stateBefore && e.stateBefore.capturedAt, e.stateAfter && e.stateAfter.capturedAt,
        e.resolved ? 'r' : '', e.resolution && e.resolution.eventType,
        e.wording && e.wording.before ? 'b' : '', e.wording && e.wording.after ? 'a' : '',
        e.change && e.change.to ? e.change.to.eventType : ''].join(':');
    }).join('|');
  }

  function renderIfChanged() {
    var sig = entriesSignature();
    if (sig === state.lastRenderSignature) return;
    state.lastRenderSignature = sig;
    render();
  }

  /* One flagged row for a game-level irregularity (a note that names no
   * entry). Rendered once per note above the entry rows: flagged for review,
   * never corrected or hidden (uploaded reviews.html footer). */
  function flaggedRowHtml(entry, note) {
    return '<div class="feed-row flagged-row">' +
      '<div class="feed-avatar">🚩</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>Flagged for review</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-irregular">⚠️ ' + UI.esc(note) + '</div>' +
        '<div class="feed-chips">' + UI.chip('Irregularity', 'chip-warn') + UI.chip('Source data', 'chip-review') + '</div>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------- official game state
   * Every game on the slate, with the last official state this page captured:
   * score, inning, outs, count, batter, pitcher, pitch count, runners and the
   * second the capture landed.  This is the "state of the game as it happens"
   * surface — it is not a prediction and it only shows payload values. */
  function liveFlagsFor(gamePk) {
    var flags = [];
    var seen = Object.create(null);
    state.entries.forEach(function (e) {
      if (!e || Number(e.gamePk) !== Number(gamePk)) return;
      var label = null;
      var cls = 'chip-warn';
      if (e.review && e.review.inProgress) {
        label = e.review.typeLabel || 'Review';
      } else if (e.kind === 'pending' && !e.resolved) {
        label = '📝 Scoring pending';
      } else if (e.kind === 'scoring_change' && (Date.now() - (e.lastSeen || 0)) < 10 * 60 * 1000) {
        label = '✏️ Scoring change';
        cls = 'chip-scoring';
      }
      if (label && !seen[label]) { seen[label] = true; flags.push({ label: label, cls: cls }); }
    });
    return flags;
  }

  function liveCard(game) {
    var pk = game.gamePk;
    var teams = teamsOf(game);
    var snap = state.gameState[pk] || null;
    var status = statusOfGame(game);
    var cls = 'ls-card' + (status === 'Live' ? ' is-live' : (status === 'Final' ? ' is-final' : ' is-preview'));
    var flags = liveFlagsFor(pk).map(function (f) { return UI.chip(f.label, f.cls); }).join('');
    var href = 'game.html?gamePk=' + encodeURIComponent(pk) + '&date=' + encodeURIComponent(state.date);

    if (!snap) {
      return '<div class="' + cls + '">' +
        '<div class="ls-top"><a href="' + href + '"><b>' + UI.esc(UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home)) + '</b></a>' +
        '<span class="ls-status">' + UI.esc((game.status && game.status.detailedState) || status || '—') + '</span></div>' +
        '<div class="ls-awaiting">' + (status === 'Preview'
          ? 'First pitch ' + UI.esc(MLB.formatGameTime(game.gameDate) || 'TBD') + ' — state capture starts when the game does.'
          : 'Awaiting the first capture for this game…') + '</div>' +
        (flags ? '<div class="ls-flags">' + flags + '</div>' : '') +
      '</div>';
    }

    var scoreLine = snap.score
      ? '<div class="ls-score"><span>' + UI.esc(UI.abbr(teams.away)) + ' <b>' + UI.esc(snap.score.away) + '</b></span>' +
        '<span>' + UI.esc(UI.abbr(teams.home)) + ' <b>' + UI.esc(snap.score.home) + '</b></span></div>'
      : '<div class="ls-score"><span>' + UI.esc(MLB.formatGameTime(game.gameDate) || 'TBD') + '</span></div>';

    var detail = [];
    if (snap.inning && snap.inning.label) detail.push(snap.inning.label);
    if (snap.balls !== null && snap.strikes !== null) detail.push('count ' + snap.balls + '-' + snap.strikes);
    if (snap.outs !== null) detail.push(snap.outs + ' out' + (snap.outs === 1 ? '' : 's'));
    if (snap.pitchCount && snap.pitchCount.total !== null) detail.push('P ' + snap.pitchCount.total);
    if (snap.onBase) detail.push(GameState.basesText(snap.onBase));

    var matchup = [];
    if (snap.batter && snap.batter.name) matchup.push(snap.batter.name + ' at bat');
    if (snap.pitcher && snap.pitcher.name) matchup.push('vs ' + snap.pitcher.name);

    return '<div class="' + cls + '">' +
      '<div class="ls-top"><a href="' + href + '"><b>' + UI.esc(UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home)) + '</b></a>' +
        '<span class="ls-status">' + UI.esc((snap.status && (snap.status.detailedState || snap.status.abstractGameState)) || status || '—') + '</span>' +
        '<span class="ls-clock" title="The second this page captured the state shown">' + UI.esc(snap.localClock || '') + '</span></div>' +
      scoreLine +
      (detail.length ? '<div class="ls-line">' + UI.esc(detail.join(' · ')) + '</div>' : '') +
      (matchup.length ? '<div class="ls-line ls-matchup">' + UI.esc(matchup.join(' ')) + '</div>' : '') +
      (snap.lastPlay && snap.lastPlay.description
        ? '<div class="ls-play">“' + UI.esc(snap.lastPlay.description) + '”</div>' : '') +
      '<div class="ls-foot">Captured ' + UI.esc(snap.capturedAt || '') +
        ' · ' + UI.esc(snap.source === 'playByPlay' ? 'playByPlay fallback' : 'feed/live') + '</div>' +
      (flags ? '<div class="ls-flags">' + flags + '</div>' : '') +
    '</div>';
  }

  function liveStateSignature() {
    return state.games.map(function (g) {
      var s = state.gameState[g.gamePk];
      return [
        g.gamePk,
        statusOfGame(g),
        state.reviewInProgress[g.gamePk] ? 'r' : '',
        s ? s.capturedAt : '',
        s && s.score ? s.score.away + '-' + s.score.home : '',
        s ? s.outs : '', s ? s.balls : '', s ? s.strikes : '',
      ].join(':');
    }).join('|');
  }

  function renderLiveState() {
    var el = $('live-state');
    if (!el) return;
    var sig = liveStateSignature();
    if (sig === state.liveSignature) return;
    var now = Date.now();
    if (state.lastLiveRenderAt && now - state.lastLiveRenderAt < RENDER_MIN_MS) return;
    state.liveSignature = sig;
    state.lastLiveRenderAt = now;

    if (!state.games.length) {
      el.innerHTML = '';
      return;
    }
    var order = { Live: 0, Preview: 1, Final: 2 };
    var games = state.games.slice().sort(function (a, b) {
      var d = (order[statusOfGame(a)] === undefined ? 3 : order[statusOfGame(a)]) -
        (order[statusOfGame(b)] === undefined ? 3 : order[statusOfGame(b)]);
      if (d) return d;
      return String(a.gameDate || '').localeCompare(String(b.gameDate || ''));
    });
    var live = games.filter(isLiveGame).length;
    el.innerHTML = '<div class="live-state">' +
      '<div class="live-state-head"><h3>Official live game state</h3>' +
        '<span class="live-state-note">' + games.length + ' game(s) · ' + live + ' live · every capture time-stamped to the second</span>' +
      '</div>' +
      '<div class="ls-grid">' + games.map(liveCard).join('') + '</div>' +
    '</div>';
  }

  function render() {
    renderBanner();
    renderLiveState();
    renderTabs();
    renderStats();
    renderActiveStrip();
    var list = $('feed-list');
    if (!list) return;
    var rows = visibleEntries();
    if (!rows.length) {
      var emptyNote = 'No tracked events for this date and filter yet. New challenges, reviews, boundary calls, ABS challenges, official-scorer pending rulings and official scoring changes appear here live.';
      if (!state.games.length && !state.entries.length) {
        list.innerHTML = '<div class="panel" style="text-align:center;color:var(--muted)">' +
          'No games scheduled for ' + UI.esc(MLB.formatDateLabel(state.date)) + '.' +
          '<div class="feed-empty">' + UI.esc(emptyNote) + '</div>' +
          (state.lastGameDate
            ? '<div style="margin-top:10px">Most recent date with games: ' +
              UI.esc(MLB.formatDateLabel(state.lastGameDate)) + ' ' +
              '<button class="btn" onclick="ReplayFeed.setDate(\'' + state.lastGameDate + '\')">Show it</button></div>'
            : '') +
          '</div>';
        offerRecentDate();
      } else {
        list.innerHTML = '<div class="feed-empty">' + UI.esc(emptyNote) + '</div>';
      }
      return;
    }
    var flagged = [];
    var seenGames = Object.create(null);
    rows.forEach(function (e) {
      if (!e || seenGames[e.gamePk]) return;
      seenGames[e.gamePk] = true;
      (state.irregularities[e.gamePk] || []).forEach(function (n) {
        var namesEntry = state.entries.some(function (x) {
          return x && x.gamePk === e.gamePk && x.id && n.indexOf(x.id) !== -1;
        });
        if (!namesEntry) flagged.push(flaggedRowHtml(e, n));
      });
    });
    list.innerHTML = flagged.join('') + rows.map(renderRow).join('');
  }

  function updateChrome() {
    var label = $('countdown');
    if (label) {
      var left = Math.max(0, state.nextScanAt - Date.now());
      label.textContent = document.hidden ? 'paused' : (left / 1000).toFixed(1) + 's';
    }
    var dot = $('live-dot');
    if (dot) dot.style.opacity = state.scanError ? '0.3' : '1';
    if (state.scanError) {
      statusLine('Scan problem: ' + (state.scanError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = state.games.filter(isLiveGame).length;
      var captured = Object.keys(state.gameState).length;
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked entr' + (state.entries.length === 1 ? 'y' : 'ies') +
        ' · ' + captured + ' state capture(s) · last capture ' +
        (state.lastScanAt ? GameState.localClock(state.lastScanAt) : '—') +
        ' · poll ' + (REVIEW_SCAN_MS / 1000).toFixed(2) + 's in review / ' + (SCAN_MS / 1000).toFixed(2) + 's live' +
        (FeedLog.state.available ? ' · shared log connected' : ' · local log only'));
    }
  }

  /* -------------------------------------------------------------------- nav */

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === state.date) return;
    state.dateSeq += 1;
    var seq = state.dateSeq;
    clearTimeout(state.timers.scan);
    state.scanning = false;
    state.date = clean;
    state.games = [];
    state.entries = [];
    state.snapshots = Object.create(null);
    state.irregularities = Object.create(null);
    state.finalSeen = Object.create(null);
    state.nextDue = Object.create(null);
    state.statusByPk = Object.create(null);
    state.counterCache = Object.create(null);
    state.inFlight = Object.create(null);
    state.reviewInProgress = Object.create(null);
    state.gameState = Object.create(null);
    state.prevGameState = Object.create(null);
    state.primed = Object.create(null);
    state.lastScheduleAt = 0;
    state.scheduleInFlight = false;
    state.liveSignature = '';
    state.lastLiveRenderAt = 0;
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.lastRenderSignature = '';
    syncNav();
    render();
    FeedLog.closeStream();
    FeedLog.load(clean).then(function (log) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptLog(log);
      render();
      FeedLog.openStream(clean);
      scan();
    });
  }

  function setFilter(filter) { state.filter = filter; render(); }

  function syncSoundUi() {
    var btn = $('sound-toggle-btn');
    if (btn) {
      btn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      btn.classList.toggle('btn-on', state.soundOn);
      btn.setAttribute('aria-pressed', state.soundOn ? 'true' : 'false');
    }
    var vol = $('sound-volume');
    if (vol && AlertSound) {
      var pct = Math.round(AlertSound.getVolume() * 100);
      if (String(vol.value) !== String(pct)) vol.value = String(pct);
    }
  }

  function toggleSound() {
    state.soundOn = AlertSound ? AlertSound.toggle() : !state.soundOn;
    syncSoundUi();
    if (state.soundOn) { try { AlertSound.test('preview'); } catch (e) { /* mute context */ } }
    statusLine(state.soundOn
      ? 'Alert sound ON — a 3-second rain-drop alert plays for every new event in the feed (challenges, reviews, ABS, pending rulings, scoring changes, runs at risk). Use “Test alert” any time.'
      : 'Alert sound OFF — the feed, the state captures and the scoring log keep running. Use “Test alert” to check audio while muted.', false);
  }

  function testSound() {
    var played = false;
    try { played = AlertSound ? AlertSound.test('preview') : false; } catch (e) { played = false; }
    statusLine(played
      ? (state.soundOn ? 'Test alert played — sound is ON.' : 'Test alert played — sound is muted, so this was a one-off test.')
      : 'This browser could not start audio. Click anywhere on the page first (browsers require a user gesture), then try again.', !played);
  }

  function setSoundVolume(value) {
    if (!AlertSound) return;
    AlertSound.setVolume(Number(value) / 100);
    if (!state.soundOn) {
      statusLine('Volume set to ' + Math.round(AlertSound.getVolume() * 100) + '% — sound is still off.', false);
    }
  }

  function toggleNotify() {
    state.notifyOn = !state.notifyOn;
    savePref('notify', state.notifyOn);
    var btn = $('notify-toggle-btn');
    if (btn) {
      btn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      btn.classList.toggle('btn-on', state.notifyOn);
    }
    if (state.notifyOn && typeof global.Notification === 'function' &&
      global.Notification.permission === 'default') {
      global.Notification.requestPermission();
    }
  }

  function init() {
    state.date = urlDate() || parseDate();
    syncNav();
    state.soundOn = AlertSound ? AlertSound.isEnabled() : loadPref('sound', false);
    state.notifyOn = loadPref('notify', false);

    FeedLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptLog(FeedLog.mergePayloads(state.log, pushed, state.date));
        render();
      }
    });

    syncSoundUi();
    var soundBtn = $('sound-toggle-btn');
    if (soundBtn) soundBtn.addEventListener('click', toggleSound);
    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', testSound);
    var volume = $('sound-volume');
    if (volume) volume.addEventListener('input', function () { setSoundVolume(volume.value); });
    var notifyBtn = $('notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      notifyBtn.classList.toggle('btn-on', state.notifyOn);
      notifyBtn.addEventListener('click', toggleNotify);
    }
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { scan(); });

    var tabs = $('feed-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        scan();
      } else {
        /* Flush the coalesced write when the tab goes away. */
        if (state.timers.persist) { clearTimeout(state.timers.persist); state.timers.persist = null; }
        persist();
      }
    });

    Reviews.loadRegistry();

    var initSeq = state.dateSeq;
    var initDate = state.date;
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
      scan();
    });

    state.timers.sweep = setInterval(sweep, STATUS_SWEEP_MS);
    state.timers.countdown = setInterval(updateChrome, 200);
  }

  global.ReplayFeed = {
    init: init,
    prevDay: function () { setDate(MLB.shiftISODate(state.date, -1)); },
    nextDay: function () { setDate(MLB.shiftISODate(state.date, 1)); },
    today: function () { setDate(MLB.todayISO()); },
    pickDate: function () {
      /* The picker is the user's own choice; a ?date= deep link seeds the first
       * view but must not override a later pick. */
      var input = $('date-picker');
      var value = input && input.value;
      setDate(MLB.isValidISODate(value) ? value : state.date);
    },
    setDate: setDate,
    setFilter: setFilter,
    toggleSound: toggleSound,
    testSound: testSound,
    setSoundVolume: setSoundVolume,
    toggleNotify: toggleNotify,
    scan: scan,
    renderLiveState: renderLiveState,
    state: state,
    SCAN_MS: SCAN_MS,
    REVIEW_SCAN_MS: REVIEW_SCAN_MS,
    TICK_MS: TICK_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    SCHEDULE_REFRESH_MS: SCHEDULE_REFRESH_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
