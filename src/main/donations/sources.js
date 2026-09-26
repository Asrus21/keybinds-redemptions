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
// (Realtime/Socket API do StreamElements e do Streamlabs, API v2 da LivePix).
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
};

module.exports = { CATALOG, StreamElementsSource, StreamlabsSource, LivePixSource, toAmount };
