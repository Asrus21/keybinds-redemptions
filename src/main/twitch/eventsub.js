// Cliente da EventSub por WebSocket — é por aqui que a Twitch avisa, na hora,
// que alguém resgatou uma recompensa. Não precisa de servidor nem de porta
// aberta: o app conecta para fora e a Twitch empurra os eventos.
//
// O ciclo, do jeito que a Twitch define:
//   - conecta → chega `session_welcome` com o id da sessão;
//   - em até 10 s o app cria as inscrições com esse id (senão a Twitch fecha
//     com 4003);
//   - daí em diante chegam `notification` (os resgates) e, nos intervalos,
//     `session_keepalive`. Se passar do keepalive sem mensagem nenhuma, a
//     conexão morreu: reconecta do zero e se inscreve de novo;
//   - `session_reconnect` avisa que o servidor vai sair do ar: abre a conexão
//     nova no endereço indicado, espera o welcome dela e só então fecha a
//     antiga. Nesse caso as inscrições vêm junto — não se inscreve de novo.
//
// O app nunca manda mensagem pelo socket (a Twitch fecha com 4001 se mandar).

const { EventEmitter } = require('node:events');

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

const CLOSE_REASONS = {
  4000: 'erro interno da Twitch',
  4001: 'o app enviou uma mensagem (não deveria)',
  4002: 'falhou no ping-pong',
  4003: 'nenhuma inscrição criada a tempo',
  4004: 'tempo de reconexão esgotado',
  4005: 'tempo de rede esgotado',
  4006: 'erro de rede',
  4007: 'reconexão inválida',
};

// Espera entre tentativas de reconectar do zero (a última se repete).
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
// Folga em cima do keepalive antes de dar a conexão como morta.
const KEEPALIVE_GRACE_MS = 5000;
// Quantos ids de mensagem lembrar para descartar repetidas.
const DEDUPE_SIZE = 500;

class EventSubClient extends EventEmitter {
  /**
   * @param {{
   *   subscribe: (sessionId: string) => Promise<void>,
   *   url?: string,
   *   WebSocket?: any,
   *   backoffMs?: number[],
   *   keepaliveGraceMs?: number,
   * }} opts
   *   `subscribe` cria as inscrições para uma sessão nova. Se ele lançar um erro
   *   com `fatal: true` (token inválido, por exemplo), o cliente para de tentar.
   *
   * Eventos: 'status' (connecting | online | reconnecting | offline, detalhe),
   * 'notification' ({ type, event, messageId }), 'revocation' (subscription),
   * 'fatal' (erro), 'log' (texto).
   */
  constructor({
    subscribe,
    url = EVENTSUB_URL,
    WebSocket = require('ws'),
    backoffMs = BACKOFF_MS,
    keepaliveGraceMs = KEEPALIVE_GRACE_MS,
  }) {
    super();
    this.subscribe = subscribe;
    this.url = url;
    this.WebSocket = WebSocket;
    this.backoffMs = backoffMs;
    this.keepaliveGraceMs = keepaliveGraceMs;

    this.stopped = true;
    this.active = null; // conexão que está valendo
    this.incoming = null; // conexão nova durante um session_reconnect
    this.attempt = 0;
    this.retryTimer = null;
    this.seen = new Set();
    this.status = 'offline';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open(this.url, 'fresh');
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const sock of [this.active, this.incoming]) if (sock) this.retire(sock);
    this.active = null;
    this.incoming = null;
    this.setStatus('offline');
  }

  setStatus(status, detail = '') {
    if (this.status === status && !detail) return;
    this.status = status;
    this.emit('status', status, detail);
  }

  open(url, kind) {
    if (kind === 'fresh') this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    const ws = new this.WebSocket(url);
    // Até o welcome chegar vale o keepalive padrão da Twitch (10 s): servidor
    // que aceita a conexão e não dá welcome também conta como morto.
    const sock = { ws, kind, sessionId: null, keepaliveMs: 10_000, timer: null, retired: false };
    if (kind === 'fresh') this.active = sock;
    else this.incoming = sock;
    this.armKeepalive(sock);

    ws.on('message', (data) => this.onMessage(sock, data));
    ws.on('close', (code, reason) => this.onClose(sock, code, String(reason || '')));
    ws.on('error', (err) => this.emit('log', `EventSub: erro no socket (${err.message}).`));
    return sock;
  }

  /** Fecha uma conexão sem disparar a lógica de reconectar. */
  retire(sock) {
    sock.retired = true;
    clearTimeout(sock.timer);
    try {
      sock.ws.close(1000);
    } catch {}
    // Se o close educado não andar, derruba.
    setTimeout(() => {
      try {
        sock.ws.terminate();
      } catch {}
    }, 2000).unref?.();
  }

  armKeepalive(sock) {
    clearTimeout(sock.timer);
    sock.timer = setTimeout(() => {
      this.emit('log', 'EventSub: a Twitch ficou em silêncio além do keepalive; reconectando.');
      try {
        sock.ws.terminate();
      } catch {}
    }, sock.keepaliveMs + this.keepaliveGraceMs);
  }

  isDuplicate(id) {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    if (this.seen.size > DEDUPE_SIZE) this.seen.delete(this.seen.values().next().value);
    return false;
  }

  onMessage(sock, data) {
    if (sock.retired) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const meta = (msg && msg.metadata) || {};
    const payload = (msg && msg.payload) || {};
    this.armKeepalive(sock);
    if (this.isDuplicate(meta.message_id)) return;

    switch (meta.message_type) {
      case 'session_welcome':
        this.onWelcome(sock, payload.session || {});
        break;
      case 'session_keepalive':
        break;
      case 'notification':
        this.emit('notification', {
          type: meta.subscription_type,
          event: payload.event,
          messageId: meta.message_id,
        });
        break;
      case 'session_reconnect': {
        const next = payload.session && payload.session.reconnect_url;
        if (next && !this.incoming) {
          this.emit('log', 'EventSub: a Twitch pediu para trocar de servidor.');
          this.open(next, 'reconnect');
        }
        break;
      }
      case 'revocation':
        this.emit('revocation', payload.subscription || {});
        break;
      default:
        break;
    }
  }

  async onWelcome(sock, session) {
    sock.sessionId = session.id;
    sock.keepaliveMs = (Number(session.keepalive_timeout_seconds) || 10) * 1000;
    this.armKeepalive(sock);

    if (sock.kind === 'reconnect') {
      // A conexão nova já herdou as inscrições: troca e aposenta a antiga.
      const old = this.active;
      this.active = sock;
      this.incoming = null;
      sock.kind = 'fresh';
      if (old) this.retire(old);
      this.setStatus('online');
      return;
    }

    try {
      await this.subscribe(session.id);
      if (sock.retired || sock !== this.active) return;
      this.attempt = 0;
      this.setStatus('online');
    } catch (err) {
      if (sock.retired) return;
      if (err && err.fatal) {
        this.stop();
        this.emit('fatal', err);
        return;
      }
      this.emit('log', `EventSub: não deu para se inscrever nos resgates (${err.message}).`);
      try {
        sock.ws.terminate();
      } catch {}
    }
  }

  onClose(sock, code, reason) {
    clearTimeout(sock.timer);
    if (sock.retired || this.stopped) return;

    const why = CLOSE_REASONS[code] || reason || `código ${code}`;

    if (sock === this.incoming) {
      // A conexão nova morreu antes do welcome. Se a antiga ainda está de pé,
      // segue nela; se não, recomeça do zero.
      this.incoming = null;
      this.emit('log', `EventSub: a troca de servidor falhou (${why}).`);
      if (!this.active) this.scheduleFresh(why);
      return;
    }

    if (sock === this.active) {
      this.active = null;
      // Durante uma troca de servidor a antiga pode cair antes da nova dar
      // welcome; aí esperamos a nova.
      if (this.incoming) return;
      this.scheduleFresh(why);
    }
  }

  scheduleFresh(why) {
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt += 1;
    this.setStatus('reconnecting', `Conexão caiu (${why}). Tentando de novo em ${Math.round(delay / 1000)} s.`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.open(this.url, 'fresh');
    }, delay);
  }
}

module.exports = { EventSubClient, EVENTSUB_URL, CLOSE_REASONS };
