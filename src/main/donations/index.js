// Liga e desliga as fontes de doação configuradas e junta tudo num lugar só.
//
// Eventos: 'donation' (doação normalizada), 'change' (status de alguma fonte
// mudou), 'log' (texto).

const { EventEmitter } = require('node:events');
const { CATALOG } = require('./sources');

// A mesma doação pode chegar duas vezes (reconexão, serviço que reenvia).
const DEDUPE_SIZE = 300;

class DonationHub extends EventEmitter {
  /**
   * @param {{ deps?: object }} opts — `deps` troca URL/fetch/WebSocket de cada
   *   serviço (só nos testes). Ex.: { streamelements: { url, WebSocket } }.
   */
  constructor({ deps = {} } = {}) {
    super();
    this.deps = { streamelements: {}, streamlabs: {}, livepix: {}, pixgg: {}, ...deps };
    this.sources = new Map();
    this.seen = new Set();
  }

  /** Conecta (ou reconecta com credenciais novas) um serviço. */
  connect(name, credentials) {
    const entry = CATALOG[name];
    if (!entry) throw new Error(`Serviço desconhecido: ${name}`);
    this.disconnect(name);
    const source = entry.create(credentials, this.deps);
    source.on('status', () => this.emit('change'));
    source.on('log', (m) => this.emit('log', m));
    source.on('donation', (d) => {
      const key = `${d.source}:${d.id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > DEDUPE_SIZE) this.seen.delete(this.seen.values().next().value);
      this.emit('donation', d);
    });
    this.sources.set(name, source);
    source.start();
  }

  disconnect(name) {
    const source = this.sources.get(name);
    if (!source) return;
    source.removeAllListeners();
    source.stop();
    this.sources.delete(name);
    this.emit('change');
  }

  stopAll() {
    for (const name of [...this.sources.keys()]) this.disconnect(name);
  }

  /** Estado de cada serviço do catálogo, para a tela (sem as credenciais). */
  status(configured) {
    return Object.entries(CATALOG).map(([name, entry]) => {
      const source = this.sources.get(name);
      return {
        name,
        label: entry.label,
        help: entry.help,
        fields: entry.fields,
        configured: !!(configured && configured[name]),
        state: source ? source.state : 'offline',
        detail: source ? source.detail : '',
      };
    });
  }
}

module.exports = { DonationHub, CATALOG };
