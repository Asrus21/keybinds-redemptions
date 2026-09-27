// Serviços de doação. Cada um vira uma "fonte" com a mesma cara:
//
//   start() / stop()
//   evento 'status' (state, detalhe) — state: connecting | online | reconnecting | error | offline
//   evento 'donation' ({ id, source, user, amount, currency, message, test })
//   evento 'log' (texto)
//
// `amount` é sempre o valor em unidades da moeda (10.5 = R$ 10,50).
//
// Os formatos das mensagens abaixo seguem as APIs públicas de cada serviço
// (Realtime/Socket API do StreamElements e do Streamlabs, API v2 da LivePix,
// webhooks do PixGG).
// Onde o serviço não documenta um campo, lemos mais de um nome possível.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { SocketIoClient } = require('./socketio');

function toAmount(value) {
  if (typeof value === 'string') value = value.replace(/[^\d.,-]/g, '').replace(',', '.');
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

class Source extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.state = 'offline';
    this.detail = '';
  }

  setStatus(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.emit('status', state, detail);
  }

  donation(d) {
    const amount = toAmount(d.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.emit('donation', {
      id: d.id || crypto.randomUUID(),
      source: this.name,
      user: text(d.user, 60) || 'Anônimo',
      amount,
      currency: text(d.currency, 8).toUpperCase(),
      message: text(d.message, 300),
      test: !!d.test,
    });
  }
}

// ---------------------------------------------------------------- StreamElements

// Token: streamelements.com → Account (Minha conta) → Channels → "Show secrets"
// → JWT Token.
class StreamElementsSource extends Source {
  constructor({ token, url = 'https://realtime.streamelements.com', WebSocket }) {
    super('streamelements');
    this.token = token;
    this.client = new SocketIoClient({ url, eio: 3, ...(WebSocket ? { WebSocket } : {}) });
    this.client.on('connect', () => this.client.send('authenticate', { method: 'jwt', token: this.token }));
    this.client.on('event', (name, data) => this.onEvent(name, data));
    this.client.on('ioerror', () => this.onEvent('unauthorized'));
    this.client.on('close', () => {
      if (this.state !== 'error' && this.state !== 'offline') this.setStatus('reconnecting', 'Conexão caiu; tentando de novo.');
    });
    this.client.on('log', (m) => this.emit('log', `StreamElements: ${m}`));
  }

  start() {
    this.setStatus('connecting');
    this.client.start();
  }

  stop() {
    this.client.stop();
    this.setStatus('offline');
  }

  onEvent(name, data) {
    if (name === 'authenticated') {
      this.setStatus('online');
    } else if (name === 'unauthorized') {
      this.client.stop();
      this.setStatus('error', 'O StreamElements recusou o token. Copie o JWT Token de novo no painel do SE.');
    } else if (name === 'event' && data && data.type === 'tip') {
      const d = data.data || {};
      this.donation({
        id: d.tipId || data._id,
        user: d.displayName || d.username,
        amount: d.amount,
        currency: d.currency,
        message: d.message,
      });
    } else if (name === 'event:test' && data && data.listener === 'tip-latest') {
      // Botão "Emulate" do painel do StreamElements.
      const e = data.event || {};
      this.donation({ user: e.name, amount: e.amount, message: e.message, test: true });
    }
  }
}

// ---------------------------------------------------------------- Streamlabs

// Token: streamlabs.com → Settings → API Settings → API Tokens → "Your Socket
// API Token".
class StreamlabsSource extends Source {
  constructor({ token, url = 'https://sockets.streamlabs.com', WebSocket }) {
    super('streamlabs');
    this.client = new SocketIoClient({
      url,
      eio: 3,
      query: { token },
      ...(WebSocket ? { WebSocket } : {}),
    });
    this.client.on('connect', () => this.setStatus('online'));
    this.client.on('event', (name, data) => this.onEvent(name, data));
    this.client.on('ioerror', () => {
      this.client.stop();
      this.setStatus('error', 'O Streamlabs recusou o token. Copie o Socket API Token de novo.');
    });
    this.client.on('close', () => {
      if (this.state !== 'error' && this.state !== 'offline') this.setStatus('reconnecting', 'Conexão caiu; tentando de novo.');
    });
    this.client.on('log', (m) => this.emit('log', `Streamlabs: ${m}`));
  }

  start() {
    this.setStatus('connecting');
    this.client.start();
  }

  stop() {
    this.client.stop();
    this.setStatus('offline');
  }

  onEvent(name, data) {
    if (name !== 'event' || !data || data.type !== 'donation') return;
    const list = Array.isArray(data.message) ? data.message : [data.message];
    for (const m of list) {
      if (!m) continue;
      this.donation({
        id: m.id || m._id || data.event_id,
        user: m.name || m.from,
        amount: m.amount,
        currency: m.currency,
        message: m.message,
        test: !!m.isTest,
      });
    }
  }
}

// ---------------------------------------------------------------- LivePix

// A LivePix não tem socket público: avisa por webhook (precisaria de servidor)
// ou pela API de mensagens. Aqui consultamos a API a cada poucos segundos.
//
// Credenciais: livepix.gg → Configurações → Aplicações → criar aplicação com a
// permissão messages:read → Client ID e Client Secret.
const LIVEPIX_TOKEN_URL = 'https://oauth.livepix.gg/oauth2/token';
const LIVEPIX_MESSAGES_URL = 'https://api.livepix.gg/v2/messages';

class LivePixSource extends Source {
  constructor({ clientId, clientSecret, fetch = globalThis.fetch, intervalMs = 5000 }) {
    super('livepix');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetch;
    this.intervalMs = intervalMs;
    this.token = null;
    this.timer = null;
    this.seen = new Set();
    this.primed = false;
    this.running = false;
  }

  start() {
    this.running = true;
    this.setStatus('connecting');
    this.tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.setStatus('offline');
  }

  schedule(ms = this.intervalMs) {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => this.tick(), ms);
  }

  async getToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'messages:read',
    });
    const res = await this.fetch(LIVEPIX_TOKEN_URL, { method: 'POST', body });
    if (res.status === 400 || res.status === 401) {
      const err = new Error('A LivePix recusou o Client ID/Client Secret.');
      err.fatal = true;
      throw err;
    }
    if (!res.ok) throw new Error(`LivePix respondeu ${res.status} ao pedir o token.`);
    const data = await res.json();
    this.token = data.access_token;
  }

  async fetchMessages() {
    if (!this.token) await this.getToken();
    const url = `${LIVEPIX_MESSAGES_URL}?page=1&limit=20`;
    let res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (res.status === 401) {
      await this.getToken();
      res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    }
    if (!res.ok) throw new Error(`LivePix respondeu ${res.status} ao listar as doações.`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.data || body.messages || [];
    return list.filter((m) => m && m.id);
  }

  async tick() {
    if (!this.running) return;
    try {
      const messages = await this.fetchMessages();
      if (!this.running) return;
      // Na primeira consulta só anotamos o que já existia: doação de antes
      // de abrir o app não aperta tecla.
      const fresh = messages.filter((m) => !this.seen.has(m.id)).reverse();
      for (const m of messages) this.seen.add(m.id);
      if (this.seen.size > 1000) this.seen = new Set(messages.map((m) => m.id));
      if (this.primed) {
        for (const m of fresh) {
          this.donation({
            id: m.id,
            user: m.username || m.name,
            // A API da LivePix manda o valor em centavos.
            amount: toAmount(m.amount) / 100,
            currency: m.currency || 'BRL',
            message: m.message,
          });
        }
      }
      this.primed = true;
      if (this.state !== 'online') this.setStatus('online');
      this.schedule();
    } catch (err) {
      if (err.fatal) {
        this.running = false;
        this.setStatus('error', err.message);
        return;
      }
      this.setStatus('reconnecting', `${err.message} Tentando de novo.`);
      this.schedule(Math.max(this.intervalMs, 15_000));
    }
  }
}

// ---------------------------------------------------------------- PixGG

// O PixGG só avisa por webhook: um POST para uma URL pública, assinado com
// HMAC-SHA256 do clientSecret. Como o PC do streamer não tem URL pública, o
// asrus.app recebe o POST e guarda (rota /api/pixgg/relay/<rota>), e este app
// busca lá a cada poucos segundos.
//
//   - <rota> é um HMAC do clientSecret: estável entre aberturas, impossível de
//     adivinhar, e o segredo não sai do PC.
//   - O app mesmo cadastra a URL no PixGG (POST /Applications/set-webhook-url).
//   - A assinatura de cada evento é conferida aqui; o repasse não é confiável.
//
// Credenciais: pixgg.com → Aplicações → criar uma aplicação (use uma só para
// este app: a URL de webhook dela passa a ser a do repasse).
const PIXGG_API = 'https://app.pixgg.com';
const PIXGG_RELAY = 'https://asrus.app/api/pixgg/relay/';

function pixggRoute(clientSecret) {
  return crypto.createHmac('sha256', clientSecret).update('keybinds-redemptions/pixgg-relay').digest('hex');
}

function validPixggSignature(body, secret, header) {
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`);
  const got = Buffer.from(String(header || ''));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

class PixggSource extends Source {
  constructor({
    clientId,
    clientSecret,
    fetch = globalThis.fetch,
    apiBase = PIXGG_API,
    relayBase = PIXGG_RELAY,
    intervalMs = 3000,
  }) {
    super('pixgg');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetch;
    this.apiBase = apiBase;
    this.relayUrl = relayBase + pixggRoute(clientSecret);
    this.intervalMs = intervalMs;
    this.cursor = null;
    this.registered = false;
    this.running = false;
    this.timer = null;
  }

  start() {
    this.running = true;
    this.setStatus('connecting');
    this.tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.setStatus('offline');
  }

  schedule(ms = this.intervalMs) {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => this.tick(), ms);
  }

  /** Aponta o webhook da aplicação do PixGG para o repasse. */
  async register() {
    const res = await this.fetch(`${this.apiBase}/Applications/set-webhook-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': this.clientId,
        'X-Client-Secret': this.clientSecret,
      },
      body: JSON.stringify({ webhookUrl: this.relayUrl }),
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error('O PixGG recusou o Client ID/Client Secret.');
      err.fatal = true;
      throw err;
    }
    if (!res.ok) throw new Error(`PixGG respondeu ${res.status} ao cadastrar o webhook.`);
    this.registered = true;
  }

  async poll() {
    const url = this.cursor === null ? this.relayUrl : `${this.relayUrl}?after=${this.cursor}`;
    const res = await this.fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`o repasse do asrus.app respondeu ${res.status}.`);
    const body = await res.json();
    // Primeira consulta: só pega o ponto de partida. Doação de antes de abrir
    // o app não aperta tecla.
    const first = this.cursor === null;
    for (const ev of first ? [] : body.eventos || []) this.handle(ev);
    if (Number.isFinite(Number(body.cursor))) this.cursor = Number(body.cursor);
  }

  handle(ev) {
    if (!validPixggSignature(ev.corpo, this.clientSecret, ev.assinatura)) {
      this.emit('log', 'PixGG: evento com assinatura inválida descartado.');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(ev.corpo);
    } catch {
      return;
    }
    // donation.created é o Pix gerado, ainda não pago. Só o pago conta.
    if (!payload || payload.event !== 'donation.paid') return;
    const d = payload.data || {};
    if (d.status && d.status !== 'paid') return;
    this.donation({
      id: d.transactionPublicId,
      user: d.donatorUsername,
      amount: d.totalAmount,
      currency: 'BRL',
      message: d.message,
    });
  }

  async tick() {
    if (!this.running) return;
    try {
      if (!this.registered) await this.register();
      await this.poll();
      if (!this.running) return;
      if (this.state !== 'online') this.setStatus('online');
      this.schedule();
    } catch (err) {
      if (err.fatal) {
        this.running = false;
        this.setStatus('error', err.message);
        return;
      }
      this.setStatus('reconnecting', `${err.message} Tentando de novo.`);
      this.schedule(Math.max(this.intervalMs, 15_000));
    }
  }
}

// ---------------------------------------------------------------- catálogo

const CATALOG = {
  streamelements: {
    label: 'StreamElements',
    fields: [{ key: 'token', label: 'JWT Token' }],
    help: 'streamelements.com → Account → Channels → Show secrets → JWT Token',
    create: (c, deps) => new StreamElementsSource({ token: c.token, ...deps.streamelements }),
  },
  streamlabs: {
    label: 'Streamlabs',
    fields: [{ key: 'token', label: 'Socket API Token' }],
    help: 'streamlabs.com → Settings → API Settings → API Tokens → Your Socket API Token',
    create: (c, deps) => new StreamlabsSource({ token: c.token, ...deps.streamlabs }),
  },
  livepix: {
    label: 'LivePix',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret' },
    ],
    help: 'livepix.gg → Configurações → Aplicações → criar com a permissão messages:read',
    create: (c, deps) =>
      new LivePixSource({ clientId: c.clientId, clientSecret: c.clientSecret, ...deps.livepix }),
  },
  pixgg: {
    label: 'PixGG',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret' },
    ],
    help: 'pixgg.com → Aplicações → crie uma aplicação só para este app (ele cadastra o webhook dela sozinho)',
    create: (c, deps) => new PixggSource({ clientId: c.clientId, clientSecret: c.clientSecret, ...deps.pixgg }),
  },
};

module.exports = {
  CATALOG,
  StreamElementsSource,
  StreamlabsSource,
  LivePixSource,
  PixggSource,
  pixggRoute,
  toAmount,
};
