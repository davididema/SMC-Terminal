# SMC Terminal

SMC Terminal is a real-time, read-only market-analysis application for Deriv instruments. It streams public market data over the Deriv WebSocket API, builds candles from live ticks, and applies Smart Money Concepts (SMC) analysis to the selected symbol and timeframe.

The application is an analysis workstation, not an execution platform. It does not place orders, manage accounts, size positions, or connect to any broker execution service. The Risk panel is intentionally disabled.

## Features

### Market data

- Live connection to Deriv's public WebSocket market-data endpoint.
- Multi-symbol watchlist covering forex, metals, volatility indices, and Crash/Boom indices (nine symbols: EURUSD, GBPUSD, USDJPY, AUDUSD, XAUUSD, V75, V10, BOOM1000, CRASH1000).
- Per-symbol feed health (live, waiting, stalled, market closed, unavailable).
- Automatic reconnection with capped exponential backoff, heartbeat pings, stale-feed detection, and a manual reconnect action.
- Live tick processing, candle construction across all supported timeframes, and historical backfill.

### Candlestick charts

- Custom HTML5 Canvas candlestick chart with pan, zoom, crosshair inspection, swing markers, and structure-break overlays.
- No external charting library — rendering is implemented directly on Canvas.

### Timeframes

The chart and analysis support the following timeframes:

`1m`, `5m`, `15m`, `30m`, `1H`, `4H`, `1D`

### SMC analysis

- Market structure: confirmed swing highs and lows, higher highs, higher lows, lower highs, lower lows, and structural bias.
- Break of Structure (BOS) and Change of Character (CHoCH).
- Liquidity levels, equal highs, equal lows, and liquidity sweeps.
- Fair Value Gaps (FVG).
- Order Blocks with mitigation and invalidation tracking.
- Premium, Discount, and Equilibrium zones derived from the latest confirmed dealing range.

### Signals

- Deterministic signal evaluation for the selected symbol and timeframe.
- `LONG`, `SHORT`, and `NO_TRADE` decisions with explicit rejection reasons.
- Setup classification (trend continuation or sweep reversal), entry, stop loss, take profit, and risk/reward.
- Default minimum risk/reward gate of `2.0`; the confidence value is an integer heuristic score from 0 to 100, not a probability.
- Duplicate suppression keyed by symbol, timeframe, trigger, and selected zone.
- Retention of the most recent genuine signal per symbol/timeframe, with historical signals clearly separated from the latest evaluation.
- Invalidation of the displayed decision and retained signal when market data becomes discontinuous or stale.

### Notifications

- In-app signal notifications with opt-in desktop notifications and sound.
- A development-only test-notification control is available outside production builds.

### Market-data and event-log panels

- Market-data panel showing connection, WebSocket, tick, candle, subscription, and feed-status information.
- Terminal-style event log containing real connection, subscription, data, recovery, and analysis events.

### Recovery and reliability

- Historical backfill on symbol or timeframe selection, with request deduplication.
- Bounded retry budgets for failed or empty history requests.
- Chunked recovery for gaps wider than a single history response, with overlap so required periods are not skipped.
- Completeness checks against known market-closure windows for forex, metals, synthetics, and Crash/Boom instruments.
- Reconnect integrity checks that prevent candles spanning an unobserved gap from being treated as valid.
- Stale-feed recovery that blocks evaluation until the gap is genuinely recovered.
- Protection against duplicate, out-of-order, and delayed ticks.
- Decision and retained-signal invalidation on any market-data discontinuity.
- Fail-closed history validation: invalid or incomplete responses never silently seed analysis data.

## Not supported

- **No order execution.** No trades are placed, no orders are routed, and no broker account is accessed.
- **Risk panel intentionally disabled.** Balance, risk sizing, position sizing, potential loss/profit, and target R:R controls are placeholders only.
- **No profitability or trading-advice claims.** Signals and analysis are deterministic observations, not guarantees or recommendations.

## Technology stack

| Technology | Role |
| --- | --- |
| Next.js `^15.1.0` (App Router) | Application framework, routing, production build, and server |
| React `^19.0.0` / React DOM `^19.0.0` | UI rendering |
| TypeScript `^5.7.0` | Strict application and test typing |
| Browser WebSocket API | Live Deriv market-data transport |
| HTML5 Canvas | Custom candlestick chart rendering (no charting library) |
| Global CSS (`app/globals.css`) | Terminal-style layout and visual design (no CSS framework) |
| Node.js built-in test runner via `tsx ^4.19.2` | Unit and integration tests |
| `ws ^8.18.0` (development) | WebSocket support for tests and monitoring tools |

The application has no database, authentication service, state-management library, UI component library, or charting dependency.

## Installation

### Prerequisites

- Windows with PowerShell (the commands below are PowerShell-compatible).
- A current Node.js release compatible with Next.js 15.
- npm, using the committed `package-lock.json`.
- Internet access to the public Deriv WebSocket endpoint for live market data.

No Deriv account, API token, private key, or paid data subscription is required for the public market-data connection.

### 1. Install dependencies

```powershell
npm install
```

### 2. Configure the environment

Create a local environment file from the example without overwriting an existing one:

```powershell
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

Confirm that `.env.local` contains the public endpoint documented in `.env.example`. Local environment files are ignored by Git.

### 3. Start development

```powershell
npm run dev
```

Open `http://localhost:3000`. The root route redirects to `/dashboard`.

### 4. Build for production

```powershell
npm run build
```

### 5. Start the production server

```powershell
npm run start
```

### 6. Run tests

```powershell
npm run test:all
```

### 7. Validate TypeScript

```powershell
npx tsc --noEmit --incremental false
```

Additional scripts defined in `package.json`:

| Command | Purpose |
| --- | --- |
| `npm test` | Runs the market-structure and structure-break test files directly |
| `npm run test:all` | Runs every `test/*.test.ts` suite with the Node test runner |
| `npm run test:real` | Runs the live Deriv data verification script (requires network) |
| `npm run compare:brokers` | Runs the offline broker candle comparison harness |
| `npm run monitor:live` | Runs the live monitoring diagnostic and optional fixture recorder |
| `npm run lint` | Runs the Next.js lint command |

## Configuration

The only public configuration variable documented in `.env.example` is:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_DERIV_WS_URL` | The Deriv WebSocket endpoint used by the browser client for public market data. Defaults to `wss://api.derivws.com/trading/v1/options/ws/public` when unset. |

This value is public by design and must not contain credentials. Do not commit `.env`, `.env.local`, tokens, account identifiers, or any other secret to the repository.

## Architecture

```text
app/                    Next.js App Router entry points and dashboard page
components/             Dashboard panels and terminal UI components
hooks/                  React hooks for notification orchestration
lib/analysis/           Market structure, structure breaks, liquidity, FVG,
                        order blocks, and the SMC aggregator
lib/deriv/              WebSocket client, tick/candle construction, symbols,
                        history requests, recovery, and session closures
lib/monitoring/         Headless monitoring core, live acquisition, signal
                        recording, and diagnostics
lib/notifications/      Detection, dispatch, desktop, sound, preferences,
                        and test-notification support
lib/signals/            Signal engine, evaluation, diagnostics, history, and
                        decision state
lib/ui/                 Pure view-model and chart-viewport helpers
test/                   Node test suites, harnesses, and verification utilities
docs/                   SMC, signal, and broker-comparison specifications
```

### Key responsibilities

- **`app/dashboard/page.tsx`** owns the live dashboard lifecycle: WebSocket setup, subscriptions, candle processing, history loading, recovery orchestration, analysis, signals, notifications, and panel state.
- **`lib/deriv/`** is the market-data layer. It validates incoming ticks and candles, maintains per-symbol/timeframe candle state, manages subscriptions and reconnects, tracks feed health, and coordinates history recovery.
- **`lib/analysis/`** contains pure analyzers. Each analyzer keeps per-symbol/timeframe state and consumes only closed candles for confirmed analysis.
- **`lib/signals/`** evaluates SMC output into a deterministic signal, records evaluation diagnostics, retains generated signals, and manages invalidation state.
- **`lib/notifications/`** detects newly confirmed signals from candle-close events and delivers them in-app, with optional desktop and sound delivery.
- **`lib/monitoring/`** provides a headless evaluation path used by diagnostics and the replay harness, plus an opt-in signal fixture recorder.
- **`lib/ui/`** converts engine state into display models without mutating analysis or signal state.
- **`components/`** renders the terminal and contains no trading or market-data calculations.

## Testing

Run the complete local suite:

```powershell
npm run test:all
```

Run TypeScript validation without emitting files or using incremental state:

```powershell
npx tsc --noEmit --incremental false
```

Run the production build:

```powershell
npm run build
```

### REPLAY 2 skip

The `REPLAY 2` genuine-signal replay test is intentionally skip-gated. It loads fixtures from `test/fixtures/genuine/`; when no genuine fixture has been captured, the test skips with an explicit reason. A malformed fixture fails the test rather than being ignored.

To exercise it, record a genuine fixture with the live monitoring tool using `SMC_RECORD_SIGNAL_FIXTURE=1`, then re-run `npm run test:all`. The replay harness itself is covered by always-running synthetic self-checks (REPLAY 1) and fail-closed loader tests (REPLAY 3).

## Limitations

- **Order execution is not implemented.** The application cannot place, modify, or close trades.
- **The Risk panel is intentionally disabled.** It displays no account data and performs no position sizing.
- **REPLAY 2 requires a genuine recording.** Without a captured fixture under `test/fixtures/genuine/`, that test skips.
- **Live data depends on the public Deriv connection.** Internet access, DNS, proxy/firewall rules, and Deriv endpoint availability all affect the feed. Markets may be closed, and individual symbols may be unavailable.
- **Analysis is limited to observed data.** The application does not fabricate prices, candles, targets, or higher-timeframe context. A pair with an unresolved data gap is not evaluated until recovery succeeds.
- **Signals are analysis outputs, not trading advice.** The confidence score is a heuristic, and the risk/reward gate is a configuration threshold, not evidence of profitability.
