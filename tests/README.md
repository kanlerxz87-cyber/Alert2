# tests/ — how this site is checked

Everything here runs against the **shipped** files. Nothing is a mock of the app; the only stubbed
thing is the HTTP layer, and it is stubbed with payloads copied verbatim from the official MLB
StatsAPI (see each fixture's `_provenance` block).

| Check | Command | What it proves | Official Source |
| --- | --- | --- | --- |
| Link / asset check | `node tests/link-check.mjs` | every `href`, `src` and CSS `url()` in the site resolves to a file that exists, and no page uses a root-absolute path that would break under `/Alert2/` | [`tests/link-check.mjs`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/tests/link-check.mjs) |
| Contract check | `node tests/contract-check.mjs` | every inline handler (`onclick="Scoreboard.prevDay()"`), every `getElementById()` target and the script load order are consistent across the pages — a typo here would silently disable a feature | [`tests/contract-check.mjs`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/tests/contract-check.mjs) |
| End-to-end render | `node tests/jsdom-render-test.mjs` | the real `index.html`, `game.html`, `reviews.html`, `scoring.html`, `404.html` + all real scripts render games, scores, play-by-play, review rows, the timestamped game-state board, the scoring log, linescore, boxscore, props and tabs, with no uncaught error | [`tests/jsdom-render-test.mjs`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/tests/jsdom-render-test.mjs) |
| State capture & scoring log | `node tests/jsdom-render-test.mjs` (sections 3c/3d) | `GameState.snapshot` reads the score/outs/count/pitch count/wording out of the official fixture and stamps the capture to the second; `ScoringLog.observe` records a pending ruling, resolves it to a real event type, logs a hit→error reclassification with before/after wording and state, merges idempotently, persists to `localStorage`, and the scoring page renders it | [`assets/js/game-state.js`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/assets/js/game-state.js) · [`assets/js/scoring-log.js`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/assets/js/scoring-log.js) |
| Alert path | `npm test` (§G-3, §sound toggles) | every new event in the feed asks for exactly one alert (`AlertSound.stats.attempts`), runs-at-risk fires once per entry, the toggle persists and the Test button requests one alert — no audio device needed | [`assets/js/alert-sound.js`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/assets/js/alert-sound.js) |
| Same, live data | `node tests/jsdom-render-test.mjs --live` | identical page run, but every StatsAPI request goes to `https://statsapi.mlb.com` for real — the reproducible official-data check | [`statsapi.mlb.com`](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-28&hydrate=probablePitcher,linescore,decisions,review) |
| Props provenance | `node tests/props-provenance-test.mjs` | every rendered `<table class="driver-table">` row has a verified official `statsapi.mlb.com` source link and zero fabricated values | [`tests/props-provenance-test.mjs`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/tests/props-provenance-test.mjs) |
| Local server | `node server.mjs` then `curl localhost:8000/api/health` | the optional persistence backend (static files + feed-log GET/POST/SSE + a separate scoring-log GET/POST/SSE store) | [`server.mjs`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/server.mjs) |
| All of the above | `node tests/run-all.mjs` | summarized pass/fail | [`tests/run-all.mjs`](https://github.com/kanlerxz87-cyber/Alert2/blob/main/tests/run-all.mjs) |

```bash
npm install --no-save jsdom     # dev-only, not shipped with the site
node tests/run-all.mjs
```

`jsdom` is the only dependency and it is optional: without it the render test prints `SKIPPED`
(the link, contract and syntax checks still run). The site itself has **no** build step, no
frameworks and no runtime dependencies.

## Fixtures

`tests/fixtures/` holds three trimmed official responses. Values were copied unchanged; only
unrelated branches were removed, and each file says which responses it came from and on what date:

| Fixture | Captured from | Official Source |
| --- | --- | --- |
| `schedule-2026-08-28.json` | `GET /api/v1/schedule?sportId=1&date=2026-08-28&hydrate=review,probablePitcher,decisions,linescore` | [MLB `schedule` `2026-08-28`](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-28&hydrate=review,probablePitcher,decisions,linescore) |
| `feed-824638-review.json` | `GET /api/v1.1/game/824638/feed/live`, `GET /api/v1/game/824474/playByPlay`, same schedule call | [MLB `feed/live` `824638`](https://statsapi.mlb.com/api/v1.1/game/824638/feed/live) · [MLB `playByPlay` `824474`](https://statsapi.mlb.com/api/v1/game/824474/playByPlay) |
| `gamestatus.json` | `GET /api/v1/gameStatus` | [MLB `gameStatus`](https://statsapi.mlb.com/api/v1/gameStatus) |

The scoring-log checks in `tests/jsdom-render-test.mjs` also use **synthetic but official-shaped**
plays (a completed `os_ruling_pending_primary` at-bat, then the same at-bat carrying `single`, then
`field_error`) to exercise pending → resolved and hit → error detection. They are labelled as such
in the test and are never presented as captured data.

Full field-by-field provenance and the list of items that could **not** be verified:
[`docs/verification-report.md`](../docs/verification-report.md) and [`flagged.html`](../flagged.html).
