const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const { StreamElementsSource, StreamlabsSource, LivePixSource } = require('../src/main/donations/sources');
const { DonationHub } = require('../src/main/donations');

// Servidor Socket.IO 2.x (EIO=3) de mentira, falando o protocolo cru.
async function fakeSocketIo() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const waiters = [];
  wss.on('connection', (ws, req) => {
    const conn = {
      ws,
      url: new URL(req.url, 'http://x'),
      received: [],
      waiting: [],
      emit(event, data) {
        ws.send(`42${JSON.stringify([event, data])}`);
      },
      nextMessage() {
        if (this.received.length) return Promise.resolve(this.received.shift());
        return new Promise((r) => this.waiting.push(r));
      },
    };
    ws.on('message', (m) => {
      const text = String(m);
      if (text === '2') return ws.send('3'); // ping do cliente (EIO3)
      const w = conn.waiting.shift();
      if (w) w(text);
      else conn.received.push(text);
    });
    ws.send('0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":5000}');
    ws.send('40');
    const w = waiters.shift();
    if (w) w(conn);
  });
  return {
    url: `http://127.0.0.1:${wss.address().port}`,
    next: () => new Promise((r) => waiters.push(r)),
    close() {
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => wss.close(r));
    },
  };
}

function waitFor(emitter, event, pred = () => true) {
  return new Promise((resolve) => {
    const h = (...args) => {
      if (pred(...args)) {
        emitter.off(event, h);
        resolve(args);
      }
    };
    emitter.on(event, h);
  });
}

test('StreamElements: autentica com o JWT e entrega tips (e o "Emulate" do painel)', async (t) => {
  const srv = await fakeSocketIo();
  const src = new StreamElementsSource({ token: 'jwt-123', url: srv.url });
  t.after(() => {
    src.stop();
    return srv.close();
  });
  const connP = srv.next();
  src.start();
  const conn = await connP;
  assert.equal(conn.url.pathname, '/socket.io/');
  assert.equal(conn.url.searchParams.get('EIO'), '3');

  const first = await conn.nextMessage();
  assert.deepEqual(JSON.parse(first.slice(2)), ['authenticate', { method: 'jwt', token: 'jwt-123' }]);

  const online = waitFor(src, 'status', (s) => s === 'online');
  conn.emit('authenticated', { channelId: 'c1' });
  await online;

  const got = [];
  src.on('donation', (d) => got.push(d));
  conn.emit('event', {
    _id: 'evt1',
    type: 'tip',
    provider: 'twitch',
    data: { tipId: 'tip1', username: 'fulano', displayName: 'Fulano', amount: 10.5, currency: 'BRL', message: 'oi' },
  });
  conn.emit('event', { type: 'follower', data: { username: 'x' } }); // ignorado
  conn.emit('event:test', { listener: 'tip-latest', event: { name: 'Teste', amount: 3, message: '' } });
  await waitFor(src, 'donation', (d) => d.test);
  assert.equal(got.length, 2);
  assert.deepEqual(
    { ...got[0] },
    { id: 'tip1', source: 'streamelements', user: 'Fulano', amount: 10.5, currency: 'BRL', message: 'oi', test: false }
  );
  assert.equal(got[1].user, 'Teste');
  assert.equal(got[1].amount, 3);
});

test('StreamElements: token recusado vira erro e não fica reconectando', async (t) => {
  const srv = await fakeSocketIo();
  const src = new StreamElementsSource({ token: 'ruim', url: srv.url });
  t.after(() => {
    src.stop();
    return srv.close();
  });
  const connP = srv.next();
  src.start();
  const conn = await connP;
  const err = waitFor(src, 'status', (s) => s === 'error');
  conn.emit('unauthorized', { message: 'invalid token' });
  const [, detail] = await err;
  assert.match(detail, /recusou o token/);
});

test('Streamlabs: token vai na URL e doações chegam em lista', async (t) => {
  const srv = await fakeSocketIo();
  const src = new StreamlabsSource({ token: 'sl-token', url: srv.url });
  t.after(() => {
    src.stop();
    return srv.close();
  });
  const connP = srv.next();
  const online = waitFor(src, 'status', (s) => s === 'online');
  src.start();
  const conn = await connP;
  await online;
  assert.equal(conn.url.searchParams.get('token'), 'sl-token');

  const got = [];
  src.on('donation', (d) => got.push(d));
  conn.emit('event', {
    type: 'donation',
    for: 'streamlabs',
    event_id: 'e1',
    message: [
      { id: 1, name: 'Ana', amount: '25.00', formatted_amount: '$25.00', currency: 'USD', message: 'gg' },
      { id: 2, name: 'Bia', amount: 5, currency: 'BRL', message: '' },
    ],
  });
  conn.emit('event', { type: 'follow', message: [{ name: 'x' }] });
  await waitFor(src, 'donation', (d) => d.user === 'Bia');
  assert.deepEqual(got.map((d) => [d.user, d.amount, d.currency]), [
    ['Ana', 25, 'USD'],
    ['Bia', 5, 'BRL'],
  ]);
});

test('LivePix: ignora o que já existia, entrega as novas em reais, renova o token', async (t) => {
  let tokenCalls = 0;
  let listCalls = 0;
  const batches = [
    [{ id: 'old1', username: 'Antigo', amount: 500, currency: 'BRL' }],
    [
      { id: 'new2', username: 'Maria', amount: 2000, currency: 'BRL', message: 'vai!' },
      { id: 'new1', username: 'João', amount: 1050, currency: 'BRL' },
      { id: 'old1', username: 'Antigo', amount: 500, currency: 'BRL' },
    ],
  ];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      tokenCalls += 1;
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('grant_type'), 'client_credentials');
      assert.equal(body.get('client_id'), 'cid');
      return new Response(JSON.stringify({ access_token: `tok${tokenCalls}`, expires_in: 3600 }), { status: 200 });
    }
    listCalls += 1;
    // Na segunda consulta o token "venceu": 401, o app pede outro e repete.
    if (listCalls === 2 && init.headers.Authorization === 'Bearer tok1') return new Response('', { status: 401 });
    const data = listCalls === 1 ? batches[0] : batches[1];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  const src = new LivePixSource({ clientId: 'cid', clientSecret: 'sec', fetch, intervalMs: 20 });
  t.after(() => src.stop());
  const got = [];
  src.on('donation', (d) => got.push(d));
  src.start();
  await waitFor(src, 'donation', (d) => d.user === 'Maria');
  assert.deepEqual(got.map((d) => [d.user, d.amount]), [
    ['João', 10.5],
    ['Maria', 20],
  ], 'mais antiga primeiro, em reais; a de antes de abrir o app não entra');
  assert.equal(tokenCalls, 2);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 2, 'não repete as mesmas doações nas consultas seguintes');
});

test('LivePix: credencial recusada vira erro e para de consultar', async (t) => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response('{"error":"invalid_client"}', { status: 401 });
  };
  const src = new LivePixSource({ clientId: 'x', clientSecret: 'y', fetch, intervalMs: 10 });
  t.after(() => src.stop());
  const err = waitFor(src, 'status', (s) => s === 'error');
  src.start();
  const [, detail] = await err;
  assert.match(detail, /recusou/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
});

test('hub descarta a mesma doação repetida (reconexão, reenvio)', async (t) => {
  const srv = await fakeSocketIo();
  const hub = new DonationHub({ deps: { streamelements: { url: srv.url } } });
  t.after(() => {
    hub.stopAll();
    return srv.close();
  });
  const connP = srv.next();
  hub.connect('streamelements', { token: 't' });
  const conn = await connP;
  const got = [];
  hub.on('donation', (d) => got.push(d));
  const tip = { type: 'tip', data: { tipId: 'same', username: 'a', amount: 1 } };
  conn.emit('event', tip);
  conn.emit('event', tip);
  conn.emit('event', { type: 'tip', data: { tipId: 'other', username: 'b', amount: 2 } });
  await waitFor(hub, 'donation', (d) => d.id === 'other');
  assert.deepEqual(got.map((d) => d.id), ['same', 'other']);
  const status = hub.status({ streamelements: { token: 't' } });
  assert.equal(status.find((s) => s.name === 'streamelements').configured, true);
  assert.equal(status.find((s) => s.name === 'livepix').configured, false);
});
