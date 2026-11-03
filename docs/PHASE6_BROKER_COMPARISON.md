# Phase 6 — Offline Broker Candle Comparison Harness

This document describes the read-only, network-free tooling used to compare two
genuinely exported candle datasets (for example, an HFM/MT5 history export and a
Deriv reference export).

## Scope and non-goals

- **Read-only and offline.** The harness performs no network access, opens no
  WebSocket, and does not touch the live Deriv pipeline, the SMC engine, or any
  signal logic. It never fabricates candles.
- **Not a validation of the application.** Comparing candles does **not** prove
  the application "matches" any broker, and candle correspondence is **not**
  evidence of strategy profitability or edge.
- **Comparisons target:** `XAUUSD M15`, `XAUUSD H1`, `EURUSD M15`, `GBPUSD M15`
  (any supported symbol/timeframe pair is accepted).

## Input format

Both files must be CSV with this exact column order (a header row is optional):

```
symbol,timeframe,timestamp,open,high,low,close
```

| Column      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `symbol`    | Internal symbol id, e.g. `XAUUSD`, `EURUSD`, `GBPUSD`.               |
| `timeframe` | `1m`,`5m`,`15m`,`30m`,`1H`,`4H`,`1D` (MT5 aliases `M15`,`H1`,`D1`… accepted). |
| `timestamp` | Candle **opening** Unix timestamp in seconds.                        |
| `open/high/low/close` | Prices.                                                   |

Rows are **rejected, never repaired**, when they contain: a non-finite or
non-positive price, an OHLC envelope violation (`high < low`, etc.), an
unsupported symbol or timeframe, a duplicate timestamp, or the wrong number of
columns. Out-of-order rows are flagged but retained.

## Timestamp conventions (never assumed)

Timestamps are never silently assumed to be UTC. Each dataset requires an
explicit convention:

- `utc` — Unix seconds in UTC.
- `server:<offsetSeconds>` — documented broker server time; source epoch is
  converted by subtracting the offset.
- `unknown` — no documented interpretation; epoch alignment is `UNRESOLVED`.

If an offset is investigated, it is reported as an **inference only** and is
never applied automatically. `--investigate-offset` prints the best
timestamp-only candidate offset (it does not look at prices).

## Usage

```
npm run compare:brokers -- \
  --deriv deriv-xauusd-m15.csv --deriv-tz utc \
  --hfm hfm-xauusd-m15.csv --hfm-tz server:10800 \
  --symbol XAUUSD --timeframe 15m \
  --price-tolerance 0.05 --structure-tolerance 0.10 \
  --out broker-comparison-report.json
```

Flags:

| Flag | Purpose |
| ---- | ------- |
| `--deriv <path>` `--deriv-tz <conv>` | Deriv reference CSV + convention (required). |
| `--hfm <path>` `--hfm-tz <conv>` | HFM CSV + convention (both or neither). |
| `--symbol` `--timeframe` | Assert the expected instrument (mismatch → `FAIL`). |
| `--price-tolerance <n>` | Absolute price tolerance for the `PASS`/`FAIL` price verdict. |
| `--structure-tolerance <n>` | Absolute tolerance for the SMC structure comparison. |
| `--min-samples <n>` | Minimum matched candles for reliable percentiles (default 20). |
| `--investigate-offset` | Emit a (non-applied) alignment suggestion when unresolved. |
| `--out <path>` | JSON report path (default `broker-comparison-report.json`). |

If `--hfm` is omitted or unreadable, the verdict is `NOT_RUN`.

## Report status vocabulary

| Status       | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `PASS`       | The check ran and met its explicitly configured criteria.               |
| `FAIL`       | The check ran and violated its criteria.                                |
| `UNRESOLVED` | Required information was missing (e.g. no convention, no tolerance).    |
| `NOT_RUN`    | The check could not run (e.g. no HFM dataset was supplied).             |

The overall verdict is strict: a `PASS` requires a resolved timestamp
alignment, valid datasets, at least one matched candle, a **configured price
tolerance met**, and a **PASS** on the SMC comparison. Without a configured
price tolerance the best possible verdict is `UNRESOLVED`. A missing HFM dataset
can never yield `PASS`.

## What is compared

- **Coverage** — matched / only-in-Deriv / only-in-HFM candle timestamps.
- **OHLC differences** — absolute open/high/low/close/range differences with
  min, median, p95/p99, and max (percentiles flagged unreliable below the
  sample threshold).
- **SMC comparison** — swings, structure breaks, liquidity levels, FVGs, and
  order blocks matched by type + timestamp, plus the premium/discount zone and
  the signal decision, each compared on the shared normalised timeline.

## Limitations (always echoed into the report)

- CSV carries no closed/forming flag; every row is treated as a completed
  exported bar. A forming bar, if present, cannot be detected.
- Timestamp interpretation must be documented; otherwise alignment is
  `UNRESOLVED`.
- Percentiles are unreliable below the configured minimum sample size.
- The harness does not connect to any broker and is not a profitability or
  execution-fidelity test.

## Files

- `test/comparison-lib.ts` — pure comparison core.
- `test/comparison-lib.test.ts` — deterministic tests (synthetic fixtures only).
- `test/compare-broker-candles.ts` — CLI entry point.
