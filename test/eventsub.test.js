const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const { EventSubClient } = require('../src/main/twitch/eventsub');

// Servidor EventSub de mentira: cada conexão nova vira um objeto que o teste
// controla (mandar welcome, notificação, reconnect, ficar calado…).
async function mockTwitch() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const base = `ws://127.0.0.1:${wss.address().port}`;
  const conns = [];
  const waiters = [];
  let n = 0;
  wss.on('connection', (ws, req) => {
    const conn = {
      ws,
      path: req.url,
      closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
      send(type, payload, extraMeta = {}) {
        n += 1;
        ws.send(
          JSON.stringify({
            metadata: {
              message_id: extraMeta.message_id || `msg-${n}`,
              message_type: type,
              message_timestamp: new Date().toISOString(),
              ...extraMeta,
            },
            payload,
          })
        );
      },
      welcome(id, keepalive = 10) {
        this.send('session_welcome', {
          session: { id, status: 'connected', keepalive_timeout_seconds: keepalive, reconnect_url: null },
        });
      },
    };
    conns.push(conn);
    const w = waiters.shift();
    if (w) w(conn);
  });
  return {
    base,
    conns,
    next() {
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => wss.close(r));
    },
  };
}

function redemption(overrides = {}) {
  return {
    id: 'red-1',
    broadcaster_user_id: '42',
    user_login: 'viewer',
    user_name: 'Viewer',
    user_input: '',
    status: 'unfulfilled',
    reward: { id: 'reward-1', title: 'Pular', cost: 100, prompt: '' },
    redeemed_at: new Date().toISOString(),
    ...overrides,
  };
}

function waitFor(emitter, event, predicate = () => true) {
  return new Promise((resolve) => {
    const handler = (...args) => {
      if (predicate(...args)) {
        emitter.off(event, handler);
        resolve(args);
      }
    };
    emitter.on(event, handler);
  });
}

test('welcome → inscreve → entrega resgates, ignorando mensagem repetida', async (t) => {
  const tw = await mockTwitch();
  const subscribed = [];
  const client = new EventSubClient({
    url: `${tw.base}/ws`,
    subscribe: async (id) => subscribed.push(id),
  });
  t.after(() => {
    client.stop();
    return tw.close();
  });

  const notes = [];
  client.on('notification', (n) => notes.push(n));
  const connP = tw.next();
  client.start();
  const conn = await connP;

  const online = waitFor(client, 'status', (s) => s === 'online');
  conn.welcome('sess-A');
  await online;
  assert.deepEqual(subscribed, ['sess-A']);

  const meta = {
    message_id: 'dup-1',
    subscription_type: 'channel.channel_points_custom_reward_redemption.add',
  };
  conn.send('notification', { subscription: {}, event: redemption() }, meta);
  conn.send('notification', { subscription: {}, event: redemption() }, meta);
  conn.send('session_keepalive', {});
  conn.send(
    'notification',
    { subscription: {}, event: redemption({ id: 'red-2' }) },
    { subscription_type: meta.subscription_type }
  );
  await waitFor(client, 'notification', (n) => n.event.id === 'red-2');

  assert.equal(notes.length, 2, 'a repetida (mesmo message_id) não pode disparar de novo');
  assert.equal(notes[0].type, 'channel.channel_points_custom_reward_redemption.add');
  assert.equal(notes[0].event.reward.id, 'reward-1');
});

test('session_reconnect: troca de servidor sem se inscrever de novo', async (t) => {
  const tw = await mockTwitch();
  const subscribed = [];
  const client = new EventSubClient({
    url: `${tw.base}/ws`,
    subscribe: async (id) => subscribed.push(id),
  });
  t.after(() => {
    client.stop();
    return tw.close();
  });

  let connP = tw.next();
  client.start();
  const oldConn = await connP;
  let online = waitFor(client, 'status', (s) => s === 'online');
  oldConn.welcome('sess-A');
  await online;

  connP = tw.next();
  oldConn.send('session_reconnect', {
    session: { id: 'sess-A', status: 'reconnecting', reconnect_url: `${tw.base}/novo` },
  });
  const newConn = await connP;
  assert.equal(newConn.path, '/novo');

  newConn.welcome('sess-A');
  assert.equal(await oldConn.closed, 1000, 'a conexão antiga é fechada depois do welcome da nova');
  assert.deepEqual(subscribed, ['sess-A'], 'as inscrições vêm junto: nada de se inscrever de novo');

  const got = waitFor(client, 'notification');
  newConn.send('notification', { event: redemption() }, { subscription_type: 'x' });
  const [note] = await got;
  assert.equal(note.event.id, 'red-1');
  assert.equal(client.status, 'online');
});

test('silêncio além do keepalive derruba a conexão e reconecta do zero', async (t) => {
  const tw = await mockTwitch();
  const subscribed = [];
  const client = new EventSubClient({
    url: `${tw.base}/ws`,
    subscribe: async (id) => subscribed.push(id),
    backoffMs: [10],
    keepaliveGraceMs: 50,
  });
  t.after(() => {
    client.stop();
    return tw.close();
  });

  let connP = tw.next();
  client.start();
  const first = await connP;
  connP = tw.next();
  first.welcome('sess-A', 0.1); // keepalive de 100 ms, e depois silêncio
  const second = await connP;

  const online = waitFor(client, 'status', (s) => s === 'online');
  second.welcome('sess-B');
  await online;
  assert.deepEqual(subscribed, ['sess-A', 'sess-B'], 'conexão nova do zero = inscrição nova');
});

test('conexão fechada pela Twitch (4003) volta com backoff', async (t) => {
  const tw = await mockTwitch();
  const client = new EventSubClient({
    url: `${tw.base}/ws`,
    subscribe: async () => {},
    backoffMs: [10],
  });
  t.after(() => {
    client.stop();
    return tw.close();
  });

  const statuses = [];
  client.on('status', (s, detail) => statuses.push([s, detail]));
  let connP = tw.next();
  client.start();
  const first = await connP;
  connP = tw.next();
  first.ws.close(4003);
  await connP;
  const reconnecting = statuses.find(([s]) => s === 'reconnecting');
  assert.ok(reconnecting, 'avisa que está reconectando');
  assert.match(reconnecting[1], /nenhuma inscrição/);
});

test('erro fatal na inscrição (token inválido) para de tentar', async (t) => {
  const tw = await mockTwitch();
  const client = new EventSubClient({
    url: `${tw.base}/ws`,
    subscribe: async () => {
      throw Object.assign(new Error('token inválido'), { fatal: true });
    },
    backoffMs: [10],
  });
  t.after(() => {
    client.stop();
    return tw.close();
  });

  const connP = tw.next();
  client.start();
  const conn = await connP;
  const fatal = waitFor(client, 'fatal');
  conn.welcome('sess-A');
  const [err] = await fatal;
  assert.equal(err.message, 'token inválido');
  assert.equal(client.status, 'offline');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tw.conns.length, 1, 'não reconecta depois de erro fatal');
});
