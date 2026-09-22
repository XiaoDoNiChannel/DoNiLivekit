import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatClient } from '../src/features/chatClient.js';

async function loadChatStore(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  return import('../src/stores/chatStore.js');
}

class FakeSocket {
  readyState = WebSocket.CONNECTING;
  sent = [];
  closeCalls = 0;
  send(data) {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(JSON.parse(data));
  }
  // Intentionally no close event: browser/network shutdown can stall indefinitely.
  close() {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSING;
  }
  open() { this.readyState = WebSocket.OPEN; this.onopen?.(); }
  error() { this.onerror?.({ type: 'error' }); }
  closed() { this.readyState = WebSocket.CLOSED; this.onclose?.(); }
  message(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

const options = { apiBase: 'http://chat.test', userId: 'alice', connectionId: 'test-connection' };
const payload = (id = 'message-1') => ({ clientMessageId: id, channelId: 'day0', content: 'hello' });

function setup(t, callbacks = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const sockets = [];
  const failures = [];
  const messages = [];
  const states = [];
  const client = createChatClient({
    onMessageFailed: (failure) => failures.push(failure),
    onMessage: (message) => messages.push(message),
    onConnectionChange: (state) => states.push(state.connected),
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...callbacks,
  });
  t.after(() => client.disconnect());
  return { client, sockets, failures, messages, states, tick: (ms) => t.mock.timers.tick(ms) };
}

async function openClient(h) {
  const promise = h.client.connect(options);
  h.sockets.at(-1).open();
  assert.equal(await promise, true);
  return h.sockets.at(-1);
}

test('20ms deadline includes a handshake that never emits any events', async (t) => {
  const h = setup(t);
  const promise = h.client.ensureConnected(options, 20);
  h.tick(20);
  assert.equal(await promise, false);
  assert.equal(h.sockets[0].closeCalls, 1);
  assert.equal(h.client.isConnected(), false);
});

for (const failure of ['error', 'closed']) {
  test(`handshake ${failure} settles all callers without waiting for reconnect`, async (t) => {
    const h = setup(t);
    const first = h.client.connect(options);
    const ensure = h.client.ensureConnected(options, 20);
    const waiter = h.client.waitUntilConnected(20);
    h.sockets[0][failure]();
    assert.deepEqual(await Promise.all([first, ensure, waiter]), [false, false, false]);
    h.tick(1000);
    assert.equal(h.sockets.length, 2);
    h.sockets[1].open();
    assert.equal(await h.client.ensureConnected({}, 20), true);
  });
}

test('concurrent connect calls share one promise and one socket', async (t) => {
  const h = setup(t);
  const first = h.client.connect(options);
  assert.equal(h.client.connect(options), first);
  const ensure = h.client.ensureConnected(options, 20);
  const waiter = h.client.waitUntilConnected(20);
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open();
  assert.deepEqual(await Promise.all([first, ensure, waiter]), [true, true, true]);
});

test('a shorter caller deadline does not cancel the shared handshake', async (t) => {
  const h = setup(t);
  const first = h.client.connect(options);
  const short = h.client.ensureConnected({}, 20);
  h.tick(20);
  assert.equal(await short, false);
  assert.equal(h.sockets[0].closeCalls, 0);
  h.sockets[0].open();
  assert.equal(await first, true);
});

test('direct connect also has a default deadline', async (t) => {
  const h = setup(t);
  const promise = h.client.connect(options);
  h.tick(3000);
  assert.equal(await promise, false);
});

test('constructor failure returns false and can recover on retry', async (t) => {
  let count = 0;
  const socket = new FakeSocket();
  const h = setup(t, { webSocketFactory: () => {
    if (++count === 1) throw new Error('invalid or unavailable transport');
    return socket;
  } });
  assert.equal(await h.client.ensureConnected(options, 20), false);
  h.tick(1000);
  socket.open();
  assert.equal(h.client.isConnected(), true);
});

test('missing configuration returns false without starting a connection', async (t) => {
  const h = setup(t);
  assert.equal(await h.client.ensureConnected({}, 20), false);
  h.tick(10_000);
  assert.equal(h.sockets.length, 0);
});

test('disconnect cancels every handshake waiter and automatic reconnect', async (t) => {
  const h = setup(t);
  const direct = h.client.connect(options);
  const waiter = h.client.waitUntilConnected(20);
  const ensure = h.client.ensureConnected({}, 20);
  h.client.disconnect();
  assert.deepEqual(await Promise.all([direct, waiter, ensure]), [false, false, false]);
  h.sockets[0].open();
  h.sockets[0].closed();
  h.tick(60_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.client.isConnected(), false);
});

test('old open/message/error/close callbacks cannot mutate a replacement socket', async (t) => {
  const h = setup(t);
  const old = await openClient(h);
  h.client.disconnect();
  const current = await openClient(h);
  h.client.subscribeChannel('day0');
  current.message({ type: 'chat_subscribed', channelId: 'day0' });
  h.client.sendMessage(payload());
  const stateCount = h.states.length;
  const messageCount = h.messages.length;
  old.open();
  old.message({ type: 'chat_subscribed', channelId: 'stale-channel' });
  old.message({ type: 'message_ack', clientMessageId: 'message-1', status: 'ok' });
  old.error();
  old.closed();
  assert.equal(h.client.getConfirmedChannel(), 'day0');
  assert.equal(h.client.isConnected(), true);
  assert.equal(h.states.length, stateCount);
  assert.equal(h.messages.length, messageCount);
  h.tick(10_000);
  assert.equal(h.failures[0].reason, 'ack_timeout');
});

test('automatic reconnect backs off, restores subscription and resets on open', async (t) => {
  const h = setup(t);
  const first = h.client.connect(options);
  h.client.subscribeChannel('day0');
  h.sockets[0].closed();
  assert.equal(await first, false);
  h.tick(999);
  assert.equal(h.sockets.length, 1);
  h.tick(1);
  h.sockets[1].closed();
  h.tick(1999);
  assert.equal(h.sockets.length, 2);
  h.tick(1);
  h.sockets[2].open();
  assert.deepEqual(h.sockets[2].sent, [{ type: 'subscribe_channel', channelId: 'day0' }]);
  h.sockets[2].closed();
  h.tick(1000);
  assert.equal(h.sockets.length, 4);
});

test('a blackhole after open is retired on pong deadline even without close events', async (t) => {
  const h = setup(t);
  const socket = await openClient(h);
  h.tick(12_000);
  assert.equal(socket.sent.at(-1).type, 'ping');
  h.tick(29_999);
  assert.equal(h.client.isConnected(), true);
  h.tick(1);
  assert.equal(h.client.isConnected(), false);
  assert.equal(socket.closeCalls, 1);
  h.tick(1000);
  assert.equal(h.sockets.length, 2);
});

test('pong keeps heartbeat alive and disconnect clears heartbeat timers', async (t) => {
  const h = setup(t);
  const socket = await openClient(h);
  for (let i = 0; i < 4; i += 1) {
    h.tick(12_000);
    assert.equal(socket.sent.at(-1).type, 'ping');
    socket.message({ type: 'pong' });
  }
  assert.equal(h.client.isConnected(), true);
  h.client.disconnect();
  const sentCount = socket.sent.length;
  h.tick(60_000);
  assert.equal(socket.sent.length, sentCount);
  assert.equal(h.sockets.length, 1);
});

test('socket.send success leaves sending until ACK deadline; failure is retryable', async (t) => {
  const h = setup(t);
  const socket = await openClient(h);
  assert.equal(h.client.sendMessage(payload()), true);
  assert.equal(h.client.sendMessage(payload()), true);
  assert.equal(socket.sent.filter((message) => message.type === 'send_message').length, 1);
  h.tick(9999);
  assert.equal(h.failures.length, 0);
  h.tick(1);
  assert.deepEqual(h.failures, [{ clientMessageId: 'message-1', reason: 'ack_timeout' }]);
  assert.equal(h.client.sendMessage(payload()), true);
  assert.equal(socket.sent.filter((message) => message.type === 'send_message').length, 2);
  socket.message({ type: 'message_ack', clientMessageId: 'message-1', status: 'ok' });
  h.tick(10_000);
  assert.equal(h.failures.length, 1);
});

for (const confirmation of ['message_ack', 'message_created']) {
  test(`${confirmation} clears ACK deadline and disconnect cannot fail a delivered message`, async (t) => {
    const h = setup(t);
    const socket = await openClient(h);
    h.client.sendMessage(payload());
    socket.message({ type: confirmation, clientMessageId: 'message-1', status: 'ok', message: payload() });
    h.tick(10_000);
    h.client.disconnect();
    assert.equal(h.failures.length, 0);
    assert.equal(h.messages.at(-1).type, confirmation);
  });
}

test('error ACK clears timeout and is delivered to the application', async (t) => {
  const h = setup(t);
  const socket = await openClient(h);
  h.client.sendMessage(payload());
  socket.message({ type: 'message_ack', clientMessageId: 'message-1', status: 'error' });
  h.tick(10_000);
  assert.equal(h.failures.length, 0);
  assert.equal(h.messages.at(-1).status, 'error');
});

for (const failure of ['closed', 'error', 'disconnect']) {
  test(`${failure} fails unconfirmed messages once and clears ACK timers`, async (t) => {
    const h = setup(t);
    const socket = await openClient(h);
    h.client.sendMessage(payload());
    if (failure === 'disconnect') h.client.disconnect();
    else socket[failure]();
    assert.equal(h.failures.length, 1);
    h.client.disconnect();
    h.tick(60_000);
    assert.equal(h.failures.length, 1);
  });
}

test('send exception returns false without leaving an ACK timer', async (t) => {
  const h = setup(t);
  const socket = await openClient(h);
  socket.throwOnSend = true;
  assert.equal(h.client.sendMessage(payload()), false);
  h.tick(10_000);
  assert.equal(h.failures.length, 0);
});

test('message store transitions sending -> failed -> sent on late confirmation', async (t) => {
  const { switchChatChannel, addChatMessage, markMessageFailed, markMessageSent } = await loadChatStore(t);
  switchChatChannel('deadline-test');
  const message = addChatMessage({ ...payload('deadline-message'), channelId: 'deadline-test', isSelf: true });
  const h = setup(t, {
    onMessageFailed: ({ clientMessageId }) => markMessageFailed(clientMessageId),
    onMessage: (event) => {
      if (event.type === 'message_ack' && event.status === 'ok') markMessageSent(event);
    },
  });
  const socket = await openClient(h);
  h.client.sendMessage(payload('deadline-message'));
  assert.equal(message.status, 'sending');
  h.tick(10_000);
  assert.equal(message.status, 'failed');
  socket.message({ type: 'message_ack', clientMessageId: 'deadline-message', status: 'ok' });
  assert.equal(message.status, 'sent');
  markMessageFailed('deadline-message');
  assert.equal(message.status, 'sent');
});

test('history confirmation cannot be downgraded by a later ACK timeout', async (t) => {
  const { switchChatChannel, addChatMessage, applyServerChatMessage, markMessageFailed } = await loadChatStore(t);
  switchChatChannel('history-test');
  const message = addChatMessage({ ...payload('history-message'), channelId: 'history-test', isSelf: true });
  const h = setup(t, { onMessageFailed: ({ clientMessageId }) => markMessageFailed(clientMessageId) });
  await openClient(h);
  h.client.sendMessage(payload('history-message'));
  applyServerChatMessage({ ...message, id: 'history-message' }, 'alice');
  assert.equal(message.status, 'sent');
  h.tick(10_000);
  assert.equal(message.status, 'sent');
});
