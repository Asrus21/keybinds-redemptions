// O "cérebro" do app, sem nada de Electron: login, conexão com a Twitch,
// regras e a fila de teclas. A janela só mostra o estado daqui e chama os
// métodos públicos; os testes fazem o mesmo com uma Twitch de mentira.
//
// Eventos: 'state' (algo mudou — a janela pede o snapshot), 'log' (entrada
// nova ou atualizada no registro), 'settings' (preferências que o processo
// principal aplica, como abrir com o Windows).

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const { ActionRunner } = require('./runner');
const { newRule, normalizeRule, patchRule, isRunnable, actionOf } = require('./rules');
const { startDeviceFlow, pollDeviceToken, revokeToken, SCOPES } = require('./twitch/auth');
const { TwitchApi, HelixError, SessionExpiredError } = require('./twitch/api');
const { EventSubClient, EVENTSUB_URL } = require('./twitch/eventsub');

const REDEMPTION_TYPE = 'channel.channel_points_custom_reward_redemption.add';
const LOG_SIZE = 200;
const VALIDATE_EVERY_MS = 60 * 60 * 1000;
const RETRY_OFFLINE_MS = 30 * 1000;

// Client IDs da Twitch são 30 caracteres [a-z0-9]; aceitamos com folga.
const CLIENT_ID_RE = /^[a-z0-9]{20,40}$/i;

class Controller extends EventEmitter {
  /**
   * @param {{
   *   store: import('./store').Store,
   *   keyboard: { name: string, simulated: boolean, keyDown(c: string): void, keyUp(c: string): void },
   *   openExternal?: (url: string) => void,
   *   fetch?: typeof fetch,
   *   WebSocket?: any,
   *   eventSubUrl?: string,
   *   envClientId?: string,
   *   defaultClientId?: string,
   *   testDelayMs?: number,
   * }} opts
   */
  constructor({
    store,
    keyboard,
    openExternal = () => {},
    fetch = globalThis.fetch,
    WebSocket,
    eventSubUrl = EVENTSUB_URL,
    envClientId = '',
    defaultClientId = '',
    testDelayMs = 3000,
  }) {
    super();
    this.store = store;
    this.keyboard = keyboard;
    this.openExternal = openExternal;
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.eventSubUrl = eventSubUrl;
    this.envClientId = envClientId.trim();
    this.defaultClientId = defaultClientId.trim();
    this.testDelayMs = testDelayMs;

    this.runner = new ActionRunner({ keyboard });
    this.runner.on('change', () => this.changed());

    this.config = null;
    this.tokens = null;
    this.api = null;
    this.eventsub = null;
    this.account = null;
    this.auth = 'signed-out';
    this.device = null;
    this.loginAbort = null;
    this.connection = 'offline';
    this.connectionDetail = '';
    this.rewards = [];
    this.rewardsStatus = 'idle';
    this.rewardsError = '';
    this.notice = '';
    this.logEntries = [];
    this.validateTimer = null;
    this.retryTimer = null;
    this.emitScheduled = false;
  }

  // ---------------------------------------------------------------- estado

  get clientId() {
    return this.envClientId || this.config.clientId || this.defaultClientId;
  }

  changed() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emit('state');
    });
  }

  snapshot() {
    return {
      clientId: this.clientId,
      clientIdLocked: !!this.envClientId,
      auth: this.auth,
      device: this.device,
      account: this.account,
      connection: this.connection,
      connectionDetail: this.connectionDetail,
      rewards: this.rewards,
      rewardsStatus: this.rewardsStatus,
      rewardsError: this.rewardsError,
      rules: this.config.rules,
      paused: this.config.paused,
      settings: this.config.settings,
      queue: this.runner.pending,
      keyboard: { name: this.keyboard.name, simulated: !!this.keyboard.simulated },
      notice: this.notice,
    };
  }

  getLog() {
    return this.logEntries;
  }

  addLog(entry) {
    const full = { id: crypto.randomUUID(), at: Date.now(), ...entry };
    this.logEntries.unshift(full);
    if (this.logEntries.length > LOG_SIZE) this.logEntries.length = LOG_SIZE;
    this.emit('log', full);
    return full;
  }

  updateLog(id, patch) {
    const entry = this.logEntries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.emit('log', entry);
  }

  info(text) {
    this.addLog({ kind: 'info', text });
  }

  error(text) {
    this.addLog({ kind: 'error', text });
  }

  save() {
    this.store.saveConfig(this.config);
  }

  setNotice(text) {
    this.notice = text || '';
    this.changed();
  }

  // ---------------------------------------------------------------- início

  /** Lê a configuração do disco. Síncrono: a janela já pode pedir o estado. */
  load() {
    this.config = this.store.loadConfig();
    this.config.rules = this.config.rules.map(normalizeRule);
    this.tokens = this.store.loadTokens();
    if (this.keyboard.simulated) {
      this.info('Fora do Windows as teclas são só simuladas: aparecem aqui no registro, mas nada é apertado.');
    }
  }

  /** Carrega (se ainda não carregou) e retoma a sessão salva, se houver. */
  async init() {
    if (!this.config) this.load();
    if (this.tokens && this.clientId) {
      await this.resume();
    }
    this.changed();
  }

  /** Retoma a sessão salva (ou recém-criada): valida, busca o canal e conecta. */
  async resume() {
    clearTimeout(this.retryTimer);
    this.auth = 'signed-in';
    this.api = new TwitchApi({
      clientId: this.clientId,
      tokens: this.tokens,
      fetch: this.fetch,
      onTokens: (t) => {
        this.tokens = t;
        this.store.saveTokens(t);
      },
    });
    this.changed();

    try {
      const info = await this.api.validate();
      if (info.clientId && info.clientId !== this.clientId) {
        // Token de outro app (o Client ID mudou): não serve mais.
        throw new SessionExpiredError('O Client ID mudou. Entre de novo com a Twitch.');
      }
      if (!SCOPES.every((s) => info.scopes.includes(s))) {
        throw new SessionExpiredError('Falta permissão para ler os resgates. Entre de novo com a Twitch.');
      }
      this.account = await this.api.getSelf();
      this.changed();
    } catch (err) {
      if (err instanceof SessionExpiredError) return this.signOut(err.message);
      // Sem internet, Twitch fora do ar… Mantém o login e tenta de novo.
      this.connection = 'offline';
      this.connectionDetail = `Não deu para falar com a Twitch (${err.message}). Tentando de novo em 30 s.`;
      this.changed();
      this.retryTimer = setTimeout(() => this.resume(), RETRY_OFFLINE_MS);
      return;
    }

    this.startEventSub();
    this.refreshRewards();
    clearInterval(this.validateTimer);
    this.validateTimer = setInterval(() => this.periodicValidate(), VALIDATE_EVERY_MS);
  }

  async periodicValidate() {
    if (!this.api) return;
    try {
      await this.api.validate();
    } catch (err) {
      if (err instanceof SessionExpiredError) this.signOut(err.message);
    }
  }

  // ---------------------------------------------------------------- login

  setClientId(value) {
    if (this.envClientId) throw new Error('O Client ID está fixado pela variável de ambiente TWITCH_CLIENT_ID.');
    if (this.auth !== 'signed-out') throw new Error('Saia da conta antes de trocar o Client ID.');
    const id = String(value || '').trim();
    if (id && !CLIENT_ID_RE.test(id)) {
      throw new Error('Isso não parece um Client ID da Twitch (são ~30 letras e números).');
    }
    this.config.clientId = id;
    this.save();
    this.setNotice('');
    return id;
  }

  async login() {
    if (!this.clientId) throw new Error('Informe o Client ID do seu app da Twitch primeiro.');
    if (this.auth === 'signed-in') return;
    this.cancelLogin();

    const abort = new AbortController();
    this.loginAbort = abort;
    this.auth = 'signing-in';
    this.notice = '';
    this.changed();

    try {
      const device = await startDeviceFlow({ clientId: this.clientId, fetch: this.fetch });
      if (abort.signal.aborted) return;
      this.device = {
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresAt: device.expiresAt,
      };
      this.changed();
      this.openExternal(device.verificationUri);

      const tokens = await pollDeviceToken({
        clientId: this.clientId,
        device,
        signal: abort.signal,
        fetch: this.fetch,
      });
      if (abort.signal.aborted) return;
      this.tokens = tokens;
      this.store.saveTokens(tokens);
      this.device = null;
      this.loginAbort = null;
      await this.resume();
      if (this.account) this.info(`Conectado como ${this.account.displayName}.`);
    } catch (err) {
      if (abort.signal.aborted) return;
      this.loginAbort = null;
      this.device = null;
      this.auth = 'signed-out';
      this.setNotice(err.message);
    }
  }

  cancelLogin() {
    if (this.loginAbort) this.loginAbort.abort();
    this.loginAbort = null;
    this.device = null;
    if (this.auth === 'signing-in') this.auth = 'signed-out';
    this.changed();
  }

  openActivation() {
    if (this.device) this.openExternal(this.device.verificationUri);
  }

  async logout() {
    const token = this.tokens && this.tokens.accessToken;
    const clientId = this.clientId;
    this.signOut('');
    if (token) {
      try {
        await revokeToken({ clientId, token, fetch: this.fetch });
      } catch {}
    }
  }

  /** Volta para a tela de login, apagando os tokens. */
  signOut(notice) {
    clearTimeout(this.retryTimer);
    clearInterval(this.validateTimer);
    if (this.eventsub) {
      this.eventsub.removeAllListeners();
      this.eventsub.stop();
      this.eventsub = null;
    }
    this.api = null;
    this.tokens = null;
    this.store.saveTokens(null);
    this.account = null;
    this.auth = 'signed-out';
    this.connection = 'offline';
    this.connectionDetail = '';
    this.rewards = [];
    this.rewardsStatus = 'idle';
    this.rewardsError = '';
    if (notice) this.error(notice);
    this.setNotice(notice);
  }

  // ---------------------------------------------------------------- EventSub

  startEventSub() {
    if (this.eventsub) {
      this.eventsub.removeAllListeners();
      this.eventsub.stop();
    }
    const client = new EventSubClient({
      url: this.eventSubUrl,
      ...(this.WebSocket ? { WebSocket: this.WebSocket } : {}),
      subscribe: async (sessionId) => {
        try {
          await this.api.subscribeRedemptions(sessionId, this.account.id);
        } catch (err) {
          if (err instanceof SessionExpiredError) err.fatal = true;
          // 400/403: pedido recusado de vez (escopo, canal…). Tentar de novo
          // não muda nada.
          if (err instanceof HelixError && (err.status === 400 || err.status === 403)) err.fatal = true;
          throw err;
        }
      },
    });
    this.eventsub = client;

    client.on('status', (status, detail) => {
      this.connection = status;
      this.connectionDetail = detail || '';
      if (status === 'online') this.info('Escutando os resgates do canal.');
      this.changed();
    });
    client.on('log', (text) => this.info(text));
    client.on('notification', ({ type, event }) => {
      if (type === REDEMPTION_TYPE && event) this.handleRedemption(event);
    });
    client.on('revocation', (sub) => {
      const status = sub.status || '';
      if (status === 'authorization_revoked' || status === 'user_removed') {
        this.signOut('A autorização do app foi removida na Twitch. Entre de novo.');
      } else {
        this.error(`A Twitch cancelou a inscrição dos resgates (${status || 'sem motivo'}).`);
      }
    });
    client.on('fatal', (err) => {
      if (err instanceof SessionExpiredError) return this.signOut(err.message);
      this.connection = 'offline';
      this.connectionDetail = `A Twitch recusou a inscrição nos resgates: ${err.message}`;
      this.error(this.connectionDetail);
      this.changed();
    });
    client.start();
  }

  handleRedemption(event) {
    const reward = event.reward || {};
    const base = {
      kind: 'redeem',
      user: event.user_name || event.user_login || 'alguém',
      reward: reward.title || '(recompensa)',
      cost: reward.cost,
    };
    const rules = this.config.rules.filter((r) => r.rewardId === reward.id && isRunnable(r));
    if (rules.length === 0) {
      this.addLog({ ...base, outcome: 'ignored' });
      return;
    }
    if (this.config.paused) {
      this.addLog({ ...base, keys: rules[0].keys, outcome: 'paused' });
      return;
    }
    for (const rule of rules) this.run(rule, base);
  }

  run(rule, logBase) {
    const entry = this.addLog({ ...logBase, ruleId: rule.id, keys: rule.keys, outcome: 'queued' });
    return this.runner.enqueue(actionOf(rule)).then((res) => {
      this.updateLog(entry.id, {
        outcome: res.ok ? 'done' : res.aborted ? 'aborted' : 'error',
        error: res.error || '',
      });
      return res;
    });
  }

  // ---------------------------------------------------------------- recompensas

  async refreshRewards() {
    if (!this.api || !this.account) return;
    this.rewardsStatus = 'loading';
    this.rewardsError = '';
    this.changed();
    try {
      this.rewards = await this.api.getRewards(this.account.id);
      this.rewardsStatus = 'ok';
      // Mantém o título guardado nas regras em dia (é o que aparece se a
      // recompensa for apagada depois).
      let touched = false;
      for (const rule of this.config.rules) {
        const r = this.rewards.find((x) => x.id === rule.rewardId);
        if (r && r.title !== rule.rewardTitle) {
          rule.rewardTitle = r.title;
          touched = true;
        }
      }
      if (touched) this.save();
    } catch (err) {
      if (err instanceof SessionExpiredError) return this.signOut(err.message);
      this.rewardsStatus = 'error';
      this.rewardsError =
        err instanceof HelixError && err.status === 403
          ? 'Só canais Afiliados ou Parceiros têm pontos do canal.'
          : `Não deu para buscar as recompensas: ${err.message}`;
    }
    this.changed();
  }

  // ---------------------------------------------------------------- regras

  findRule(id) {
    const rule = this.config.rules.find((r) => r.id === id);
    if (!rule) throw new Error('Regra não encontrada.');
    return rule;
  }

  addRule() {
    const rule = newRule();
    this.config.rules.push(rule);
    this.save();
    this.changed();
    return rule;
  }

  updateRule(id, patch) {
    const current = this.findRule(id);
    const p = { ...(patch || {}) };
    if (typeof p.rewardId === 'string') {
      const reward = this.rewards.find((r) => r.id === p.rewardId);
      p.rewardTitle = reward ? reward.title : p.rewardId ? current.rewardTitle : '';
    }
    const next = patchRule(current, p);
    this.config.rules = this.config.rules.map((r) => (r.id === id ? next : r));
    this.save();
    this.changed();
    return next;
  }

  removeRule(id) {
    this.findRule(id);
    this.config.rules = this.config.rules.filter((r) => r.id !== id);
    this.save();
    this.changed();
  }

  /**
   * "Testar": espera uns segundos (tempo de voltar para o jogo) e aperta.
   * Funciona mesmo pausado e sem login — é um clique do próprio streamer.
   */
  async testRule(id) {
    const rule = this.findRule(id);
    if (!rule.keys.length) throw new Error('Escolha uma tecla antes de testar.');
    await new Promise((r) => setTimeout(r, this.testDelayMs));
    return this.run(rule, { kind: 'test', reward: rule.rewardTitle || 'Teste' });
  }

  // ---------------------------------------------------------------- controles

  setPaused(paused) {
    this.config.paused = !!paused;
    this.save();
    this.info(this.config.paused ? 'Pausado: resgates não apertam teclas.' : 'Retomado: resgates voltaram a apertar teclas.');
    this.changed();
  }

  stopAll() {
    const n = this.runner.abortAll();
    if (n) this.info(`Parado: ${n} ${n === 1 ? 'ação interrompida' : 'ações interrompidas'} e teclas soltas.`);
    this.changed();
  }

  updateSettings(patch) {
    const allowed = ['closeToTray', 'openAtLogin'];
    for (const key of allowed) {
      if (patch && typeof patch[key] === 'boolean') this.config.settings[key] = patch[key];
    }
    this.save();
    this.emit('settings', this.config.settings);
    this.changed();
  }

  dispose() {
    clearTimeout(this.retryTimer);
    clearInterval(this.validateTimer);
    this.cancelLogin();
    if (this.eventsub) this.eventsub.stop();
    this.runner.abortAll();
  }
}

module.exports = { Controller, REDEMPTION_TYPE };
