# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yossapr/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yossapr/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for token launches: every protocol in the snapshot that records no token, priced from
its own TVL and its tokenised peers, ranked by the implied value of the token it has not issued,
and scored with a farm plan that says what it costs and what it would pay.

Built for the `token-radar-01` bounty. One frozen snapshot in, one self-contained page out: no
network calls, no runtime dependencies, no hardcoded protocol names.

## What it does

* **Value model.** `log10(mcap) = a + b * log10(TVL)`, fitted by least squares on the 128
  protocols in the snapshot that record both a token and a market cap, with the P25/P75 band
  taken from the fit's own residuals. Terms for category, chain tier, 7-day growth and age are
  tested one at a time and dropped when they fail to lower the leave-one-out miss by 2%; the
  method panel prints that test rather than hiding it.
* **Token odds.** A logistic fit for how often a protocol of a given age and TVL records a token
  (AUC 0.67). It is a peer rate, not a forecast, and the page says so.
* **Board.** 268 ranked rows: all 40 watchlist protocols plus 228 early ones, ranked by implied
  value, with the P25-P75 band, the peer rate, the verdict and the farm cost on every row.
* **Verdict.** `net = (P25 / TVL) * peer rate * 0.995 - 0.00025` per dollar of TVL: CONVEX at
  0.8% or more, MARGINAL at 0.3%, SKIP below. The formula is printed in the method panel.
* **Farm plans.** Six steps per row, each with a cost and a time (gas, capital, hours).
* **Detail view.** Eight nearest priced peers, the band on a log bar, and the plan.
* **Filtered view.** The early tier below the watchlist floor, plus the 244 derivatives of
  already-tokenised protocols that the board deliberately sets aside, with the reason on each.
* **Method view.** The fit, the term tests, the leave-one-out and walk-forward misses, the band
  coverage, the odds fit and the verdict formula.

## Run it

```sh
node main.ts --input path/to/snapshot.json    # writes out/ (board.json, data.js, dashboard, dossier.json)
node tools/verify.mjs                          # gate checks, dossier equality, double-run determinism
node tools/capture.mjs --route '#board' --out screenshots/1-board.png
```

`main.ts` reads the snapshot, fits both models, ranks the board, writes `out/board.json`, the
page's `data.js`, the dashboard and `dossier.json`. Two runs on the same snapshot produce
byte-identical output; nothing is timestamped and no order depends on unstable sorts.

## Layout

```
lib/model.ts        the fit, the odds, the band, the verdict, the farm plan (pure functions)
main.ts             snapshot -> out/ (board.json, data.js, dashboard copy, dossier.json)
dashboard/          index.html, app.css, app.js: the page, four views, no framework
vendor/             makefun-board.ts from the kit, unmodified
tools/capture.mjs   CDP screenshot tool (desktop Chrome, 1400x900)
tools/verify.mjs    the checks this repo runs before every submission
```

## Honesty notes

* An implied value is this entry's own claim, not advice, and not a promise that a token launches.
* A protocol that records no token may still have one: the board reports what the snapshot
  records, not what is true.
* The band is wide on purpose; coverage is measured and printed (52% of leave-one-out misses
  inside P25-P75, against 50% for a perfectly calibrated band).

## Licence

MIT. Snapshot data belongs to make.fun's competition kit.
