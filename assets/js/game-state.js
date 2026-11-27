/* ============================================================================
 * game-state.js — official live game state, captured to the second
 *
 * The replay feed's alerting has to say not just "a review happened" but what
 * the game looked like at that second and what it looked like after the ruling.
 * This module turns one official StatsAPI payload into a flat, timestamped
 * snapshot of the game, and can diff two snapshots field by field.
 *
 * Snapshot fields (all read from the official payload, never invented):
 *   capturedAt / capturedAtMs / localClock  when THIS page observed the state
 *   source                                  feed/live or the playByPlay fallback
 *   status                                  gameData.status (abstract/detailed/code/reason)
 *   inning                                  liveData.linescore or the current play's `about`
 *   score, outs, balls, strikes
 *   batter, pitcher                         linescore.offense when published, else matchup
 *   onBase                                  linescore.offense.first/second/third (names)
 *   pitchCount                              every `isPitch:true` playEvent + the current PA
 *   lastPlay                                last completed play: type, description, runs
 *
 * Anything the payload did not publish stays null — the renderer says "not
 * published by this endpoint" instead of guessing a value.
 * ==========================================================================*/
(function (global) {
  'use strict';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* UTC ISO string truncated to the whole second: 2026-08-28T19:04:12Z.
   * (The raw millisecond value is kept alongside it as capturedAtMs.) */
  function isoSecond(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) t = Date.now();
    var d = new Date(Math.floor(t / 1000) * 1000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + 'Z';
  }

  /* Local wall clock with seconds — the "time stamped down to the second"
   * the feed shows.  toLocaleTimeString is used so the hour format follows the
   * reader's locale; the UTC ISO string is always stored next to it. */
  function localClock(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) t = Date.now();
    try {
      return new Date(t).toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
    } catch (e) {
      return isoSecond(t).slice(11, 19);
    }
  }

  function playsOf(payload) {
    if (!payload) return [];
    if (payload.liveData && payload.liveData.plays && Array.isArray(payload.liveData.plays.allPlays)) {
      return payload.liveData.plays.allPlays;
    }
    if (Array.isArray(payload.allPlays)) return payload.allPlays;
    return [];
  }

  function currentPlayOf(payload) {
    var p = payload && payload.liveData && payload.liveData.plays && payload.liveData.plays.currentPlay;
    return p || payload.currentPlay || null;
  }

  function linescoreOf(payload) {
    return (payload && payload.liveData && payload.liveData.linescore) || payload.linescore || null;
  }

  function numOrNull(v) {
    var n = Number(v);
    return (v === null || v === undefined || v === '' || !isFinite(n)) ? null : n;
  }

  function personOf(p) {
    if (!p) return null;
    return { id: numOrNull(p.id), name: p.fullName || p.name || '' };
  }

  function pitchesIn(play) {
    var count = 0;
    ((play && play.playEvents) || []).forEach(function (ev) {
      if (ev && ev.isPitch === true) count += 1;
    });
    return count;
  }

  function lastPlayOf(plays) {
    for (var i = (plays || []).length - 1; i >= 0; i -= 1) {
      if (plays[i]) return plays[i];
    }
    return null;
  }

  function halfLabel(half, inning) {
    if (!inning) return '';
    var top = String(half || '').toLowerCase().indexOf('top') === 0;
    return (top ? 'Top ' : 'Bot ') + inning;
  }

  /**
   * snapshot(payload, opts)
   *   opts.at      epoch ms of THIS observation (defaults to now)
   *   opts.gamePk  game id when the payload projection omits gameData.game
   * Returns a plain object safe to JSON-serialize and persist.
   */
  function snapshot(payload, opts) {
    opts = opts || {};
    var at = Number(opts.at) || Date.now();
    var plays = playsOf(payload);
    var current = currentPlayOf(payload);
    var linescore = linescoreOf(payload);
    var gameData = (payload && payload.gameData) || null;
    var status = (gameData && gameData.status) || (payload && payload.status) || null;
    var last = lastPlayOf(plays);

    var about = (current && current.about) || (last && last.about) || {};
    var count = (current && current.count) || (last && last.count) || {};
    var matchup = (current && current.matchup) || (last && last.matchup) || {};
    var lsTeams = (linescore && linescore.teams) || null;
    var lsOffense = (linescore && linescore.offense) || null;

    var score = null;
    if (lsTeams && numOrNull(lsTeams.away && lsTeams.away.runs) !== null &&
      numOrNull(lsTeams.home && lsTeams.home.runs) !== null) {
      score = { away: numOrNull(lsTeams.away.runs), home: numOrNull(lsTeams.home.runs) };
    } else {
      var result = (last && last.result) || {};
      if (numOrNull(result.awayScore) !== null && numOrNull(result.homeScore) !== null) {
        score = { away: numOrNull(result.awayScore), home: numOrNull(result.homeScore) };
      }
    }

    var inningNumber = numOrNull(linescore && linescore.currentInning);
    var half = (linescore && (linescore.inningHalf || linescore.inningState)) || about.halfInning || null;
    if (inningNumber === null) inningNumber = numOrNull(about.inning);

    /* Pitch count: every pitch event in every completed play, plus the
     * in-progress PA when the linescore's current at-bat is not yet in
     * allPlays. Never estimated from outs or innings. */
    var totalPitches = null;
    if (plays.length) {
      totalPitches = 0;
      plays.forEach(function (p) { totalPitches += pitchesIn(p); });
      var currentIndex = numOrNull(current && current.about && current.about.atBatIndex);
      var maxIndex = -1;
      plays.forEach(function (p) {
        var i = numOrNull(p && p.about && p.about.atBatIndex);
        if (i !== null && i > maxIndex) maxIndex = i;
      });
      if (currentIndex !== null && currentIndex > maxIndex) totalPitches += pitchesIn(current);
    }
    var atBatPitches = current ? pitchesIn(current) : (last ? pitchesIn(last) : null);
    if (atBatPitches === 0 && current && current.playEvents === undefined) atBatPitches = null;

    var onBase = null;
    if (lsOffense) {
      onBase = {
        first: personOf(lsOffense.first),
        second: personOf(lsOffense.second),
        third: personOf(lsOffense.third),
      };
    }

    var batter = personOf((lsOffense && lsOffense.batter) || matchup.batter);
    var pitcher = personOf((lsOffense && lsOffense.pitcher) || matchup.pitcher);

    var lastResult = (last && last.result) || {};
    var lastAbout = (last && last.about) || {};
    var lastPlay = last ? {
      atBatIndex: numOrNull(lastAbout.atBatIndex),
      eventType: lastResult.eventType || '',
      description: lastResult.description || '',
      isScoringPlay: lastAbout.isScoringPlay === true,
      rbi: numOrNull(lastResult.rbi),
      scoreAfter: (numOrNull(lastResult.awayScore) !== null && numOrNull(lastResult.homeScore) !== null)
        ? { away: numOrNull(lastResult.awayScore), home: numOrNull(lastResult.homeScore) }
        : null,
    } : null;

    var official = [];
    if (status) {
      official.push(status.detailedState || status.abstractGameState || '');
      if (status.reason) official.push(status.reason);
    }
    if (lastPlay && lastPlay.description) official.push(lastPlay.description);

    return {
      gamePk: numOrNull(opts.gamePk !== undefined ? opts.gamePk : (gameData && gameData.game && gameData.game.pk)),
      capturedAt: isoSecond(at),
      capturedAtMs: at,
      localClock: localClock(at),
      source: payload && payload.__source ? payload.__source : (linescore ? 'feed/live' : 'playByPlay'),
      status: status ? {
        abstractGameState: status.abstractGameState || '',
        detailedState: status.detailedState || '',
        statusCode: status.statusCode || '',
        reason: status.reason || '',
      } : null,
      inning: {
        number: inningNumber,
        half: half,
        state: (linescore && (linescore.inningState || linescore.inningHalf)) || null,
        ordinal: (linescore && linescore.currentInningOrdinal) || null,
        label: halfLabel(half, inningNumber),
      },
      score: score,
      /* The linescore is the official CURRENT state (outs, count) for this
       * observation; a play's count is the state after that play, so it is only
       * used when the payload has no linescore (the playByPlay fallback). */
      outs: numOrNull(linescore && linescore.outs !== undefined ? linescore.outs : count.outs),
      balls: numOrNull(linescore && linescore.balls !== undefined ? linescore.balls : count.balls),
      strikes: numOrNull(linescore && linescore.strikes !== undefined ? linescore.strikes : count.strikes),
      batter: batter,
      pitcher: pitcher,
      onBase: onBase,
      pitchCount: { total: totalPitches, thisAtBat: atBatPitches },
      lastPlay: lastPlay,
      official: official.filter(Boolean),
    };
  }

  function scoreText(score) {
    if (!score) return '—';
    return score.away + '–' + score.home;
  }

  function basesText(onBase) {
    if (!onBase) return 'not published';
    var bits = [];
    if (onBase.first && onBase.first.name) bits.push('1B ' + onBase.first.name);
    if (onBase.second && onBase.second.name) bits.push('2B ' + onBase.second.name);
    if (onBase.third && onBase.third.name) bits.push('3B ' + onBase.third.name);
    return bits.length ? bits.join(' · ') : 'bases empty';
  }

  function countText(s) {
    if (!s) return '—';
    var c = (s.balls === null ? '—' : s.balls) + '-' + (s.strikes === null ? '—' : s.strikes);
    var o = s.outs === null ? '—' : s.outs + ' out' + (s.outs === 1 ? '' : 's');
    return c + ' · ' + o;
  }

  /* One-line description of a captured state, used in rows and the live board. */
  function describe(s) {
    if (!s) return '';
    var bits = [];
    if (s.score) bits.push(scoreText(s.score));
    if (s.inning && s.inning.label) bits.push(s.inning.label);
    bits.push(countText(s));
    if (s.pitchCount && s.pitchCount.total !== null) bits.push('P ' + s.pitchCount.total);
    return bits.join(' · ');
  }

  /* Field-by-field comparison. Only fields the two snapshots both published are
   * compared — a payload that omits runners never becomes a "change". */
  function diff(before, after) {
    var out = [];
    if (!before || !after) return out;

    function add(key, label, b, a) {
      if (b === undefined || a === undefined) return;
      if (b === null || a === null) return;
      if (String(b) === String(a)) return;
      out.push({ key: key, label: label, before: b, after: a });
    }

    add('score', 'Score', before.score && scoreText(before.score), after.score && scoreText(after.score));
    add('inning', 'Inning', before.inning && before.inning.label, after.inning && after.inning.label);
    add('outs', 'Outs', before.outs, after.outs);
    add('count', 'Count', (before.balls !== null && before.strikes !== null) ? before.balls + '-' + before.strikes : null,
      (after.balls !== null && after.strikes !== null) ? after.balls + '-' + after.strikes : null);
    add('batter', 'Batter', before.batter && before.batter.name, after.batter && after.batter.name);
    add('pitcher', 'Pitcher', before.pitcher && before.pitcher.name, after.pitcher && after.pitcher.name);
    add('status', 'Official status', before.status && before.status.detailedState, after.status && after.status.detailedState);
    add('pitchCount', 'Pitch count', before.pitchCount && before.pitchCount.total, after.pitchCount && after.pitchCount.total);
    if (before.onBase && after.onBase) {
      add('bases', 'Runners', basesText(before.onBase), basesText(after.onBase));
    }
    return out;
  }

  global.GameState = {
    snapshot: snapshot,
    playsOf: playsOf,
    currentPlayOf: currentPlayOf,
    linescoreOf: linescoreOf,
    diff: diff,
    describe: describe,
    basesText: basesText,
    countText: countText,
    scoreText: scoreText,
    isoSecond: isoSecond,
    localClock: localClock,
  };
}(window));
