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
| T1 | Copy source repo `snapquast73-boop/LIVPBP` into this repo (all pages, assets, tests, docs) | in progress | `arena-0b8a9a74` | `index.html`, `reviews.html`, `game.html`, `flagged.html`, `404.html`, `assets/**`, `tests/**`, `tools/**`, `docs/**`, `audit/**`, `server.mjs`, `package*.json`, `.github/**`, `.nojekyll`, `.gitignore`, `LICENSE`, `README.md` | Claimed 2026-11-25. Source: https://github.com/snapquast73-boop/LIVPBP (public, MIT). |
| T2 | Line-by-line verification of site data against official MLB StatsAPI; flag anything unverified | unclaimed | — | `docs/verification-report.md`, `COORDINATION.md` (log only) | Each table row must carry a source link; unverifiable values stay blank and go to Flagged for Review. |
| T3 | Confirm site runs locally and matches reference behaviour for upcoming game days | unclaimed | — | verification only, no source edits | Reference: https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26 |
| T4 | GitHub Pages enablement + deploy check after merge to `main` | unclaimed | — | repo settings, `.github/workflows/**` | Final integration session publishes. |
| T5 | Final integration: PR to `main`, merge, deploy confirmation | unclaimed | — | merge of session branches | Re-verify combined data; no broken links before merge. |

## Requests (cross-scope changes)

_(Log here instead of editing files owned by another session.)_

## Work log

- 2026-11-25 `arena-0b8a9a74` — Created COORDINATION.md, claimed T1 (full repo copy). Branch `arena/0b8a9a74-alert2`.
