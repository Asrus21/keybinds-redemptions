// Fila que executa as ações das regras, uma de cada vez.
//
// Uma ação é uma sequência de passos: apertar uma combinação, abrir um
// arquivo/programa ou abrir um link, cada um com o seu tempo de espera
// depois. A sequência inteira pode repetir.
//
// Em fila (e não tudo junto) porque dois resgates seguidos de "segura W por 3 s"
// se atropelariam: o segundo soltaria o W do primeiro no meio. Assim cada
// resgate recebe a sua vez inteira.
//
// Toda tecla apertada é solta no fim da ação, mesmo se algo falhar, e o
// "Parar tudo" (que também roda quando o app fecha) solta tudo na hora — tecla
// presa no jogo é o pior defeito que este app pode ter.

const { EventEmitter } = require('node:events');

// Pausa entre apertar/soltar cada tecla de uma combinação. Alguns jogos perdem
// o Ctrl se o G chega no mesmo instante.
const COMBO_STEP_MS = 15;

class AbortedError extends Error {
  constructor() {
    super('Interrompido');
    this.name = 'AbortedError';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class ActionRunner extends EventEmitter {
  /**
   * @param {{ keyboard: { keyDown(code: string): void, keyUp(code: string): void }, maxQueue?: number }} opts
   */
  /**
   * @param {{ keyboard: object, effects?: { open(t: string): void, url(t: string): void }, maxQueue?: number }} opts
   *   `effects` é quem abre arquivo e link (o processo principal); sem ele,
   *   esses passos só avisam, o que é o caso dos testes.
   */
  constructor({ keyboard, effects, maxQueue = 50 }) {
    super();
    this.keyboard = keyboard;
    this.effects = effects || {
      open: (t) => this.emit('log', `[simulação] abriria ${t}`),
      url: (t) => this.emit('log', `[simulação] abriria o link ${t}`),
    };
    this.maxQueue = maxQueue;
    this.queue = [];
    this.running = null; // { controller }
    this.down = []; // teclas apertadas agora, na ordem em que desceram
  }

  /** Quantas ações faltam, contando a que está rodando. */
  get pending() {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /**
   * Põe uma ação na fila. A promessa resolve quando ela termina:
   * `{ ok: true }`, `{ ok: false, aborted: true }` ou `{ ok: false, error }`.
   */
  enqueue(action) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.resolve({ ok: false, error: 'Fila cheia — resgate ignorado.' });
    }
    return new Promise((resolve) => {
      this.queue.push({ action, resolve });
      this.emit('change', this.pending);
      this.pump();
    });
  }

  /**
   * Esvazia a fila, interrompe o que estiver rodando e solta as teclas na
   * hora — sem esperar nada, porque isso também roda quando o app está
   * fechando e o processo pode acabar logo em seguida.
   */
  abortAll() {
    const dropped = this.queue.splice(0);
    for (const item of dropped) item.resolve({ ok: false, aborted: true });
    const interrupted = this.running ? 1 : 0;
    if (this.running) this.running.controller.abort();
    this.releaseAll();
    this.emit('change', this.pending);
    return dropped.length + interrupted;
  }

  /** Solta, em ordem inversa e sem pausa, tudo que estiver apertado. */
  releaseAll() {
    let failure = null;
    while (this.down.length) {
      try {
        this.keyboard.keyUp(this.down.pop());
      } catch (err) {
        failure = failure || err;
      }
    }
    return failure;
  }

  async pump() {
    if (this.running || this.queue.length === 0) return;
    const { action, resolve } = this.queue.shift();
    const controller = new AbortController();
    this.running = { controller };
    let result;
    try {
      await this.perform(action, controller.signal);
      result = { ok: true };
    } catch (err) {
      result = err instanceof AbortedError
        ? { ok: false, aborted: true }
        : { ok: false, error: err.message || String(err) };
    }
    this.running = null;
    this.emit('change', this.pending);
    resolve(result);
    this.pump();
  }

  async perform({ steps, repeat }, signal) {
    for (let round = 0; round < repeat; round++) {
      for (const [i, step] of steps.entries()) {
        await this.runStep(step, signal);
        // A espera do último passo da última volta só atrasaria a fila.
        const last = round === repeat - 1 && i === steps.length - 1;
        if (!last && step.gapMs > 0) await sleep(step.gapMs, signal);
      }
    }
  }

  async runStep(step, signal) {
    if (step.kind === 'keys') return this.pressCombo(step.keys, step.holdMs, signal);
    // Abrir arquivo ou link não é interrompível nem demora: dispara e segue.
    if (step.kind === 'open') return this.effects.open(step.text);
    if (step.kind === 'url') return this.effects.url(step.text);
    return undefined;
  }

  async pressCombo(keys, holdMs, signal) {
    let failure = null;
    try {
      for (const [i, code] of keys.entries()) {
        if (i > 0) await sleep(COMBO_STEP_MS, signal);
        this.keyboard.keyDown(code);
        this.down.push(code);
      }
      await sleep(holdMs, signal);
    } catch (err) {
      failure = err;
    }
    // Solta na ordem inversa (G antes do Ctrl), mesmo se algo deu errado. Se
    // o "Parar tudo" chegar no meio, ele solta o resto na hora.
    while (this.down.length) {
      try {
        this.keyboard.keyUp(this.down.pop());
      } catch (err) {
        failure = failure || err;
      }
      if (this.down.length && !signal.aborted) await new Promise((r) => setTimeout(r, COMBO_STEP_MS));
    }
    if (failure) throw failure;
  }
}

module.exports = { ActionRunner, AbortedError, COMBO_STEP_MS };
