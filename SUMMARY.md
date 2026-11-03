# SMC Terminal — Project Summary

## Status

**COMPLETE FOR CURRENT SCOPE.**

SMC Terminal is a real-time, read-only Deriv market-analysis application built with Next.js 15 (App Router), React 19, and TypeScript 5.7. It streams public market data over the Deriv WebSocket API, builds candles across seven timeframes, performs SMC analysis, and produces deterministic `LONG` / `SHORT` / `NO_TRADE` signals. Order execution is not supported, and the Risk panel is intentionally disabled.

## Current architecture

- **`app/`** — Next.js App Router. `/` redirects to `/dashboard`; `app/dashboard/page.tsx` orchestrates the live data, recovery, analysis, signal, and notification lifecycle.
- **`components/`** — Terminal UI: header, watchlist, candlestick chart, market structure, SMC analysis, signal, signal diagnostics, market data, event log, notification center, and the disabled Risk panel.
- **`lib/deriv/`** — Public Deriv WebSocket client, tick parsing, candle construction, symbol configuration, feed health, history requests and recovery, chunked recovery coordination, session-closure handling, and selection state.
- **`lib/analysis/`** — Pure analyzers for market structure, BOS/CHoCH, liquidity and sweeps, FVGs, order blocks, premium/discount zones, and the SMC aggregator.
- **`lib/signals/`** — Deterministic signal engine, per-pair evaluation, duplicate suppression, signal history, diagnostics, and decision-state invalidation.
- **`lib/notifications/`** — New-signal detection, in-app delivery, optional desktop/sound delivery, preferences, and development test signals.
- **`lib/monitoring/`** — Headless monitoring core, live acquisition, signal fixture recorder, and zone-sweep diagnostics.
- **`lib/ui/`** — Pure view models and chart-viewport helpers.
- **`hooks/`** — Notification orchestration tied to candle-close events.
- **`test/`** — Node test suites (Node.js built-in test runner via `tsx`), replay harness, and verification utilities.
- **`docs/`** — SMC, signal, and broker-comparison specifications.

## Implemented functionality

- Live Deriv public WebSocket connection with subscriptions, heartbeat, automatic reconnection with capped exponential backoff, stale detection, and manual reconnect.
- Nine-symbol watchlist: EURUSD, GBPUSD, USDJPY, AUDUSD, XAUUSD, V75, V10, BOOM1000, and CRASH1000.
- Timeframes: `1m`, `5m`, `15m`, `30m`, `1H`, `4H`, `1D`.
- Custom HTML5 Canvas candlestick chart with pan, zoom, crosshair, swing markers, and structure-break overlays.
- Market structure, BOS, CHoCH, liquidity, liquidity sweeps, FVG, order blocks, and premium/discount/equilibrium analysis.
- Deterministic signal evaluation with explicit rejection reasons, entry, stop loss, take profit, risk/reward, and duplicate suppression.
- Retained signal history per symbol/timeframe, invalidation on data discontinuity or stale feeds, and honest historical labelling.
- In-app notifications with opt-in desktop and sound delivery, plus a development-only test notification.
- Market-data status and terminal-style event-log panels.
- Order execution absent; Risk panel intentionally disabled.

## Reliability and recovery work

- Historical backfill with per-pair deduplication and bounded retry budgets.
- Chunked recovery for gaps wider than one history response, with overlapping windows and a bounded request budget.
- Recovery completeness checks that account for forex, metals, synthetic, and Crash/Boom session closures.
- Reconnect candle-integrity protection so a candle spanning an unobserved gap is never treated as valid.
- Stale-feed recovery that keeps a pair blocked until its gap is genuinely recovered.
- Out-of-order, duplicate, and delayed tick protection for candles, live edges, and feed health.
- Decision and retained-signal invalidation that occurs immediately on a market-data discontinuity.
- Fail-closed history validation: invalid or incomplete responses never silently seed analysis data.

## Validation commands

The following commands validate the project on Windows/PowerShell:

- `npm run test:all` — runs every `test/*.test.ts` suite with the Node.js built-in test runner.
- `npx tsc --noEmit --incremental false` — TypeScript strict-mode check with no incremental cache.
- `npm run build` — Next.js production build.

The single skipped test is the genuine-signal replay test (`REPLAY 2`), which requires a captured fixture under `test/fixtures/genuine/`. Synthetic replay self-checks (REPLAY 1) and fail-closed loader tests (REPLAY 3) always run.

## Known non-blocking limitations

- No order execution, broker account access, or risk sizing.
- Risk panel intentionally disabled.
- `REPLAY 2` skips until a genuine recording is captured under `test/fixtures/genuine/`.
- Live data requires internet access and a reachable public Deriv WebSocket endpoint; closed markets and unavailable symbols are reported rather than fabricated.
- Signal confidence is a heuristic score, not a probability, and signal output is not trading advice or proof of profitability.
