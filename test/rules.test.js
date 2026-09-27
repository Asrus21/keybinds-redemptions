const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRule, patchRule, matchRules, describeTrigger, isRunnable } = require('../src/main/rules');

function rule(fields) {
  return normalizeRule({ keys: ['KeyG'], ...fields });
}

test('regra antiga (sem gatilho) continua sendo de recompensa', () => {
  const r = normalizeRule({ id: 'x', rewardId: 'abc', keys: ['Space'] });
  assert.equal(r.trigger, 'reward');
  assert.equal(r.rewardId, 'abc');
});

test('faixa de valor: vírgula brasileira, centavos, máximo menor que o mínimo', () => {
  const d = rule({ trigger: 'donation', min: '10,5', max: '5' });
  assert.equal(d.min, 10.5);
  assert.equal(d.max, 10.5, 'máximo abaixo do mínimo sobe para o mínimo');
  assert.equal(rule({ trigger: 'donation', min: 1.239 }).min, 1.24);
  assert.equal(rule({ trigger: 'bits', min: 99.6 }).min, 100, 'bits é inteiro');
  assert.equal(rule({ trigger: 'bits', min: -5 }).min, 1);
  assert.equal(rule({ trigger: 'donation', max: '' }).max, 0, 'vazio = sem limite');
  assert.equal(rule({ trigger: 'nada' }).trigger, 'reward');
  assert.equal(rule({ trigger: 'sub', tier: '9000' }).tier, 'any');
  assert.equal(rule({ trigger: 'donation', source: 'paypal' }).source, 'any');
});

test('trocar o tipo de gatilho volta a faixa para o padrão do novo tipo', () => {
  const bits = rule({ trigger: 'bits', min: 500, max: 1000 });
  const donation = patchRule(bits, { trigger: 'donation' });
  assert.equal(donation.min, 5);
  assert.equal(donation.max, 0);
  // Mudando tipo e valor juntos, vale o valor pedido.
  assert.equal(patchRule(bits, { trigger: 'gift', min: 3 }).min, 3);
});

test('faixas de valor: vale só a de maior "a partir de" que servir', () => {
  const rules = [
    rule({ id: 'd5', trigger: 'donation', min: 5 }),
    rule({ id: 'd10', trigger: 'donation', min: 10 }),
    rule({ id: 'd10b', trigger: 'donation', min: 10, keys: ['KeyH'] }),
    rule({ id: 'd50', trigger: 'donation', min: 50, max: 99.99 }),
    rule({ id: 'bits', trigger: 'bits', min: 1 }),
  ];
  const ids = (ev) => matchRules(rules, ev).map((r) => r.id);
  assert.deepEqual(ids({ kind: 'donation', amount: 4.99, source: 'livepix' }), []);
  assert.deepEqual(ids({ kind: 'donation', amount: 5, source: 'livepix' }), ['d5']);
  assert.deepEqual(ids({ kind: 'donation', amount: 12, source: 'livepix' }), ['d10', 'd10b'], 'mesma faixa: as duas');
  assert.deepEqual(ids({ kind: 'donation', amount: 60, source: 'livepix' }), ['d50']);
  assert.deepEqual(ids({ kind: 'donation', amount: 100, source: 'livepix' }), ['d10', 'd10b'], 'acima do máximo cai na faixa de baixo');
  assert.deepEqual(ids({ kind: 'bits', amount: 1 }), ['bits']);
});

test('doação filtra pelo serviço; sub filtra pelo tier; recompensa pelo id', () => {
  const rules = [
    rule({ id: 'se', trigger: 'donation', min: 1, source: 'streamelements' }),
    rule({ id: 'any', trigger: 'donation', min: 1 }),
    rule({ id: 't1', trigger: 'sub', tier: '1000' }),
    rule({ id: 'tany', trigger: 'sub' }),
    rule({ id: 'rw', trigger: 'reward', rewardId: 'r1' }),
    rule({ id: 'off', trigger: 'reward', rewardId: 'r1', enabled: false }),
    rule({ id: 'nokey', trigger: 'reward', rewardId: 'r1', keys: [] }),
  ];
  const ids = (ev) => matchRules(rules, ev).map((r) => r.id);
  assert.deepEqual(ids({ kind: 'donation', amount: 5, source: 'streamelements' }), ['se', 'any']);
  assert.deepEqual(ids({ kind: 'donation', amount: 5, source: 'streamlabs' }), ['any']);
  assert.deepEqual(ids({ kind: 'sub', tier: '1000' }), ['t1', 'tany']);
  assert.deepEqual(ids({ kind: 'sub', tier: '3000' }), ['tany']);
  assert.deepEqual(ids({ kind: 'reward', rewardId: 'r1' }), ['rw']);
  assert.deepEqual(ids({ kind: 'reward', rewardId: 'r2' }), []);
  assert.deepEqual(ids({ kind: 'gift', amount: 5 }), []);
});

test('descrição curta do gatilho (vai para o registro do "Testar")', () => {
  assert.equal(describeTrigger(rule({ trigger: 'bits', min: 1000 })), 'Bits: 1.000 bits ou mais');
  assert.equal(describeTrigger(rule({ trigger: 'gift', min: 5, max: 10 })), 'Gift sub: 5 a 10 subs');
  assert.equal(describeTrigger(rule({ trigger: 'sub', tier: '2000' })), 'Sub (Tier 2)');
  assert.match(describeTrigger(rule({ trigger: 'donation', min: 10 })), /^Doação: 10,00 ou mais \(qualquer serviço\)$/);
  assert.equal(describeTrigger(rule({ trigger: 'reward', rewardTitle: 'Pular' })), 'Pular');
});

test('comando do chat: primeira palavra, sem maiúscula e com nível mínimo', () => {
  const mk = (o) => normalizeRule({ enabled: true, keys: ['KeyG'], trigger: 'command', ...o });
  // O campo guarda só a primeira palavra, em minúsculas.
  assert.equal(mk({ command: '  !SOM  alto ' }).command, '!som');
  assert.equal(mk({ command: '' }).command, '');
  assert.equal(mk({}).who, 'all', 'padrão é todo mundo');
  assert.equal(mk({ who: 'inventado' }).who, 'all');

  // Sem comando a regra não roda, mesmo com tecla escolhida.
  assert.equal(isRunnable(mk({ command: '' })), false);
  assert.equal(isRunnable(mk({ command: '!som' })), true);

  const rules = [mk({ command: '!som', who: 'all' }), mk({ command: '!clip', who: 'mod' })];
  const hit = (command, level) => matchRules(rules, { kind: 'command', command, level }).map((r) => r.command);
  assert.deepEqual(hit('!som', 0), ['!som']);
  assert.deepEqual(hit('!clip', 0), [], 'viewer não usa comando de mod');
  assert.deepEqual(hit('!clip', 2), [], 'VIP ainda não é mod');
  assert.deepEqual(hit('!clip', 3), ['!clip']);
  assert.deepEqual(hit('!outro', 3), []);

  // A escada: quem está acima também pode.
  const soSub = [mk({ command: '!x', who: 'sub' })];
  assert.equal(matchRules(soSub, { kind: 'command', command: '!x', level: 0 }).length, 0);
  for (const level of [1, 2, 3]) {
    assert.equal(matchRules(soSub, { kind: 'command', command: '!x', level }).length, 1, `nível ${level}`);
  }
});

test('trocar para comando e voltar não deixa lixo na faixa', () => {
  const bits = normalizeRule({ trigger: 'bits', min: 500, keys: ['KeyG'] });
  const cmd = patchRule(bits, { trigger: 'command' });
  assert.equal(cmd.min, 0, 'faixa de bits não vale para comando');
  const back = patchRule(cmd, { trigger: 'bits' });
  assert.equal(back.min, 100, 'volta para o padrão de bits');
});

test('sequência de passos: migração do formato antigo e limpeza', () => {
  // Regra salva antes dos passos existirem: a tecla vira um passo só.
  const velha = normalizeRule({ keys: ['ControlLeft', 'KeyG'], holdMs: 80, gapMs: 250, repeat: 3 });
  assert.deepEqual(velha.steps, [
    { kind: 'keys', keys: ['ControlLeft', 'KeyG'], text: '', holdMs: 80, gapMs: 250 },
  ]);
  assert.equal(velha.repeat, 3);
  assert.equal(normalizeRule({ keys: [] }).steps.length, 0, 'regra nova nasce sem passo');

  // Passo sem tecla (ou sem caminho) não faz nada: sai da lista.
  const limpa = normalizeRule({
    steps: [
      { kind: 'keys', keys: ['KeyA'] },
      { kind: 'keys', keys: [] },
      { kind: 'url', text: '' },
      { kind: 'open', text: 'C:\\x.bat' },
      { kind: 'inventado', keys: ['KeyB'] },
    ],
  });
  assert.deepEqual(limpa.steps.map((s) => s.kind), ['keys', 'open', 'keys']);
  assert.equal(limpa.steps[1].keys.length, 0, 'passo de abrir não guarda tecla');
  assert.equal(limpa.steps[0].text, '', 'passo de tecla não guarda texto');

  // Sem passo nenhum a regra não roda; com um passo de link, roda.
  assert.equal(isRunnable(normalizeRule({ enabled: true, trigger: 'sub', steps: [] })), false);
  assert.equal(
    isRunnable(normalizeRule({ enabled: true, trigger: 'sub', steps: [{ kind: 'url', text: 'https://x' }] })),
    true,
    'uma regra pode só abrir um link, sem tecla nenhuma'
  );
});

test('atalho `keys` no patch vale para um passo, mas não apaga uma sequência', () => {
  const uma = normalizeRule({ keys: ['KeyA'], holdMs: 30 });
  const trocada = patchRule(uma, { keys: ['KeyB'] });
  assert.deepEqual(trocada.steps.map((s) => s.keys), [['KeyB']]);
  assert.equal(trocada.steps[0].holdMs, 30, 'o tempo do passo continua');

  const sequencia = normalizeRule({
    steps: [{ kind: 'keys', keys: ['KeyA'] }, { kind: 'keys', keys: ['KeyB'] }],
  });
  const tentativa = patchRule(sequencia, { holdMs: 999 });
  assert.equal(tentativa.steps.length, 2, 'um "segurar" solto não colapsa a sequência');
  const explicita = patchRule(sequencia, { steps: [{ kind: 'keys', keys: ['KeyC'] }] });
  assert.equal(explicita.steps.length, 1, 'mandando steps, troca de verdade');
});

test('a regra guarda no máximo 20 passos', () => {
  const muitos = Array.from({ length: 30 }, () => ({ kind: 'keys', keys: ['KeyA'] }));
  assert.equal(normalizeRule({ steps: muitos }).steps.length, 20);
});
