import test from 'node:test';
import assert from 'node:assert/strict';
import { DerivWebSocketClient } from '../lib/deriv/websocket';
import type { DerivLogEntry } from '../lib/deriv/websocket';

/**
 * Deterministic tests for the Deriv client's historical-candle message handling.
 *
 * A valid `candles` response is delivered through the client's own
 * `handleMessage` path; a real network is never used. The in-memory WebSocket
 * double mirrors the harness already used in `feed-client.test.ts`.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function withFakeWebSocket(run: () => void): void {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  try {
    run();
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
}

async function withFakeWebSocketAsync(run: () => Promise<void>): Promise<void> {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  try {
    await run();
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic synthetic candle fixture (never real market data). */
function candle(epoch: number) {
  return { epoch, open: 1, high: 1.2, low: 0.9, close: 1.1 };
}

function openSocket(client: DerivWebSocketClient): FakeWebSocket {
  client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  return socket;
}

// --- A. Valid historical-candle response ------------------------------------

test('A1 — a valid candles response resolves its own request once, with the request symbol/timeframe', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);

      const calls: Array<{ symbol: string; timeframe: string; n: number }> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (symbol, timeframe, candles) => {
        calls.push({ symbol, timeframe, n: candles.length });
      });

      const payload = [candle(60), candle(120)];
      socket.emit({ msg_type: 'candles', req_id: 1, candles: payload });

      assert.equal(calls.length, 1, 'callback invoked exactly once');
      assert.deepEqual(calls[0], { symbol: 'EURUSD', timeframe: '1m', n: 2 });

      // A duplicate/late message for the same id must not fire again.
      socket.emit({ msg_type: 'candles', req_id: 1, candles: payload });
      assert.equal(calls.length, 1, 'at most once for a given request id');
    } finally {
      client.disconnect();
    }
  });
});

test('A2 — a candles response does not resolve an unrelated request', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);

      const eur: number[] = [];
      const gbp: number[] = [];
      // First registered request gets req_id 1, second gets req_id 2.
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, c) => eur.push(c.length));
      client.fetchCandlesHistory('GBPUSD', '1m', 10, (_s, _tf, c) => gbp.push(c.length));

      socket.emit({ msg_type: 'candles', req_id: 1, candles: [candle(60)] });
      assert.deepEqual(eur, [1], 'the targeted request resolves');
      assert.deepEqual(gbp, [], 'the unrelated request is untouched');

      socket.emit({ msg_type: 'candles', req_id: 2, candles: [candle(60), candle(120)] });
      assert.deepEqual(gbp, [2], 'the second request resolves with its own payload');
      assert.deepEqual(eur, [1], 'the first request is not resolved twice');
    } finally {
      client.disconnect();
    }
  });
});

test('A3 — a valid candles response preserves the existing log message', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const logs: DerivLogEntry[] = [];
      client.onLog((entry) => logs.push(entry));
      const socket = openSocket(client);

      client.fetchCandlesHistory('EURUSD', '1m', 10, () => {});
      socket.emit({ msg_type: 'candles', req_id: 1, candles: [candle(60), candle(120), candle(180)] });

      assert.ok(
        logs.some(
          (l) => l.level === 'info' && /Loaded 3 historical 1m candles for EURUSD/.test(l.message)
        ),
        'existing info log preserved'
      );
    } finally {
      client.disconnect();
    }
  });
});

test('A4 — a matching error response resolves the request with an empty result and logs the error', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const logs: DerivLogEntry[] = [];
      client.onLog((entry) => logs.push(entry));
      const socket = openSocket(client);

      let calls = 0;
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, candles) => {
        calls += 1;
        assert.equal(candles.length, 0, 'failure is delivered as an empty result');
      });

      socket.emit({
        error: { code: 'InputValidationFailed', message: 'bad request' },
        echo_req: { ticks_history: 'frxEURUSD' },
        req_id: 1,
      });

      assert.equal(calls, 1, 'the failed request is resolved exactly once');
      assert.ok(
        logs.some((l) => l.level === 'error' && /InputValidationFailed/.test(l.message)),
        'error log preserved'
      );
    } finally {
      client.disconnect();
    }
  });
});

// --- B (end-to-end shape). Empty-but-valid response -------------------------

test('B3 — an empty but valid candles array resolves the request with zero candles', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);

      const calls: number[] = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, candles) => {
        calls.push(candles.length);
      });

      socket.emit({ msg_type: 'candles', req_id: 1, candles: [] });

      assert.deepEqual(calls, [0], 'an empty array is a valid response, not a failure to deliver');
    } finally {
      client.disconnect();
    }
  });
});

// --- C. Malformed candle response -------------------------------------------

test('C1 — a malformed candles message fails exactly its own request and seeds nothing', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);

      const eur: number[] = [];
      const gbp: number[] = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, candles) => eur.push(candles.length));
      client.fetchCandlesHistory('GBPUSD', '1m', 10, (_s, _tf, candles) => gbp.push(candles.length));

      // Message type claims candles and carries req_id 1, but the payload is
      // missing entirely. Ownership is established by the request id, so only
      // that request is failed (with an empty result -> nothing to seed).
      socket.emit({ msg_type: 'candles', req_id: 1 });

      assert.deepEqual(eur, [0], 'the malformed response fails its own request once');
      assert.deepEqual(gbp, [], 'the unrelated request is untouched');

      // The malformed message consumed the request: a late valid response for
      // the same id must not resolve it (at-most-once).
      socket.emit({ msg_type: 'candles', req_id: 1, candles: [candle(60)] });
      assert.deepEqual(eur, [0], 'a late response for the retired id is ignored');

      // The unrelated request still resolves normally.
      socket.emit({ msg_type: 'candles', req_id: 2, candles: [candle(60), candle(120)] });
      assert.deepEqual(gbp, [2], 'the second request resolves with its own payload');
    } finally {
      client.disconnect();
    }
  });
});

test('C2 — a malformed candles response is a distinct failure, not a valid empty result', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const logs: DerivLogEntry[] = [];
      client.onLog((entry) => logs.push(entry));
      const socket = openSocket(client);

      let calls = 0;
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, candles) => {
        calls += 1;
        assert.equal(candles.length, 0, 'failure is delivered as an empty result');
      });

      socket.emit({ msg_type: 'candles', req_id: 1, candles: null });

      assert.equal(calls, 1, 'a malformed response fails the request exactly once');
      assert.ok(
        logs.some((l) => l.level === 'warn' && /Malformed candles response/.test(l.message)),
        'a distinct diagnostic distinguishes malformed from a valid empty result'
      );
      assert.ok(
        !logs.some((l) => l.level === 'info' && /Loaded 0 historical/.test(l.message)),
        'a malformed response is not reported as a successful (empty) load'
      );

      // A duplicate malformed message for the same id must not fire again.
      socket.emit({ msg_type: 'candles', req_id: 1, candles: null });
      assert.equal(calls, 1, 'at most once for a given request id');
    } finally {
      client.disconnect();
    }
  });
});

// --- T. Bounded request timeout ---------------------------------------------

test('T1 — an unanswered history request is failed once by the timeout and logged', async () => {
  await withFakeWebSocketAsync(async () => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000, historyTimeoutMs: 5 });
    try {
      const logs: DerivLogEntry[] = [];
      client.onLog((entry) => logs.push(entry));
      openSocket(client);

      let calls = 0;
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, candles) => {
        calls += 1;
        assert.equal(candles.length, 0, 'a timed-out request is delivered as an empty result');
      });

      await delay(40);

      assert.equal(calls, 1, 'the timeout retires the request exactly once');
      assert.ok(
        logs.some((l) => l.level === 'warn' && /timed out/.test(l.message)),
        'the timeout emits a distinct diagnostic'
      );

      // A late response after the timeout must not fire the callback again.
      const socket = FakeWebSocket.instances[0];
      socket.emit({ msg_type: 'candles', req_id: 1, candles: [candle(60)] });
      assert.equal(calls, 1, 'a late response does not resolve a timed-out request');
    } finally {
      client.disconnect();
    }
  });
});

test('T2 — disconnecting clears an outstanding request timer', async () => {
  await withFakeWebSocketAsync(async () => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000, historyTimeoutMs: 50 });
    try {
      openSocket(client);

      let calls = 0;
      client.fetchCandlesHistory('EURUSD', '1m', 10, () => {
        calls += 1;
      });

      // Disconnect fails the in-flight request once and must clear its timer.
      client.disconnect();
      assert.equal(calls, 1, 'disconnect fails the in-flight request once');

      await delay(80);
      assert.equal(calls, 1, 'the cleared timer does not fire after disconnect');
    } finally {
      client.disconnect();
    }
  });
});

// --- O. Request outcome discriminant ----------------------------------------

test('O1 — a non-empty response is reported as a success outcome', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);
      const outcomes: Array<string | undefined> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, _c, outcome) =>
        outcomes.push(outcome)
      );

      socket.emit({ msg_type: 'candles', req_id: 1, candles: [candle(60)] });
      assert.deepEqual(outcomes, ['success']);
    } finally {
      client.disconnect();
    }
  });
});

test('O2 — a valid empty response is reported as an empty outcome (not a failure)', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);
      const outcomes: Array<string | undefined> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, _c, outcome) =>
        outcomes.push(outcome)
      );

      socket.emit({ msg_type: 'candles', req_id: 1, candles: [] });
      assert.deepEqual(outcomes, ['empty']);
    } finally {
      client.disconnect();
    }
  });
});

test('O3 — a malformed response is reported as a failure outcome', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);
      const outcomes: Array<string | undefined> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, _c, outcome) =>
        outcomes.push(outcome)
      );

      socket.emit({ msg_type: 'candles', req_id: 1, candles: null });
      assert.deepEqual(outcomes, ['failure']);
    } finally {
      client.disconnect();
    }
  });
});

test('O4 — an error response is reported as a failure outcome', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      const socket = openSocket(client);
      const outcomes: Array<string | undefined> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, _c, outcome) =>
        outcomes.push(outcome)
      );

      socket.emit({
        error: { code: 'InputValidationFailed', message: 'bad request' },
        echo_req: { ticks_history: 'frxEURUSD' },
        req_id: 1,
      });
      assert.deepEqual(outcomes, ['failure']);
    } finally {
      client.disconnect();
    }
  });
});

test('O5 — a timed-out request is reported as a failure outcome', async () => {
  await withFakeWebSocketAsync(async () => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000, historyTimeoutMs: 5 });
    try {
      openSocket(client);
      const outcomes: Array<string | undefined> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, _c, outcome) =>
        outcomes.push(outcome)
      );

      await delay(40);
      assert.deepEqual(outcomes, ['failure']);
    } finally {
      client.disconnect();
    }
  });
});

test('O6 — a request abandoned by disconnect is reported as an abandoned outcome', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      openSocket(client);
      const outcomes: Array<string | undefined> = [];
      client.fetchCandlesHistory('EURUSD', '1m', 10, (_s, _tf, _c, outcome) =>
        outcomes.push(outcome)
      );

      client.disconnect();
      assert.deepEqual(outcomes, ['abandoned']);
    } finally {
      client.disconnect();
    }
  });
});
