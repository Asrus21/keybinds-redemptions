const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const { Controller, REDEMPTION_TYPE } = require('../src/main/controller');
const { SCOPES } = require('../src/main/twitch/auth');
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
        scope: SCOPES,
        token_type: 'bearer',
      });
    }
    if (u.pathname === '/oauth2/validate') {
      if (!accessOk) return json({ status: 401, message: 'invalid access token' }, 401);
      return json({
        client_id: CLIENT_ID,
        login: 'streamer',
        user_id: '42',
        scopes: SCOPES,
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
  const subs = tw.calls.filter((c) => c.path.endsWith('/eventsub/subscriptions')).map((c) => JSON.parse(c.body));
  assert.deepEqual(
    subs.map((b) => b.type),
    [
      REDEMPTION_TYPE,
      'channel.cheer',
      'channel.subscribe',
      'channel.subscription.message',
      'channel.subscription.gift',
      'channel.chat.message',
    ]
  );
  // O chat é o único evento que também diz quem está lendo.
  assert.deepEqual(subs[0].condition, { broadcaster_user_id: '42' });
  assert.deepEqual(subs.at(-1).condition, { broadcaster_user_id: '42', user_id: '42' });
  const subBody = subs[0];
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
  await waitUntil(() => ctrl.getLog().some((e) => e.kind === 'event' && e.outcome === 'done'));

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

test('bits, subs, gift subs e doação disparam as regras certas', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const store = new Store({ dir });
  store.saveConfig({ ...store.loadConfig(), clientId: CLIENT_ID });
  store.saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3, scopes: SCOPES });

  // StreamElements de mentira (Socket.IO cru, EIO=3).
  const se = new WebSocketServer({ port: 0 });
  await once(se, 'listening');
  let seConn;
  se.on('connection', (ws) => {
    seConn = ws;
    ws.on('message', (m) => {
      const text = String(m);
      if (text.startsWith('42["authenticate"')) ws.send('42["authenticated",{}]');
    });
    ws.send('0{"sid":"s","pingInterval":25000,"pingTimeout":5000}');
    ws.send('40');
  });

  const tw = fakeTwitch();
  const es = await mockEventSub();
  const ctrl = new Controller({
    store,
    keyboard: createSimulatedKeyboard(),
    fetch: tw.fetch,
    eventSubUrl: es.url,
    donationDeps: { streamelements: { url: `http://127.0.0.1:${se.address().port}` } },
  });
  t.after(async () => {
    ctrl.dispose();
    for (const c of se.clients) c.terminate();
    await new Promise((r) => se.close(r));
    await es.close();
  });
  const connP = es.next();
  await ctrl.init();
  const conn = await connP;
  conn.send('session_welcome', { session: { id: 'sess', keepalive_timeout_seconds: 10 } });
  await waitUntil(() => ctrl.snapshot().connection === 'online');

  const add = (fields) => {
    const r = ctrl.addRule();
    return ctrl.updateRule(r.id, { holdMs: 10, ...fields });
  };
  add({ trigger: 'bits', min: 100, keys: ['KeyB'] });
  add({ trigger: 'bits', min: 1000, keys: ['KeyN'] });
  add({ trigger: 'sub', tier: 'any', keys: ['KeyS'] });
  add({ trigger: 'gift', min: 5, keys: ['KeyP'] });
  add({ trigger: 'donation', min: '10,00', source: 'streamelements', keys: ['KeyD'] });

  const pressed = () => ctrl.keyboard.events.filter(([dir]) => dir === 'down').map(([, code]) => code);
  const notify = (type, event) => conn.send('notification', { subscription: { type }, event }, { subscription_type: type });

  notify('channel.cheer', { is_anonymous: false, user_name: 'Bitador', bits: 1500 });
  notify('channel.cheer', { is_anonymous: true, user_name: null, bits: 50 }); // abaixo de 100: nada
  notify('channel.subscribe', { user_name: 'Novo', tier: '1000', is_gift: false });
  notify('channel.subscribe', { user_name: 'Presenteado', tier: '1000', is_gift: true }); // conta no gift
  notify('channel.subscription.message', { user_name: 'Antigo', tier: '2000', cumulative_months: 12 });
  notify('channel.subscription.gift', { user_name: 'Generoso', total: 10, tier: '1000', is_anonymous: false });
  notify('channel.subscription.gift', { user_name: null, total: 1, tier: '1000', is_anonymous: true }); // abaixo de 5
  await waitUntil(() => pressed().length === 4);
  assert.deepEqual(pressed(), ['KeyN', 'KeyS', 'KeyS', 'KeyP'], '1500 bits cai só na faixa de 1000+');

  // Doação pelo StreamElements, conectado pela tela.
  assert.equal(ctrl.connectDonation('streamelements', { token: 'jwt' }), true);
  await waitUntil(() => ctrl.snapshot().donations.find((d) => d.name === 'streamelements').state === 'online');
  seConn.send(`42${JSON.stringify(['event', { type: 'tip', data: { tipId: 't1', displayName: 'Doador', amount: 9.99, currency: 'BRL' } }])}`);
  seConn.send(`42${JSON.stringify(['event', { type: 'tip', data: { tipId: 't2', displayName: 'Doador', amount: 15, currency: 'BRL' } }])}`);
  await waitUntil(() => pressed().length === 5);
  assert.equal(pressed()[4], 'KeyD');
  await waitUntil(() => ctrl.getLog().every((e) => e.outcome !== 'queued'));

  const log = ctrl.getLog().filter((e) => e.kind === 'event');
  const line = (e) => `${e.user} ${e.action} ${e.target} [${e.outcome}]`;
  const lines = log.map(line);
  assert.ok(lines.includes('Bitador mandou 1.500 bits [done]'), lines.join('\n'));
  assert.ok(lines.includes('Anônimo mandou 50 bits [ignored]'));
  assert.ok(lines.includes('Antigo renovou Tier 2 · 12 meses [done]'));
  assert.ok(lines.includes('Generoso deu 10 subs de presente [done]'));
  assert.ok(lines.some((l) => /^Doador doou R\$\s?15,00 \[done\]$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^Doador doou R\$\s?9,99 \[ignored\]$/.test(l)));
  assert.equal(log.find((e) => e.action === 'doou').via, 'StreamElements');
  assert.ok(!lines.some((l) => l.startsWith('Presenteado')), 'sub de presente não aparece duas vezes');

  // Credencial salva cifrada e some ao desconectar.
  assert.deepEqual(store.loadSecret('donations'), { streamelements: { token: 'jwt' } });
  ctrl.disconnectDonation('streamelements');
  assert.equal(store.loadSecret('donations'), null);
  assert.throws(() => ctrl.connectDonation('livepix', { clientId: 'x' }), /Client Secret/);
});

test('Twitch recusa bits/subs (403): resgates seguem funcionando, com aviso', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const store = new Store({ dir });
  store.saveConfig({ ...store.loadConfig(), clientId: CLIENT_ID });
  store.saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3, scopes: SCOPES });
  const tw = fakeTwitch();
  const fetch = async (url, init = {}) => {
    if (String(url).includes('/eventsub/subscriptions') && !String(init.body).includes('reward_redemption')) {
      return new Response(JSON.stringify({ status: 403, message: 'subscription missing proper authorization' }), { status: 403 });
    }
    return tw.fetch(url, init);
  };
  const es = await mockEventSub();
  const ctrl = new Controller({ store, keyboard: createSimulatedKeyboard(), fetch, eventSubUrl: es.url });
  t.after(() => {
    ctrl.dispose();
    return es.close();
  });
  const connP = es.next();
  await ctrl.init();
  const conn = await connP;
  conn.send('session_welcome', { session: { id: 'sess', keepalive_timeout_seconds: 10 } });
  await waitUntil(() => ctrl.snapshot().connection === 'online');
  const errors = ctrl.getLog().filter((e) => e.kind === 'error').map((e) => e.text);
  assert.equal(errors.length, 5);
  assert.match(errors.join('\n'), /bits: subscription missing proper authorization/);
});

test('"Parar tudo" cancela o teste que ainda está na contagem e diz quantas parou', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const kb = createSimulatedKeyboard();
  const pressed = [];
  kb.keyDown = (c) => pressed.push(c);
  kb.keyUp = () => {};
  const ctrl = new Controller({ store: new Store({ dir }), keyboard: kb, fetch: async () => new Response('{}'), testDelayMs: 5000 });
  t.after(() => ctrl.dispose());
  ctrl.load();
  const rule = ctrl.addRule();
  ctrl.updateRule(rule.id, { keys: ['KeyG'], holdMs: 10 });

  assert.equal(ctrl.stopAll(), 0, 'nada rodando');
  const started = Date.now();
  const test1 = ctrl.testRule(rule.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctrl.stopAll(), 1);
  assert.deepEqual(await test1, { ok: false, aborted: true });
  assert.ok(Date.now() - started < 1000, 'não esperou a contagem');
  assert.deepEqual(pressed, [], 'nenhuma tecla apertada');
  assert.ok(ctrl.getLog().some((e) => e.kind === 'test' && e.outcome === 'aborted'));
});

test('comando do chat aperta a tecla, respeitando os selos de quem digitou', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const store = new Store({ dir });
  store.saveConfig({ ...store.loadConfig(), clientId: CLIENT_ID });
  const kb = createSimulatedKeyboard();
  const ctrl = new Controller({
    store,
    keyboard: kb,
    fetch: fakeTwitch().fetch,
    testDelayMs: 0,
  });
  t.after(() => ctrl.dispose());
  ctrl.load();

  const livre = ctrl.addRule();
  ctrl.updateRule(livre.id, { trigger: 'command', command: '!som', who: 'all', keys: ['KeyS'], holdMs: 10 });
  const soMod = ctrl.addRule();
  ctrl.updateRule(soMod.id, { trigger: 'command', command: '!clip', who: 'mod', keys: ['F13'], holdMs: 10 });

  const chat = (text, badges = [], user = 'Viewer') =>
    ctrl.handleTwitchEvent('channel.chat.message', {
      chatter_user_name: user,
      message: { text },
      badges,
    });

  chat('!som');
  chat('!SOM com texto depois'); // maiúscula e argumento continuam valendo
  chat('oi gente'); // conversa normal não vira comando
  chat('!clip'); // viewer não pode
  chat('!clip', [{ set_id: 'vip', id: '1' }]); // VIP ainda não é mod
  chat('!clip', [{ set_id: 'moderator', id: '1' }], 'Mod');
  chat('!clip', [{ set_id: 'broadcaster', id: '1' }], 'Dono');

  await waitUntil(() => ctrl.runner.pending === 0);

  const apertadas = kb.events.filter(([dir]) => dir === 'down').map(([, code]) => code);
  assert.deepEqual(apertadas, ['KeyS', 'KeyS', 'F13', 'F13']);

  const log = ctrl.getLog().filter((e) => e.kind === 'event');
  assert.equal(log.filter((e) => e.outcome === 'ignored').length, 3, 'conversa e os dois !clip negados');
  assert.equal(log[0].user, 'Dono');
  assert.equal(log[0].trigger, 'command');
});

test('selo não conhecido não dá poder nenhum', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-ctrl-'));
  const store = new Store({ dir });
  const ctrl = new Controller({ store, keyboard: createSimulatedKeyboard(), fetch: fakeTwitch().fetch });
  t.after(() => ctrl.dispose());
  ctrl.load();
  const r = ctrl.addRule();
  ctrl.updateRule(r.id, { trigger: 'command', command: '!x', who: 'mod', keys: ['KeyX'], holdMs: 10 });

  // Nome parecido com mod, e um selo inventado: nenhum dos dois conta.
  ctrl.handleTwitchEvent('channel.chat.message', {
    chatter_user_name: 'moderator',
    message: { text: '!x' },
    badges: [{ set_id: 'glitchcon2020', id: '1' }, { set_id: 'moderatorzinho', id: '1' }],
  });
  await waitUntil(() => ctrl.runner.pending === 0);
  assert.deepEqual(ctrl.snapshot().rules.length, 1);
  assert.equal(ctrl.getLog()[0].outcome, 'ignored');
});
