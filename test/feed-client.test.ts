import test from 'node:test';
import assert from 'node:assert/strict';
import { DerivWebSocketClient } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';

/**
 * Minimal in-memory WebSocket double. The client resolves the constructor from
 * the global scope, so tests install this class before calling `connect()`.
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

function latestStatuses(client: DerivWebSocketClient): Map<string, FeedStatus> {
  const seen = new Map<string, FeedStatus>();
  client.onFeedStatus((status) => seen.set(status.symbol, status));
  return seen;
}

test('a symbol only becomes LIVE after a valid tick arrives', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    const seen = latestStatuses(client);

    try {
      client.subscribeTicks('EURUSD');
      // Subscribed but no tick yet -> waiting, never "live".
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'PENDING');

      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'PENDING');

      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.09345, epoch: 1700000000, pip_size: 5 },
      });

      const status = client.getFeedStatus('EURUSD');
      assert.equal(status?.state, 'LIVE');
      assert.equal(status?.lastTickEpoch, 1700000000);
      assert.equal(client.getLatestPrice('EURUSD'), 1.09345);
      assert.equal(client.getTickCount(), 1);
      assert.equal(seen.get('EURUSD')?.state, 'LIVE');
    } finally {
      client.disconnect();
    }
  });
});

test('a MarketIsClosed subscription error is surfaced as CLOSED and counts no tick', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('EURUSD');

      socket.emit({
        error: {
          code: 'MarketIsClosed',
          message: 'This market is presently closed. Market will open at 2026-10-12 00:00:00.',
        },
        echo_req: { ticks: 'frxEURUSD', subscribe: 1 },
      });

      const status = client.getFeedStatus('EURUSD');
      assert.equal(status?.state, 'CLOSED');
      assert.equal(status?.errorCode, 'MarketIsClosed');
      assert.match(status?.errorMessage ?? '', /presently closed/);
      assert.equal(client.getTickCount(), 0);
      assert.equal(client.getLatestPrice('EURUSD'), undefined);
    } finally {
      client.disconnect();
    }
  });
});

test('an unknown-symbol error is surfaced as UNAVAILABLE', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('V75');

      socket.emit({
        error: { code: 'UnknownSymbol', message: 'Symbol is not available' },
        echo_req: { ticks: 'R_75' },
      });

      assert.equal(client.getFeedStatus('V75')?.state, 'UNAVAILABLE');
    } finally {
      client.disconnect();
    }
  });
});

test('a candle-history error does not affect a symbol feed status', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('EURUSD');
      client.fetchCandlesHistory('EURUSD', '1m', 10);

      socket.emit({
        error: { code: 'InputValidationFailed', message: 'bad request' },
        echo_req: { ticks_history: 'frxEURUSD' },
        req_id: 1,
      });

      // Still waiting for a tick; the history failure is irrelevant here.
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'PENDING');
    } finally {
      client.disconnect();
    }
  });
});

test('invalid ticks are rejected without advancing counts or prices', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('EURUSD');

      socket.emit({ msg_type: 'tick', tick: { symbol: 'frxEURUSD', quote: 'NaN', epoch: 1700000000 } });
      socket.emit({ msg_type: 'tick', tick: { symbol: 'frxEURUSD', quote: 1.1 } });
      socket.emit({ msg_type: 'tick', tick: {} });

      assert.equal(client.getTickCount(), 0);
      assert.equal(client.getLatestPrice('EURUSD'), undefined);
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'PENDING');
    } finally {
      client.disconnect();
    }
  });
});

test('re-subscribing clears a prior error so a closed market returns to waiting', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('AUDUSD');

      socket.emit({
        error: { code: 'MarketIsClosed', message: 'closed' },
        echo_req: { ticks: 'frxAUDUSD', subscribe: 1 },
      });
      assert.equal(client.getFeedStatus('AUDUSD')?.state, 'CLOSED');

      client.subscribeTicks('AUDUSD');
      assert.equal(client.getFeedStatus('AUDUSD')?.state, 'PENDING');
    } finally {
      client.disconnect();
    }
  });
});

test('unsubscribing resets the symbol feed to idle', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('EURUSD');
      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.09, epoch: 1700000000 },
      });
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'LIVE');

      client.unsubscribeTicks('EURUSD');
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'IDLE');
    } finally {
      client.disconnect();
    }
  });
});

test('Gold (frxXAUUSD) maps to XAUUSD and a closed market surfaces as CLOSED', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('XAUUSD');
      assert.equal(client.getFeedStatus('XAUUSD')?.state, 'PENDING');

      socket.emit({
        error: {
          code: 'MarketIsClosed',
          message: 'This market is presently closed. Market will open at 2026-10-12 00:00:00.',
        },
        echo_req: { ticks: 'frxXAUUSD', subscribe: 1 },
      });

      const status = client.getFeedStatus('XAUUSD');
      assert.equal(status?.state, 'CLOSED');
      assert.equal(status?.errorCode, 'MarketIsClosed');
      assert.match(status?.errorMessage ?? '', /presently closed/);
      assert.equal(client.getLatestPrice('XAUUSD'), undefined);
      assert.equal(client.getTickCount(), 0);
    } finally {
      client.disconnect();
    }
  });
});

test('a valid Gold tick becomes LIVE and records the gold price', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('XAUUSD');

      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'frxXAUUSD', quote: '4194.51', epoch: 1700000000, pip_size: '0.01' },
      });

      const status = client.getFeedStatus('XAUUSD');
      assert.equal(status?.state, 'LIVE');
      assert.equal(status?.lastTickEpoch, 1700000000);
      assert.equal(client.getLatestPrice('XAUUSD'), 4194.51);
      assert.equal(client.getTickCount(), 1);
    } finally {
      client.disconnect();
    }
  });
});

test('a Gold market-closed error does not leak into another symbol feed', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      client.subscribeTicks('XAUUSD');
      client.subscribeTicks('V75');

      socket.emit({
        error: { code: 'MarketIsClosed', message: 'closed' },
        echo_req: { ticks: 'frxXAUUSD', subscribe: 1 },
      });
      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'R_75', quote: 41500.1234, epoch: 1700000000, pip_size: '0.01' },
      });

      assert.equal(client.getFeedStatus('XAUUSD')?.state, 'CLOSED');
      assert.equal(client.getFeedStatus('V75')?.state, 'LIVE');
      assert.equal(client.getLatestPrice('XAUUSD'), undefined);
      assert.equal(client.getLatestPrice('V75'), 41500.1234);
    } finally {
      client.disconnect();
    }
  });
});

test('Gold is re-subscribed after reconnection and recovers to LIVE', async () => {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const client = new DerivWebSocketClient({
    pingIntervalMs: 1_000_000,
    reconnectBaseDelayMs: 5,
    maxReconnectDelayMs: 5,
  });

  try {
    client.connect();
    const first = FakeWebSocket.instances[0];
    first.open();
    client.subscribeTicks('XAUUSD');
    assert.equal(client.getFeedStatus('XAUUSD')?.state, 'PENDING');

    first.readyState = FakeWebSocket.CLOSED;
    first.onclose?.({ code: 1006 });
    assert.equal(client.getStatus(), 'RECONNECTING');

    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = FakeWebSocket.instances[1];
    assert.ok(second, 'a fresh socket is created on reconnect');
    second.open();

    const resubscribed = second.sent
      .map((raw) => JSON.parse(raw))
      .some((msg) => msg.ticks === 'frxXAUUSD' && msg.subscribe === 1);
    assert.equal(resubscribed, true, 'Gold is re-subscribed on the new socket');
    assert.equal(client.getFeedStatus('XAUUSD')?.state, 'PENDING');

    second.emit({
      msg_type: 'tick',
      tick: { symbol: 'frxXAUUSD', quote: '4194.51', epoch: 1700000000, pip_size: '0.01' },
    });
    assert.equal(client.getFeedStatus('XAUUSD')?.state, 'LIVE');
    assert.equal(client.getLatestPrice('XAUUSD'), 4194.51);
  } finally {
    client.disconnect();
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
});

test('subscribeTicks returns a stable snapshot of all feed statuses', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });

    try {
      client.subscribeTicks('EURUSD');
      client.subscribeTicks('V75');

      const all = client.getAllFeedStatuses();
      assert.equal(all.size, 2);
      assert.equal(all.get('EURUSD')?.state, 'PENDING');
      assert.equal(all.get('V75')?.state, 'PENDING');

      // The snapshot is a copy: mutating it cannot affect the client.
      all.delete('EURUSD');
      assert.equal(client.getFeedStatus('EURUSD')?.state, 'PENDING');
    } finally {
      client.disconnect();
    }
  });
});
