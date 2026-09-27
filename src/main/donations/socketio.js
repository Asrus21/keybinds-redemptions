// Cliente Socket.IO mínimo, direto no WebSocket (pacote `ws`).
//
// StreamElements e Streamlabs entregam os eventos em tempo real por Socket.IO.
// Em vez de puxar o socket.io-client inteiro (e brigar com versão de
// protocolo), falamos o básico do protocolo na mão:
//
//   Engine.IO (a camada de baixo), primeiro caractere de cada mensagem:
//     0 open (JSON com pingInterval/pingTimeout)   2 ping   3 pong
//     1 close                                       4 message (Socket.IO)
//   Socket.IO (dentro de uma mensagem "4"):
//     40 conectou   41 desconectou   42["evento", dados] evento   44 erro
//
// EIO=3 (Socket.IO 2.x, o que os dois usam): o cliente manda ping e o
// servidor responde pong. EIO=4: o contrário. Respondemos ping nos dois casos
// e também mandamos no 3, então funciona com qualquer um.
//
// Eventos: 'connect', 'event' (nome, dados), 'ioerror' (dados do pacote 44),
// 'close' (motivo), 'log' (texto).

const { EventEmitter } = require('node:events');

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];

class SocketIoClient extends EventEmitter {
  /**
   * @param {{ url: string, query?: Record<string, string>, eio?: 3 | 4, WebSocket?: any, backoffMs?: number[] }} opts
   *   `url` é o endereço base (https://…); o caminho /socket.io/ é montado aqui.
   */
  constructor({ url, query = {}, eio = 3, WebSocket = require('ws'), backoffMs = BACKOFF_MS }) {
    super();
    const u = new URL(url);
    u.protocol = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:';
    u.pathname = '/socket.io/';
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    u.searchParams.set('EIO', String(eio));
    u.searchParams.set('transport', 'websocket');
    this.wsUrl = u.toString();
    this.eio = eio;
    this.WebSocket = WebSocket;
    this.backoffMs = backoffMs;
    this.ws = null;
    this.stopped = true;
    this.attempt = 0;
    this.pingTimer = null;
    this.deadTimer = null;
    this.retryTimer = null;
    this.deadMs = 60_000;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.teardown();
  }

  /** Emite um evento para o servidor: 42["nome", dados]. */
  send(event, data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(`42${JSON.stringify([event, data])}`);
  }

  teardown() {
    clearInterval(this.pingTimer);
    clearTimeout(this.deadTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        ws.terminate();
      } catch {}
    }
  }

  open() {
    const ws = new this.WebSocket(this.wsUrl);
    this.ws = ws;
    this.armDead();
    ws.on('message', (data) => this.onRaw(String(data)));
    ws.on('close', () => this.onClose('conexão fechada'));
    ws.on('error', (err) => this.emit('log', `erro no socket (${err.message})`));
  }

  // Sem nenhuma mensagem por pingInterval + pingTimeout: conexão morta.
  armDead() {
    clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      this.emit('log', 'o servidor ficou em silêncio; reconectando');
      try {
        this.ws && this.ws.terminate();
      } catch {}
    }, this.deadMs);
  }

  onRaw(text) {
    this.armDead();
    const type = text[0];
    const body = text.slice(1);
    if (type === '0') {
      let info = {};
      try {
        info = JSON.parse(body);
      } catch {}
      const interval = Number(info.pingInterval) || 25_000;
      const timeout = Number(info.pingTimeout) || 20_000;
      this.deadMs = interval + timeout + 5_000;
      this.armDead();
      if (this.eio === 3) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.ws && this.ws.readyState === 1 && this.ws.send('2'), interval);
      } else {
        this.ws.send('40'); // no Socket.IO 3+ o cliente pede para entrar no namespace
      }
    } else if (type === '2') {
      if (this.ws) this.ws.send(`3${body}`);
    } else if (type === '1') {
      try {
        this.ws.close();
      } catch {}
    } else if (type === '4') {
      this.onPacket(body);
    }
  }

  onPacket(packet) {
    const kind = packet[0];
    let rest = packet.slice(1);
    // Namespace ("/algo,") não usamos; pula se vier.
    if (rest.startsWith('/')) rest = rest.slice(rest.indexOf(',') + 1);
    if (kind === '0') {
      this.attempt = 0;
      this.emit('connect');
    } else if (kind === '2') {
      // Pode vir um id de ack antes do JSON: 42123["evento",…]
      const json = rest.replace(/^\d+/, '');
      let arr;
      try {
        arr = JSON.parse(json);
      } catch {
        return;
      }
      if (Array.isArray(arr) && typeof arr[0] === 'string') this.emit('event', arr[0], arr[1]);
    } else if (kind === '4') {
      let data = rest;
      try {
        data = JSON.parse(rest);
      } catch {}
      this.emit('ioerror', data); // nome próprio: 'error' sem ouvinte derruba o processo
    } else if (kind === '1') {
      try {
        this.ws.close();
      } catch {}
    }
  }

  onClose(reason) {
    this.teardown();
    this.emit('close', reason);
    if (this.stopped) return;
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }
}

module.exports = { SocketIoClient };
