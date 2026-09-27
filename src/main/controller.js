// O "cérebro" do app, sem nada de Electron: login, conexão com a Twitch e
// com os serviços de doação, regras e a fila de teclas. A janela só mostra o estado daqui e chama os
// métodos públicos; os testes fazem o mesmo com uma Twitch de mentira.
//
// Eventos: 'state' (algo mudou — a janela pede o snapshot), 'log' (entrada
// nova ou atualizada no registro), 'settings' (preferências que o processo
// principal aplica, como abrir com o Windows).

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const { ActionRunner } = require('./runner');
const {
  newRule,
  normalizeRule,
  patchRule,
  matchRules,
  describeTrigger,
  formatMoney,
  actionOf,
  TIER_LABELS,
  SOURCE_LABELS,
} = require('./rules');
const { startDeviceFlow, pollDeviceToken, revokeToken, SCOPES } = require('./twitch/auth');
const { TwitchApi, HelixError, SessionExpiredError } = require('./twitch/api');
const { EventSubClient, EVENTSUB_URL } = require('./twitch/eventsub');
const { DonationHub, CATALOG } = require('./donations');
const {
  newProfile,
  normalizeProfile,
  normalizeProfiles,
  profileForExe,
  exportProfile,
  importProfile,
  LIMITS: PROFILE_LIMITS,
} = require('./profiles');
const { checkForUpdate } = require('./updates');

const REDEMPTION_TYPE = 'channel.channel_points_custom_reward_redemption.add';

// Eventos da Twitch que o app escuta. Só os resgates são obrigatórios: se a
// Twitch recusar bits ou subs (canal sem esse recurso, por exemplo), o resto
// continua funcionando.
const TWITCH_EVENTS = [
  { type: REDEMPTION_TYPE, version: '1', label: 'resgates', required: true },
  { type: 'channel.cheer', version: '1', label: 'bits' },
  { type: 'channel.subscribe', version: '1', label: 'subs' },
  { type: 'channel.subscription.message', version: '1', label: 'renovações de sub' },
  { type: 'channel.subscription.gift', version: '1', label: 'gift subs' },
  // O chat precisa dizer quem está lendo, e quem lê é a própria conta.
  { type: 'channel.chat.message', version: '1', label: 'mensagens do chat', self: true },
];

// Selos que dão nível a quem escreveu. O dono do canal entra como mod: é o
// nível mais alto que as regras oferecem.
const BADGE_LEVEL = { broadcaster: 3, moderator: 3, vip: 2, subscriber: 1, founder: 1 };
const LOG_SIZE = 200;
const VALIDATE_EVERY_MS = 60 * 60 * 1000;
const RETRY_OFFLINE_MS = 30 * 1000;
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

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
   *   donationDeps?: object,
   *   appVersion?: string,
   *   updateUrl?: string,
   *   installer?: (import('node:events').EventEmitter & { download(): Promise<string>, install(): void }) | null,
   *   foreground?: import('./foreground').ForegroundWatcher | null,
   * }} opts
   *   `installer` (ver autoupdate.js) baixa e instala a versão nova por dentro
   *   do app. Sem ele (portátil, fora do Windows), o aviso leva para a release.
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
    donationDeps,
    appVersion = '',
    updateUrl,
    installer = null,
    foreground = null,
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

    this.appVersion = appVersion;
    this.updateUrl = updateUrl;
    // Release mais novo: { version, url, stage, percent }. stage:
    //   'available'   — aviso com o link (sem instalador, ou o download falhou)
    //   'downloading' — baixando em segundo plano, sem aviso na tela
    //   'ready'       — baixado: aviso para reiniciar e concluir
    this.update = null;
    this.updateTimer = null;
    this.installer = installer;
    if (installer) {
      installer.on('progress', (percent) => {
        if (!this.update || this.update.stage !== 'downloading') return;
        this.update.percent = percent;
        this.changed();
      });
    }
    this.pendingTests = new Set(); // "Testar" ainda na contagem

    // Troca automática de perfil pelo programa em foco (só no Windows).
    this.foreground = foreground || null;
    if (this.foreground) {
      this.foreground.on('change', (exe) => this.foregroundChanged(exe));
    }

    this.donations = new DonationHub({ deps: donationDeps });
    this.donations.on('change', () => this.changed());
    this.donations.on('log', (m) => this.info(m));
    this.donations.on('donation', (d) => this.handleDonation(d));
    this.donationCreds = {};
    this.subscribeWarned = new Set();

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

  /** O perfil ativo. Sempre existe: a normalização garante pelo menos um. */
  get profile() {
    return (
      this.config.profiles.find((p) => p.id === this.config.activeProfileId) || this.config.profiles[0]
    );
  }

  /** As regras que valem agora, isto é, as do perfil ativo. */
  get rules() {
    return this.profile.rules;
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
      rules: this.rules,
      profiles: this.config.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        matchExe: p.matchExe,
        ruleCount: p.rules.length,
      })),
      activeProfileId: this.profile.id,
      autoSwitch: {
        on: !!this.config.settings.autoSwitch,
        supported: !!(this.foreground && this.foreground.supported),
        exe: this.foreground ? this.foreground.current : '',
      },
      paused: this.config.paused,
      settings: this.config.settings,
      queue: this.runner.pending,
      keyboard: { name: this.keyboard.name, simulated: !!this.keyboard.simulated },
      donations: this.donations.status(this.donationCreds),
      // Some depois de "Agora não" até sair uma versão ainda mais nova.
      update:
        this.update && this.update.version !== this.config.settings.dismissedUpdate ? this.update : null,
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
    Object.assign(this.config, normalizeProfiles(this.config));
    delete this.config.rules; // formato antigo: virou o perfil "Padrão"
    if (this.store.restoredFrom) {
      this.error(`O config.json não abriu; as regras vieram da cópia ${this.store.restoredFrom}.`);
    }
    this.tokens = this.store.loadTokens();
    this.donationCreds = this.store.loadSecret('donations') || {};
    if (this.keyboard.simulated) {
      this.info('Fora do Windows as teclas são só simuladas: aparecem aqui no registro, mas nada é apertado.');
    }
  }

  /** Carrega (se ainda não carregou) e retoma a sessão salva, se houver. */
  async init() {
    if (!this.config) this.load();
    if (this.appVersion) {
      this.checkUpdates();
      clearInterval(this.updateTimer);
      this.updateTimer = setInterval(() => this.checkUpdates(), UPDATE_CHECK_EVERY_MS);
    }
    this.applyAutoSwitch();
    for (const [name, creds] of Object.entries(this.donationCreds)) {
      if (CATALOG[name]) this.donations.connect(name, creds);
    }
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
        // Versão nova pedindo escopo novo (o chat, por exemplo): o token
        // velho não serve, e só entrar de novo resolve.
        throw new SessionExpiredError(
          'O app precisa de mais permissões da Twitch (bits, subs e chat). Entre de novo com a Twitch.'
        );
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
      subscribe: (sessionId) => this.subscribeAll(sessionId),
    });
    this.eventsub = client;

    client.on('status', (status, detail) => {
      this.connection = status;
      this.connectionDetail = detail || '';
      if (status === 'online') this.info('Escutando os eventos do canal.');
      this.changed();
    });
    client.on('log', (text) => this.info(text));
    client.on('notification', ({ type, event }) => {
      if (event) this.handleTwitchEvent(type, event);
    });
    client.on('revocation', (sub) => {
      const status = sub.status || '';
      if (status === 'authorization_revoked' || status === 'user_removed') {
        this.signOut('A autorização do app foi removida na Twitch. Entre de novo.');
      } else {
        this.error(`A Twitch cancelou a inscrição em ${sub.type || 'um evento'} (${status || 'sem motivo'}).`);
      }
    });
    client.on('fatal', (err) => {
      if (err instanceof SessionExpiredError) return this.signOut(err.message);
      this.connection = 'offline';
      this.connectionDetail = `A Twitch recusou a inscrição nos eventos: ${err.message}`;
      this.error(this.connectionDetail);
      this.changed();
    });
    client.start();
  }

  /**
   * Inscreve a sessão da EventSub em todos os eventos. Os resgates são
   * obrigatórios (falha = erro); bits e subs são "se der" — canal sem esse
   * recurso só perde esses gatilhos, com um aviso no registro.
   */
  async subscribeAll(sessionId) {
    for (const ev of TWITCH_EVENTS) {
      try {
        await this.api.subscribeEvent(
          ev.type,
          ev.version,
          sessionId,
          this.account.id,
          ev.self ? { user_id: this.account.id } : undefined
        );
      } catch (err) {
        if (err instanceof SessionExpiredError) err.fatal = true;
        // 400/403: recusado de vez (escopo, canal…). Tentar de novo não muda.
        const refused = err instanceof HelixError && (err.status === 400 || err.status === 403);
        if (ev.required) {
          if (refused) err.fatal = true;
          throw err;
        }
        if (err.fatal) throw err;
        if (!refused) throw err; // erro passageiro: reconecta e tenta tudo de novo
        if (!this.subscribeWarned.has(ev.type)) {
          this.subscribeWarned.add(ev.type);
          this.error(`A Twitch não liberou os eventos de ${ev.label}: ${err.message}`);
        }
      }
    }
  }

  userName(event) {
    return event.user_name || event.user_login || 'Anônimo';
  }

  /** Traduz um evento da EventSub para o formato das regras. */
  handleTwitchEvent(type, e) {
    switch (type) {
      case REDEMPTION_TYPE: {
        const reward = e.reward || {};
        return this.dispatch({
          kind: 'reward',
          rewardId: reward.id,
          user: this.userName(e),
          action: 'resgatou',
          target: reward.title || '(recompensa)',
        });
      }
      case 'channel.cheer':
        return this.dispatch({
          kind: 'bits',
          amount: Number(e.bits) || 0,
          user: e.is_anonymous ? 'Anônimo' : this.userName(e),
          action: 'mandou',
          target: `${(Number(e.bits) || 0).toLocaleString('pt-BR')} bits`,
        });
      case 'channel.subscribe':
        // Cada sub dada de presente também chega aqui (is_gift). Quem conta
        // é o evento do gift, senão um gift de 10 apertaria a tecla 11 vezes.
        if (e.is_gift) return undefined;
        return this.dispatch({
          kind: 'sub',
          tier: e.tier,
          user: this.userName(e),
          action: 'assinou',
          target: TIER_LABELS[e.tier] || 'sub',
        });
      case 'channel.subscription.message':
        return this.dispatch({
          kind: 'sub',
          tier: e.tier,
          user: this.userName(e),
          action: 'renovou',
          target: `${TIER_LABELS[e.tier] || 'sub'} · ${e.cumulative_months || '?'} meses`,
        });
      case 'channel.chat.message': {
        const text = (e.message && e.message.text) || '';
        const command = text.trim().toLowerCase().split(/\s+/)[0];
        if (!command) return undefined;
        // O nível vem dos selos, não do texto: ninguém vira mod escrevendo.
        const level = (e.badges || []).reduce(
          (top, b) => Math.max(top, BADGE_LEVEL[b && b.set_id] || 0),
          0
        );
        return this.dispatch({
          kind: 'command',
          command,
          level,
          user: e.chatter_user_name || e.chatter_user_login || 'Alguém',
          action: 'digitou',
          target: command,
        });
      }
      case 'channel.subscription.gift': {
        const total = Number(e.total) || 0;
        return this.dispatch({
          kind: 'gift',
          amount: total,
          user: e.is_anonymous ? 'Anônimo' : this.userName(e),
          action: 'deu',
          target: `${total} ${total === 1 ? 'sub' : 'subs'} de presente`,
        });
      }
      default:
        return undefined;
    }
  }

  handleDonation(d) {
    return this.dispatch({
      kind: 'donation',
      amount: d.amount,
      source: d.source,
      user: d.user,
      action: 'doou',
      target: formatMoney(d.amount, d.currency),
      via: `${SOURCE_LABELS[d.source] || d.source}${d.test ? ' · teste' : ''}`,
    });
  }

  /** Acha as regras do evento e põe na fila (ou só registra, se pausado). */
  dispatch(ev) {
    const base = {
      kind: 'event',
      trigger: ev.kind,
      user: ev.user,
      action: ev.action,
      target: ev.target,
      via: ev.via || '',
    };
    const rules = matchRules(this.rules, ev);
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
      for (const rule of this.rules) {
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

  // ---------------------------------------------------------------- perfis

  findProfile(id) {
    const profile = this.config.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Perfil não encontrado.');
    return profile;
  }

  /** Troca o perfil ativo. `why` aparece no registro na troca automática. */
  setActiveProfile(id, why = '') {
    const profile = this.findProfile(id);
    if (profile.id === this.config.activeProfileId) return profile;
    // Regra do perfil velho não pode ficar apertando tecla depois da troca.
    this.runner.abortAll();
    this.cancelTests();
    this.config.activeProfileId = profile.id;
    this.save();
    this.info(`Perfil: ${profile.name}${why ? ` (${why})` : ''}.`);
    this.changed();
    return profile;
  }

  addProfile(name) {
    if (this.config.profiles.length >= PROFILE_LIMITS.profiles) {
      throw new Error(`São no máximo ${PROFILE_LIMITS.profiles} perfis.`);
    }
    const profile = newProfile(name);
    this.config.profiles.push(profile);
    this.save();
    this.changed();
    return profile;
  }

  /** Copia o perfil inteiro, com as regras. Bom para variar sem perder o original. */
  duplicateProfile(id) {
    const source = this.findProfile(id);
    // Sem o matchExe: dois perfis com o mesmo jogo fariam a troca automática
    // escolher um deles sem o streamer entender por quê.
    return this.addProfileFrom({ ...source, matchExe: '', name: `${source.name} (cópia)` });
  }

  /**
   * Põe na configuração um perfil vindo de fora (cópia ou arquivo). Ids novos
   * no perfil e em cada regra: duas regras com o mesmo id em perfis
   * diferentes seriam a mesma regra para quem procura pelo id.
   */
  addProfileFrom(raw) {
    if (this.config.profiles.length >= PROFILE_LIMITS.profiles) {
      throw new Error(`São no máximo ${PROFILE_LIMITS.profiles} perfis.`);
    }
    const rules = (Array.isArray(raw.rules) ? raw.rules : []).map((r) => ({ ...r, id: undefined }));
    const profile = normalizeProfile({ ...raw, id: undefined, rules });
    this.config.profiles.push(profile);
    this.save();
    this.changed();
    return profile;
  }

  updateProfile(id, patch) {
    const current = this.findProfile(id);
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = normalizeProfile({
      ...current,
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      ...(typeof p.matchExe === 'string' ? { matchExe: p.matchExe } : {}),
    });
    Object.assign(current, next);
    this.save();
    this.changed();
    return { id: current.id, name: current.name, matchExe: current.matchExe };
  }

  removeProfile(id) {
    this.findProfile(id);
    if (this.config.profiles.length === 1) throw new Error('É preciso ter pelo menos um perfil.');
    this.config.profiles = this.config.profiles.filter((p) => p.id !== id);
    // Apagou o ativo: cai para o primeiro que sobrou.
    if (!this.config.profiles.some((p) => p.id === this.config.activeProfileId)) {
      this.config.activeProfileId = this.config.profiles[0].id;
      this.runner.abortAll();
      this.cancelTests();
    }
    this.save();
    this.changed();
  }

  /** O perfil ativo no formato do arquivo de exportação (sem nada secreto). */
  exportProfile(id) {
    return exportProfile(this.findProfile(id));
  }

  /** Cria um perfil a partir de um arquivo exportado e deixa ele ativo. */
  importProfile(data, opts) {
    const profile = this.addProfileFrom(importProfile(data, opts));
    this.setActiveProfile(profile.id);
    this.info(`Perfil "${profile.name}" importado com ${profile.rules.length} regras.`);
    return profile;
  }

  /** Liga ou desliga o vigia do app em foco conforme a preferência. */
  applyAutoSwitch() {
    if (!this.foreground) return;
    if (this.config.settings.autoSwitch) {
      this.foreground.start();
      // Já entra no perfil do que estiver aberto agora.
      this.foregroundChanged(this.foreground.current);
    } else {
      this.foreground.stop();
    }
  }

  foregroundChanged(exe) {
    if (!this.config.settings.autoSwitch) return;
    const profile = profileForExe(this.config.profiles, exe);
    // Programa que nenhum perfil lista (navegador, OBS…) não troca nada: o
    // streamer continua no perfil em que estava.
    if (profile) this.setActiveProfile(profile.id, exe);
    else this.changed(); // a tela mostra o que está em foco
  }

  // ---------------------------------------------------------------- regras

  findRule(id) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error('Regra não encontrada.');
    return rule;
  }

  addRule() {
    const rule = newRule();
    if (this.rules.length >= PROFILE_LIMITS.rules) {
      throw new Error(`Um perfil guarda no máximo ${PROFILE_LIMITS.rules} regras.`);
    }
    this.rules.push(rule);
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
    this.profile.rules = this.rules.map((r) => (r.id === id ? next : r));
    this.save();
    this.changed();
    return next;
  }

  removeRule(id) {
    this.findRule(id);
    this.profile.rules = this.rules.filter((r) => r.id !== id);
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
    // O "Parar tudo" também cancela um teste que ainda está na contagem.
    const go = await new Promise((resolve) => {
      const item = {
        resolve,
        timer: setTimeout(() => {
          this.pendingTests.delete(item);
          resolve(true);
        }, this.testDelayMs),
      };
      this.pendingTests.add(item);
    });
    const base = { kind: 'test', target: describeTrigger(rule) };
    if (!go) {
      this.addLog({ ...base, ruleId: rule.id, keys: rule.keys, outcome: 'aborted' });
      return { ok: false, aborted: true };
    }
    return this.run(rule, base);
  }

  cancelTests() {
    const n = this.pendingTests.size;
    for (const item of this.pendingTests) {
      clearTimeout(item.timer);
      item.resolve(false);
    }
    this.pendingTests.clear();
    return n;
  }

  // ---------------------------------------------------------------- controles

  setPaused(paused) {
    this.config.paused = !!paused;
    this.save();
    this.info(this.config.paused ? 'Pausado: os eventos não apertam teclas.' : 'Retomado: os eventos voltaram a apertar teclas.');
    this.changed();
  }

  /** Devolve quantas ações (e testes na contagem) foram interrompidas. */
  stopAll() {
    const n = this.runner.abortAll() + this.cancelTests();
    if (n) this.info(`Parado: ${n} ${n === 1 ? 'ação interrompida' : 'ações interrompidas'} e teclas soltas.`);
    this.changed();
    return n;
  }

  // ---------------------------------------------------------------- doações

  /** Salva as credenciais de um serviço de doação e conecta. */
  connectDonation(name, credentials) {
    const entry = CATALOG[name];
    if (!entry) throw new Error('Serviço de doação desconhecido.');
    const creds = {};
    for (const f of entry.fields) {
      const v = String((credentials && credentials[f.key]) || '').trim();
      if (!v) throw new Error(`Preencha o campo ${f.label}.`);
      if (v.length > 4096) throw new Error(`${f.label} grande demais.`);
      creds[f.key] = v;
    }
    this.donationCreds = { ...this.donationCreds, [name]: creds };
    this.store.saveSecret('donations', this.donationCreds);
    this.donations.connect(name, creds);
    this.info(`${entry.label}: conectando…`);
    this.changed();
    return true;
  }

  disconnectDonation(name) {
    const { [name]: _removed, ...rest } = this.donationCreds;
    this.donationCreds = rest;
    this.store.saveSecret('donations', Object.keys(rest).length ? rest : null);
    this.donations.disconnect(name);
    this.changed();
  }

  // ---------------------------------------------------------------- atualização

  async checkUpdates() {
    const found = await checkForUpdate({
      currentVersion: this.appVersion,
      fetch: this.fetch,
      ...(this.updateUrl ? { url: this.updateUrl } : {}),
    });
    if (!found) {
      // Só some o aviso de link; um download em andamento ou pronto fica.
      if (this.update && this.update.stage === 'available') this.update = null;
      this.changed();
      return null;
    }
    if (this.update && this.update.stage === 'downloading') return this.update; // termina o que começou
    const same = this.update && this.update.version === found.version;
    // Mesma versão: só tenta baixar de novo se o download anterior falhou.
    if (same && !(this.installer && this.update.stage === 'available')) return this.update;

    if (!this.installer) {
      this.update = { ...found, stage: 'available', percent: 0 };
      this.info(`Versão ${found.version} disponível para download.`);
    } else {
      this.update = { ...found, stage: 'downloading', percent: 0 };
      if (!same) this.info(`Baixando a versão ${found.version}…`);
      this.downloadUpdate(this.update);
    }
    this.changed();
    return this.update;
  }

  async downloadUpdate(update) {
    try {
      const version = await this.installer.download();
      if (this.update !== update) return;
      // Normalmente é a mesma; se saiu outra no meio, vale a que baixou.
      update.version = version || update.version;
      update.stage = 'ready';
      update.percent = 100;
      this.info(`Versão ${update.version} baixada. Reinicie o app para concluir a instalação.`);
    } catch (err) {
      if (this.update !== update) return;
      // Sem download automático: volta para o aviso com o link da release.
      update.stage = 'available';
      this.error(`Não deu para baixar a atualização (${err.message}). Baixe pelo link do aviso.`);
    }
    this.changed();
  }

  /** "Reiniciar agora": fecha, instala a versão baixada e abre de novo. */
  installUpdate() {
    if (!this.installer || !this.update || this.update.stage !== 'ready') {
      throw new Error('Nenhuma atualização baixada para instalar.');
    }
    this.info(`Instalando a versão ${this.update.version}…`);
    this.installer.install();
  }

  /** "Agora não"/"Depois": esconde o aviso desta versão (volta se sair outra). */
  dismissUpdate() {
    if (!this.update) return;
    this.config.settings.dismissedUpdate = this.update.version;
    this.save();
    this.changed();
  }

  updateSettings(patch) {
    const allowed = ['closeToTray', 'openAtLogin', 'autoSwitch'];
    for (const key of allowed) {
      if (patch && typeof patch[key] === 'boolean') this.config.settings[key] = patch[key];
    }
    this.save();
    this.applyAutoSwitch();
    this.emit('settings', this.config.settings);
    this.changed();
  }

  dispose() {
    clearTimeout(this.retryTimer);
    clearInterval(this.validateTimer);
    clearInterval(this.updateTimer);
    this.cancelTests();
    if (this.foreground) this.foreground.stop();
    this.cancelLogin();
    if (this.eventsub) this.eventsub.stop();
    this.donations.stopAll();
    this.runner.abortAll();
  }
}

module.exports = { Controller, REDEMPTION_TYPE };
