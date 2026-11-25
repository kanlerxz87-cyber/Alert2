# Independent copy and upcoming-slate verification — 2026-11-25

Session: `arena/42012815-alert2`  
Repository branch: `arena/42012815-alert2`  
Outcome: copied site behavior confirmed against the cited replay date and an officially scheduled 2027 slate; one official `startTimeTBD` display defect was fixed and regression-tested.

## 1. Upstream-copy comparison

The upstream GitHub repository reports latest commit [`5c02527d3c7a56ea66c698cfabff80a407b6dfd3`](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527d3c7a56ea66c698cfabff80a407b6dfd3). A fresh archive of that commit was compared with the Alert2 worktree on 2026-11-25.

| Files compared | Result | Source |
|---|---|---|
| `index.html`, `reviews.html`, `game.html`, `server.mjs` | Byte-identical | [Upstream commit](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) |
| `assets/css/style.css` and all eight `assets/js/*.js` files | Byte-identical before this session's `startTimeTBD` correction in `scoreboard.js` and `game.js` | [Upstream assets at commit](https://github.com/snapquast73-boop/LIVPBP/tree/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/assets) |
| `404.html` | Intentionally different: the Alert2 version resolves the project base path for both `/Alert2/` and `/LIVPBP/`; the upstream one handles `/LIVPBP/` only | [Upstream `404.html`](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/404.html) · [Alert2 404 regression](../tools/smoke-test.mjs) |

This establishes the copy provenance for the page, server, style, and JS files and identifies the intentional deployment-specific 404 change. The two JS edits in this session are documented under finding A420-F1 below.

## 2. Live parity: cited reference date

Fetched both deployed pages with cache-busting query parameters on 2026-11-25:

- [Reference `reviews.html?date=2026-08-26`](https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26&verify=42012815)
- [Alert2 `reviews.html?date=2026-08-26`](https://kanlerxz87-cyber.github.io/Alert2/reviews.html?date=2026-08-26&verify=42012815)

Both rendered the same 8 summary counts (`10` reviews, `8` challenges, `2` umpire reviews, `68` ABS challenges, `1` boundary call, `0` under review, `1` run at risk, `0` scoring changes), the same 10 review rows, and the same 15-game/78-entry footer. Matchups, review text, inning labels, outcomes, scores and challenge counters matched. The game links correctly use each site's own domain; their scan timestamps and row ordering are timing-dependent. The row-by-row official evidence is recorded in [COORDINATION.md, session `arena/0b8a9a74`](../COORDINATION.md) and on the site's [Flagged for Review page](../flagged.html).

Official cross-check sources for those displayed values: [2026-08-26 MLB schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26), [reviewed games' official play-by-play](https://statsapi.mlb.com/api/v1/game/823180/playByPlay), [official review-status registry](https://statsapi.mlb.com/api/v1/gameStatus), and [game challenge-counter feed](https://statsapi.mlb.com/api/v1.1/game/823180/feed/live?fields=gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed). The prior record contains direct gamePk-specific links for every one of the 10 rows.

## 3. Current offseason and upcoming-slate behavior

| Claim checked | Official MLB source | Deployed page observed | Result |
|---|---|---|---|
| No MLB games are scheduled for 2026-11-25 | [Schedule for 2026-11-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&hydrate=probablePitcher,linescore,decisions,review) returns `totalGames: 0` and `dates: []` | [Alert2 scoreboard for 2026-11-25](https://kanlerxz87-cyber.github.io/Alert2/?date=2026-11-25) renders “No games scheduled” | Match |
| Latest official scheduled date through 2026-11-25 is 2026-10-28 | [Official schedule range, 2026-10-01 through 2026-11-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2026-10-01&endDate=2026-11-25&fields=dates,date,totalGames) returns its last date as `2026-10-28` | The offseason empty state offers 2026-10-28 | Match |
| 2027-03-25 slate has 14 games | [Official 2027-03-25 schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-03-25&fields=dates,date,totalGames,games,gamePk,gameDate,officialDate,status,abstractGameState,codedGameState,detailedState,statusCode,startTimeTBD,abstractGameCode,teams,away,home,team,id,name,venue&hydrate=review) | [Alert2 scoreboard for 2027-03-25](https://kanlerxz87-cyber.github.io/Alert2/?date=2027-03-25&verify=42012815) shows 14 game cards; [Replay Feed](https://kanlerxz87-cyber.github.io/Alert2/reviews.html?date=2027-03-25&verify=42012815) shows 14 games and an empty-state notice | Match on game count; scheduled team pairs on the scoreboard match the official schedule |

## 4. Finding A420-F1 — unconfirmed time displayed as a clock (fixed)

The official schedule returns `status.startTimeTBD: true` for three 2027-03-25 games while also supplying placeholder-looking `gameDate` strings: `854131` (CLE @ CHC, `08:33Z`), `852663` (COL @ SF, `10:33Z`), and `853388` (ATL @ LAD, `10:33Z`). Those raw timestamps do **not** verify a scheduled start time. Before this fix, the scoreboard formatted `gameDate` and displayed local clock values for the three games; the game detail page also formatted the timestamp without checking the official flag.

- Official per-slate evidence: [2027-03-25 schedule with `startTimeTBD` explicitly projected](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-03-25&fields=dates,date,totalGames,games,gamePk,gameDate,officialDate,status,abstractGameState,codedGameState,detailedState,statusCode,startTimeTBD,abstractGameCode,teams,away,home,team,id,name,venue&hydrate=review).
- Independent game-feed confirmation for game 854131: [official feed status and datetime](https://statsapi.mlb.com/api/v1.1/game/854131/feed/live?fields=gameData,datetime,dateTime,officialDate,status,startTimeTBD,gamePk) returns `startTimeTBD: true` alongside `2027-03-25T08:33:00Z`.
- Fix: `assets/js/scoreboard.js` and `assets/js/game.js` now render `TBD` when an upcoming game's official status has `startTimeTBD === true`; no clock is inferred from `gameDate` in this state.
- Regression tests: `tools/smoke-test.mjs` covers the scoreboard card time, game header, game metadata, and pregame first-pitch line for a `startTimeTBD` payload.
- Status: **Fixed and verified locally.** The already-deployed live site was observed before this patch and still showed placeholder clocks; the corrected rendering will appear once this branch is merged and Pages deploys.

## 5. Verification commands

Executed after the correction:

```text
npm ci                         -> installed 28 packages; audit reported 0 vulnerabilities
npm test                       -> 69 passed, 0 failed (includes two new TBD regressions)
node tests/run-all.mjs         -> syntax, 41 local links, 8 page bindings, 47/47 DOM checks
node tests/props-provenance-test.mjs -> 5 passed, 0 failed
node tools/restoration-check.mjs -> all reported checks passed (its process did not exit before the shell timeout)
```

`restoration-check.mjs` printed `ALL CHECKS PASSED`, including server health/feed-log round-trip, static routes, hidden-file rejection, and the `atBatIndex: 0` case; the runner itself exceeded the command timeout during shutdown, so this is recorded as a clean check output with a shutdown-timeout caveat rather than a confirmed zero exit code.

## 6. Remaining verification limits and flags

- This session did not re-audit every inherited item on [`flagged.html`](../flagged.html) or repeat every historical game-row verification; the prior detailed per-row source record is linked above. Existing `U-*`, `F-*`, `IR-*`, `D-*`/`RR-*` items remain as documented there. They are not silently represented as newly verified by this report.
- The exact HTML/JS/JSON produced by MLB's API can change between fetches. Dynamic feed data is fetched directly by the browser; an official source URL is linked beside each reviewed event and each player-stat driver in the interface. Visual constants and hit-forecast tuning that have no authoritative MLB-published value remain flagged as unverified on the review page.
- No values are filled by this audit when the official source marks them absent or TBD. The three 2027 game start times above remain unverified and are now shown as `TBD`.
