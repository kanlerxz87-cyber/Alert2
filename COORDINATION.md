# COORDINATION.md — shared task board

Repo: `kanlerxz87-cyber/Alert2` (copy of `snapquast73-boop/LIVPBP`, the MLB live play-by-play alert system).
This file is the shared task board for all agent sessions working on this repo. Claim a task by
writing your session ID and file scope here, then commit and push that claim immediately.
Never start a task another session has claimed. Keep scopes non-overlapping.

Status values: `unclaimed` | `in progress` | `done` | `needs review`
(`needs review` = published on the Flagged for Review page; does not block anything.)

## Session IDs

| Session ID | Role | Notes |
|---|---|---|
| `arena-0b8a9a74` | copy + verification + integration | Working on branch `arena/0b8a9a74-alert2`. |

## Task board

| ID | Task | Status | Owner | Files / scope | Notes |
|---|---|---|---|---|---|
| T1 | Copy source repo `snapquast73-boop/LIVPBP` into this repo (all pages, assets, tests, docs) | done | `arena-0b8a9a74` | `index.html`, `reviews.html`, `game.html`, `flagged.html`, `404.html`, `assets/**`, `tests/**`, `tools/**`, `docs/**`, `audit/**`, `server.mjs`, `package*.json`, `.github/**`, `.nojekyll`, `.gitignore`, `LICENSE`, `README.md` | Claimed 2026-11-25. Byte-for-byte verified vs upstream clone (`diff -r`, only intentional extras). |
| T2 | Line-by-line verification of site data against official MLB StatsAPI; flag anything unverified | done | `arena-0b8a9a74` | verification only; record below | All 10 feed rows + all 8 summary tiles + counters + scores verified — see "Verification record" below. |
| T3 | Confirm site runs locally and matches reference behaviour for upcoming game days | done | `arena-0b8a9a74` | verification only, no source edits | Local server + all test suites pass; reference: https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26 |
| T4 | GitHub Pages enablement + deploy check after merge to `main` | in progress | `arena-0b8a9a74` | repo settings, `.github/workflows/**` | Pages already enabled (legacy build, `main`, `/`, custom 404 true). Deploy check runs post-merge. |
| T5 | Final integration: PR to `main`, merge, deploy confirmation | in progress | `arena-0b8a9a74` | merge of session branches | Only session; no other branches present. |

## Verification record (T2) — 2026-11-25, session `arena-0b8a9a74`

Reference page under test: <https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26>
(cache-busted fetch `?date=2026-08-26&verify=1` renders the full completed scan; a plain fetch can
return a crawler-cached mid-scan snapshot — see irregularity IR-1).

Every rendered row was checked field-by-field against the official MLB StatsAPI. Sources used:

| What was verified | Official source |
|---|---|
| 15 games on 2026-08-26 (footer "15 game(s)") | <https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26> |
| All 10 review rows: play/event `result.description` text (verbatim), matchup batter/pitcher names, inning + half, `reviewType`, `isOverturned` (Stands/Overturned), `challengeTeamId` | <https://statsapi.mlb.com/api/v1/game/823096/playByPlay> · <https://statsapi.mlb.com/api/v1/game/823180/playByPlay> · <https://statsapi.mlb.com/api/v1/game/824963/playByPlay> · <https://statsapi.mlb.com/api/v1/game/823015/playByPlay> · <https://statsapi.mlb.com/api/v1/game/824555/playByPlay> · <https://statsapi.mlb.com/api/v1/game/823506/playByPlay> · <https://statsapi.mlb.com/api/v1/game/822692/playByPlay> |
| Review-code labels (`MF` "Manager challenge: Close play at 1st", `MA` "Manager challenge: Tag play", `NF` "Umpire review: Close play at 1st", `NH` "Umpire review: Home run", `MJ` "Player challenge: Pitch Result") | <https://statsapi.mlb.com/api/v1/gameStatus> |
| Challenge counters on every row (e.g. "SEA: 0 manager challenges left now (1 used)", "Challenges left: CIN 1 MGR · 2 ABS — SF 0 MGR · 1 ABS") | <https://statsapi.mlb.com/api/v1.1/game/823096/feed/live?fields=gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed> and the same projection for games 823180, 824963, 823015, 824555, 823506, 822692 |
| "Actual after (official)" scores 6–0, 3–6, 10–9, 3–2, 7–1, 0–0, 1–2, 2–3, 3–3, 4–1 | <https://statsapi.mlb.com/api/v1/game/823096/linescore> and the same for 823180, 824963, 823015, 824555, 823506, 822692 |
| Summary tiles Reviews 10 · Challenges 8 · Umpire reviews 2 · ABS challenges 68 · Boundary calls 1 · Under review 0 · Runs at risk 1 · Scoring changes 0; footer "78 tracked entries" (= 10 + 68) | exhaustive recount of every `reviewDetails` block (play- and event-level) across all 15 games' playByPlay: 46 event-level + 22 play-level `MJ` = 68 ABS; 8 manager (`MF`×3 + `MA`×5); 2 umpire (`NF`, `NH`); 1 boundary (`NH`) — exact match |
| Per-row "MLB API ↗" source links | rendered by `assets/js/reviews-feed.js` as `https://statsapi.mlb.com/api/v1/game/<gamePk>/playByPlay` (asserted by `tests/props-provenance-test.mjs` and smoke §[10]) |

Row-by-row results (all **verified**, none blank/inferred):

| # | Row (gamePk:play:index:code) | Verified against |
|---|---|---|
| 1 | `823096:36:p:MF` PHI @ SEA, Bot 5, J.P. Crawford vs Jesús Luzardo, upheld, 6–0, SEA 0 left (1 used) | playByPlay + gameStatus + feed/live + linescore |
| 2 | `823180:57:p:MA` CIN @ SF, Top 7, Sal Stewart vs Ryan Walker, upheld, 3–6, SF 0 left (1 used), 1 run at risk | playByPlay (runs: "Ke'Bryan Hayes scores") + gameStatus + feed/live + linescore |
| 3 | `823180:84:p:NF` CIN @ SF, Top 9, Héctor Rodríguez vs Reiver Sanmartin, upheld, 10–9, CIN 1 MGR · 2 ABS — SF 0 MGR · 1 ABS | playByPlay + gameStatus + feed/live + linescore |
| 4 | `824963:34:p:MF` MIN @ ATH, Top 5, Alan Roden vs J.T. Ginn, **overturned**, 3–2, ATH 1 left (1 used) | playByPlay + gameStatus + feed/live + linescore |
| 5 | `823015:34:p:MF` BAL @ STL, Top 4, Samuel Basallo vs Michael McGreevy, upheld, 7–1, STL 0 left (1 used) | playByPlay + gameStatus + feed/live + linescore |
| 6 | `824555:2:7:MA` TEX @ CWS, Top 1, Wyatt Langford vs Sean Burke, **overturned**, 0–0, CWS 1 left (1 used) | playByPlay + gameStatus + feed/live + linescore |
| 7 | `823506:19:5:NH` HOU @ NYY, Bot 2, Luis García Jr. vs Peter Lambert, boundary call (Home run), stood, 1–2, "score impact pending" | playByPlay + gameStatus + feed/live + linescore |
| 8 | `823506:46:4:MA` HOU @ NYY, Bot 6, Austin Wells vs Peter Lambert, upheld, 2–3, NYY 0 left (1 used) | playByPlay + gameStatus + feed/live + linescore |
| 9 | `823506:56:0:MA` HOU @ NYY, Bot 7, Ben Rice vs Bennett Sousa, upheld, 3–3, HOU 0 left (1 used) | playByPlay + gameStatus + feed/live + linescore |
| 10 | `822692:47:4:MA` COL @ WSH, Top 6, Jake McCarthy vs Luis Perales, upheld, 4–1, WSH 0 left (1 used) | playByPlay + gameStatus + feed/live + linescore |

## Verification of the app itself (T3)

```text
node tools/restoration-check.mjs -> ALL CHECKS PASSED   (local refs, JS parse, server contract)
node tests/run-all.mjs           -> syntax OK · link-check OK (41 refs) · contract-check OK (8 bindings) · jsdom-render-test 47/47
npm test (tools/smoke-test.mjs)  -> 64 passed, 0 failed
node tests/props-provenance-test.mjs -> 5 passed, 0 failed
node server.mjs                  -> 200 on /, index, reviews, game, flagged, 404.html, css, js; 404 on missing path; /api/health ok
```

Byte integrity: `diff -r` of this tree against a fresh `git clone --depth 1` of
<https://github.com/snapquast73-boop/LIVPBP> is clean except for this file,
`docs/upstream-COORDINATION.md` (the upstream board, preserved for provenance), and the three
deliberate port edits below.

## Irregularities flagged for review (published on `flagged.html` too where applicable)

| # | Item | Status |
|---|---|---|
| IR-1 | A plain fetch of the reference `reviews.html` can return a crawler-cached **mid-scan snapshot** (tiles showed 3/2/1/27 and 76 entries with scan time 3:38:33 PM); a cache-busted fetch renders the completed scan (tiles 10/8/2/68/1/0/1/0, 78 entries, scan time 4:04:43 PM). The full-scan values were independently re-counted from the official API and match exactly. Not a data error — a caching artefact of the reference's CDN/crawler. | needs review (informational) |
| IR-2 | Port edits required for this repo: `404.html` base path `/LIVPBP/` → `/Alert2/`; `package.json` homepage; README demo/flagged links. Upstream provenance citations in `flagged.html`/`docs/` intentionally left pointing at the upstream repo. | done |
| IR-3 | Upstream flagged items U-1…U-11, RR-*, R2-*, L-* (hit-model constants, team colours, polling cadence, lost original assets, etc.) carry over unchanged and remain published on [`flagged.html`](flagged.html) with source links — **not re-verified here**; they do not block the merge. | needs review (carried over) |
| IR-4 | Sandbox note: direct `curl` to `statsapi.mlb.com` is blocked in this environment; all official-API verification above was performed through the platform's page fetcher against `https://statsapi.mlb.com/...` URLs (each linked). The deployed site calls the same endpoints from the browser. | done |

## Requests (cross-scope changes)

_(None — single session.)_

## Work log

- 2026-11-25 `arena-0b8a9a74` — Created COORDINATION.md, claimed T1 (full repo copy). Branch `arena/0b8a9a74-alert2`.
- 2026-11-25 `arena-0b8a9a74` — T1 done: full source copied (40 files, 12 420 lines), byte-identical to upstream; test suites green.
- 2026-11-25 `arena-0b8a9a74` — T2 done: all 10 feed rows + 8 tiles + counters + scores verified line-by-line against official StatsAPI (sources in table above); nothing inferred; upstream flagged items carried over to `flagged.html`.
- 2026-11-25 `arena-0b8a9a74` — Port edits (IR-2) committed; full test suite re-run green.
- 2026-11-25 `arena-0b8a9a74` — T3 done: local server serves all pages; `index/reviews/game` deep links + `?date=` handling covered by jsdom tests (47/47) and smoke (64/64).
