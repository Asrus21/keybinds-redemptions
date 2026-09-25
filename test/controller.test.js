const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const { Controller, REDEMPTION_TYPE } = require('../src/main/controller');
const { Store } = require('../src/main/store');
const { createSimulatedKeyboard } = require('../src/main/keyboard');

const CLIENT_ID = 'abcdefghijklmnopqrstuvwxyz0123';

// Twitch de mentira: responde as rotas de OAuth e Helix que o app usa e
// guarda cada chamada para o teste conferir.
function fakeTwitch() {
  const calls = [];
  let accessOk = true;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = (init.headers && init.headers.Authorization) || '';
    calls.push({ method, path: u.host + u.pathname, body: init.body, auth });

    if (u.pathname === '/oauth2/device') {
      return json({
        device_code: 'dev-code',
        user_code: 'ABCDEFGH',
        verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
        expires_in: 1800,
        interval: 1,
      });
    }
    if (u.pathname === '/oauth2/token') {
      return json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 14000,
        scope: ['channel:read:redemptions'],
        token_type: 'bearer',
      });
    }
    if (u.pathname === '/oauth2/validate') {
      if (!accessOk) return json({ status: 401, message: 'invalid access token' }, 401);
      return json({
        client_id: CLIENT_ID,
        login: 'streamer',
        user_id: '42',
        scopes: ['channel:read:redemptions'],
        expires_in: 14000,
      });
    }
    if (u.pathname === '/oauth2/revoke') return new Response(null, { status: 200 });
    if (u.pathname === '/helix/users') {
      return json({
        data: [{ id: '42', login: 'streamer', display_name: 'Streamer', profile_image_url: '' }],
      });
    }
    if (u.pathname === '/helix/channel_points/custom_rewards') {
      return json({
        data: [
          { id: 'reward-1', title: 'Pular', cost: 100, is_enabled: true, is_paused: false, background_color: '#9146FF', image: null, default_image: { url_2x: '' } },
          { id: 'reward-2', title: 'Largar a arma', cost: 5000, is_enabled: true, is_paused: false, background_color: '#00C7AC', image: null, default_image: { url_2x: '' } },
        ],
      });
    }
    if (u.pathname === '/helix/eventsub/subscriptions') {
      return json({ data: [{ id: 'sub-1', status: 'enabled' }] }, 202);
    }
    return json({ message: 'not found' }, 404);
  }

  return {
    fetch,
    calls,
    set accessOk(v) {
      accessOk = v;
    },
  };
}

async function mockEventSub() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const waiters = [];
  let n = 0;
  wss.on('connection', (ws) => {
    const conn = {
      ws,
      send(type, payload, meta = {}) {
        n += 1;
        ws.send(JSON.stringify({ metadata: { message_id: `m${n}`, message_type: type, ...meta }, payload }));
      },
    };
    const w = waiters.shift();
    if (w) w(conn);
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/ws`,
    next: () => new Promise((r) => waiters.push(r)),
    close() {
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => wss.close(r));
    },
  };
}

function waitUntil(fn, ms = 3000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('tempo esgotado esperando condição'));
      setTimeout(check, 10);
    })();
  });
}

function redeem(conn, rewardId, user = 'Viewer') {
  conn.send(
    'notification',
    {
      subscription: { type: REDEMPTION_TYPE },
      event: {
        id: `r-${Math.random()}`,
        user_login: user.toLowerCase(),
        user_name: user,
        user_input: '<img src=x onerror=alert(1)>',
        status: 'unfulfilled',
        reward: { id: rewardId, title: rewardId === 'reward-1' ? 'Pular' : 'Outra', cost: 100 },
      },
    },
    { subscription_type: REDEMPTION_TYPE }
  );
}

test('fluxo completo: login, regra, resgate aperta a tecla, pausa, sessão salva', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const tw = fakeTwitch();
  const es = await mockEventSub();
  const opened = [];
  const make = () =>
    new Controller({
      store: new Store({ dir }),
      keyboard: createSimulatedKeyboard(),
      fetch: tw.fetch,
      eventSubUrl: es.url,
      openExternal: (u) => opened.push(u),
      testDelayMs: 0,
    });

  const ctrl = make();
  t.after(() => {
    ctrl.dispose();
    return es.close();
  });
  await ctrl.init();
  assert.equal(ctrl.snapshot().auth, 'signed-out');

  assert.throws(() => ctrl.setClientId('curto'), /não parece um Client ID/);
  ctrl.setClientId(CLIENT_ID);

  // Login: abre o navegador na página de ativação e espera autorizar.
  const connP = es.next();
  await ctrl.login();
  assert.equal(opened[0], 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH');
  const snap = ctrl.snapshot();
  assert.equal(snap.auth, 'signed-in');
  assert.equal(snap.account.displayName, 'Streamer');

  // EventSub: welcome → o app se inscreve com o id da sessão.
  const conn = await connP;
  conn.send('session_welcome', { session: { id: 'sess-1', keepalive_timeout_seconds: 10 } });
  await waitUntil(() => ctrl.snapshot().connection === 'online');
  const sub = tw.calls.find((c) => c.path.endsWith('/eventsub/subscriptions'));
  assert.ok(sub, 'criou a inscrição');
  const subBody = JSON.parse(sub.body);
  assert.equal(subBody.type, REDEMPTION_TYPE);
  assert.deepEqual(subBody.transport, { method: 'websocket', session_id: 'sess-1' });
  assert.deepEqual(subBody.condition, { broadcaster_user_id: '42' });

  await waitUntil(() => ctrl.snapshot().rewardsStatus === 'ok');
  assert.deepEqual(ctrl.snapshot().rewards.map((r) => r.title), ['Pular', 'Largar a arma']);

  // Regra: "Pular" → Espaço.
  const rule = ctrl.addRule();
  ctrl.updateRule(rule.id, { rewardId: 'reward-1', keys: ['Space'], holdMs: 10 });
  assert.equal(ctrl.snapshot().rules[0].rewardTitle, 'Pular');

  redeem(conn, 'reward-1');
  await waitUntil(() => ctrl.keyboard.events.length === 2);
  assert.deepEqual(ctrl.keyboard.events, [
    ['down', 'Space'],
    ['up', 'Space'],
  ]);
  await waitUntil(() => ctrl.getLog().some((e) => e.kind === 'redeem' && e.outcome === 'done'));

  // Recompensa sem regra: só registra.
  redeem(conn, 'reward-2');
  await waitUntil(() => ctrl.getLog().some((e) => e.outcome === 'ignored'));

  // Pausado: registra e não aperta.
  ctrl.setPaused(true);
  redeem(conn, 'reward-1');
  await waitUntil(() => ctrl.getLog().some((e) => e.outcome === 'paused'));
  assert.equal(ctrl.keyboard.events.length, 2);

  // Testar funciona mesmo pausado.
  const res = await ctrl.testRule(rule.id);
  assert.deepEqual(res, { ok: true });
  assert.equal(ctrl.keyboard.events.length, 4);

  // Reabrir o app: sessão e regras voltam sem login.
  ctrl.dispose();
  const again = make();
  const conn2P = es.next();
  await again.init();
  t.after(() => again.dispose());
  assert.equal(again.snapshot().auth, 'signed-in');
  assert.equal(again.snapshot().rules.length, 1);
  assert.equal(again.snapshot().paused, true);

  // A Twitch revoga a autorização → volta para o login e apaga os tokens.
  const conn2 = await conn2P;
  conn2.send('session_welcome', { session: { id: 'sess-2', keepalive_timeout_seconds: 10 } });
  await waitUntil(() => again.snapshot().connection === 'online');
  conn2.send('revocation', { subscription: { type: REDEMPTION_TYPE, status: 'authorization_revoked' } });
  await waitUntil(() => again.snapshot().auth === 'signed-out');
  assert.match(again.snapshot().notice, /autorização/);
  assert.equal(fs.existsSync(path.join(dir, 'tokens.bin')), false);
});

test('token recusado e refresh recusado ao abrir → volta para o login com aviso', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const store = new Store({ dir });
  store.saveConfig({ ...store.loadConfig(), clientId: CLIENT_ID });
  store.saveTokens({ accessToken: 'velho', refreshToken: 'velho', expiresAt: Date.now() + 3600e3, scopes: [] });

  const tw = fakeTwitch();
  tw.accessOk = false;
  const realFetch = tw.fetch;
  const fetch = async (url, init) => {
    if (String(url).includes('/oauth2/token')) {
      return new Response(JSON.stringify({ status: 400, message: 'Invalid refresh token' }), { status: 400 });
    }
    return realFetch(url, init);
  };
  const ctrl = new Controller({ store, keyboard: createSimulatedKeyboard(), fetch });
  t.after(() => ctrl.dispose());
  await ctrl.init();
  assert.equal(ctrl.snapshot().auth, 'signed-out');
  assert.match(ctrl.snapshot().notice, /expirou/);
  assert.equal(store.loadTokens(), null);
});

test('Twitch fora do ar ao abrir: mantém o login e agenda nova tentativa', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const store = new Store({ dir });
  store.saveConfig({ ...store.loadConfig(), clientId: CLIENT_ID });
  store.saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3, scopes: [] });
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const ctrl = new Controller({ store, keyboard: createSimulatedKeyboard(), fetch });
  t.after(() => ctrl.dispose());
  await ctrl.init();
  const snap = ctrl.snapshot();
  assert.equal(snap.auth, 'signed-in');
  assert.equal(snap.connection, 'offline');
  assert.match(snap.connectionDetail, /Tentando de novo/);
  assert.ok(store.loadTokens(), 'tokens continuam salvos');
});
