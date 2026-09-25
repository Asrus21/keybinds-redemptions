const test = require('node:test');
const assert = require('node:assert/strict');

const { ActionRunner } = require('../src/main/runner');
const { createSimulatedKeyboard } = require('../src/main/keyboard');

function action(keys, extra = {}) {
  return { keys, holdMs: 10, repeat: 1, gapMs: 0, ...extra };
}

test('aperta a combinação em ordem e solta ao contrário', async () => {
  const kb = createSimulatedKeyboard();
  const runner = new ActionRunner({ keyboard: kb });
  const result = await runner.enqueue(action(['ControlLeft', 'ShiftLeft', 'KeyG']));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(kb.events, [
    ['down', 'ControlLeft'],
    ['down', 'ShiftLeft'],
    ['down', 'KeyG'],
    ['up', 'KeyG'],
    ['up', 'ShiftLeft'],
    ['up', 'ControlLeft'],
  ]);
});

test('repete com intervalo e segura pelo tempo pedido', async () => {
  const kb = createSimulatedKeyboard();
  const runner = new ActionRunner({ keyboard: kb });
  const t0 = Date.now();
  await runner.enqueue(action(['Space'], { holdMs: 40, repeat: 3, gapMs: 30 }));
  const elapsed = Date.now() - t0;
  assert.equal(kb.events.length, 6);
  assert.ok(elapsed >= 3 * 40 + 2 * 30 - 5, `demorou só ${elapsed} ms`);
});

test('ações rodam uma de cada vez, na ordem em que chegaram', async () => {
  const kb = createSimulatedKeyboard();
  const runner = new ActionRunner({ keyboard: kb });
  await Promise.all([
    runner.enqueue(action(['KeyA'], { holdMs: 30 })),
    runner.enqueue(action(['KeyB'])),
    runner.enqueue(action(['KeyC'])),
  ]);
  assert.deepEqual(kb.events, [
    ['down', 'KeyA'],
    ['up', 'KeyA'],
    ['down', 'KeyB'],
    ['up', 'KeyB'],
    ['down', 'KeyC'],
    ['up', 'KeyC'],
  ]);
});

test('"Parar tudo" solta as teclas presas e descarta a fila', async () => {
  const kb = createSimulatedKeyboard();
  const runner = new ActionRunner({ keyboard: kb });
  const long = runner.enqueue(action(['ShiftLeft', 'KeyW'], { holdMs: 60_000 }));
  const next = runner.enqueue(action(['KeyE']));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runner.pending, 2);

  runner.abortAll();
  assert.deepEqual(await long, { ok: false, aborted: true });
  assert.deepEqual(await next, { ok: false, aborted: true });
  assert.deepEqual(kb.events, [
    ['down', 'ShiftLeft'],
    ['down', 'KeyW'],
    ['up', 'KeyW'],
    ['up', 'ShiftLeft'],
  ]);
  assert.equal(runner.pending, 0);
});

test('se apertar falha no meio, o que já foi apertado é solto', async () => {
  const events = [];
  const keyboard = {
    keyDown(code) {
      if (code === 'KeyG') throw new Error('bloqueado');
      events.push(['down', code]);
    },
    keyUp(code) {
      events.push(['up', code]);
    },
  };
  const runner = new ActionRunner({ keyboard });
  const result = await runner.enqueue(action(['ControlLeft', 'KeyG']));
  assert.deepEqual(result, { ok: false, error: 'bloqueado' });
  assert.deepEqual(events, [
    ['down', 'ControlLeft'],
    ['up', 'ControlLeft'],
  ]);
});

test('fila cheia recusa em vez de acumular sem fim', async () => {
  const kb = createSimulatedKeyboard();
  const runner = new ActionRunner({ keyboard: kb, maxQueue: 2 });
  const first = runner.enqueue(action(['KeyA'], { holdMs: 50 })); // rodando
  const a = runner.enqueue(action(['KeyB']));
  const b = runner.enqueue(action(['KeyC']));
  const c = await runner.enqueue(action(['KeyD']));
  assert.equal(c.ok, false);
  assert.match(c.error, /Fila cheia/);
  await Promise.all([first, a, b]);
});

test('"Parar tudo" solta todas as teclas na mesma hora (o app pode estar fechando)', async () => {
  const kb = createSimulatedKeyboard();
  const runner = new ActionRunner({ keyboard: kb });
  const run = runner.enqueue(action(['ControlLeft', 'ShiftLeft', 'KeyW'], { holdMs: 60_000 }));
  await new Promise((r) => setTimeout(r, 80));
  runner.abortAll();
  // Sem await: tudo tem que estar solto antes de o processo ter chance de sair.
  assert.deepEqual(kb.events.slice(3), [
    ['up', 'KeyW'],
    ['up', 'ShiftLeft'],
    ['up', 'ControlLeft'],
  ]);
  assert.deepEqual(await run, { ok: false, aborted: true });
  assert.equal(kb.events.length, 6, 'nada é solto duas vezes');
});
