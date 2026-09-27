const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  exeList,
  normalizeProfiles,
  profileForExe,
  exportProfile,
  importProfile,
} = require('../src/main/profiles');
const { createForegroundWatcher } = require('../src/main/foreground');
const { Controller } = require('../src/main/controller');
const { Store } = require('../src/main/store');
const { createSimulatedKeyboard } = require('../src/main/keyboard');

function ctrl(t, { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-prof-')), foreground } = {}) {
  const c = new Controller({
    store: new Store({ dir }),
    keyboard: createSimulatedKeyboard(),
    fetch: async () => new Response('{}'),
    foreground,
  });
  t.after(() => c.dispose());
  c.load();
  return c;
}

test('lista de executáveis aceita vírgula, caminho inteiro e falta do .exe', () => {
  assert.deepEqual(exeList('valorant.exe, cs2.exe'), ['valorant.exe', 'cs2.exe']);
  assert.deepEqual(exeList('C:\\Games\\Steam\\CS2.exe'), ['cs2.exe']);
  assert.deepEqual(exeList('valorant'), ['valorant.exe']);
  assert.deepEqual(exeList('a.exe a.exe  b.exe'), ['a.exe', 'b.exe'], 'sem repetir');
  assert.deepEqual(exeList(''), []);
  assert.deepEqual(exeList(null), []);
});

test('config antiga vira o perfil "Padrão" sem perder regras', () => {
  const { profiles, activeProfileId } = normalizeProfiles({ rules: [{ id: 'r1', keys: ['KeyG'] }] });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Padrão');
  assert.equal(profiles[0].rules.length, 1);
  assert.equal(activeProfileId, profiles[0].id);
  // Config zerada também sai com um perfil, senão não haveria onde pôr regra.
  assert.equal(normalizeProfiles({}).profiles.length, 1);
  // activeProfileId apontando para perfil que não existe cai no primeiro.
  const bad = normalizeProfiles({ profiles: [{ id: 'a', name: 'A' }], activeProfileId: 'sumiu' });
  assert.equal(bad.activeProfileId, 'a');
});

test('perfil do programa em foco: casa pelo nome, ignora quem não lista', () => {
  const profiles = [
    { id: 'p1', name: 'Geral', matchExe: '', rules: [] },
    { id: 'p2', name: 'FPS', matchExe: 'valorant.exe, cs2.exe', rules: [] },
  ];
  assert.equal(profileForExe(profiles, 'VALORANT.exe').id, 'p2', 'não diferencia maiúscula');
  assert.equal(profileForExe(profiles, 'C:\\jogos\\cs2.exe').id, 'p2');
  assert.equal(profileForExe(profiles, 'chrome.exe'), null, 'ninguém lista: não troca');
  assert.equal(profileForExe(profiles, ''), null);
});

test('exportar e importar: sem segredo, com ids novos', () => {
  const data = exportProfile({ id: 'p1', name: 'FPS', matchExe: 'cs2.exe', rules: [{ id: 'r1', keys: ['KeyG'] }] });
  assert.equal(data.app, 'keybinds-redemptions');
  assert.equal(JSON.stringify(data).includes('p1'), false, 'o id interno não sai no arquivo');

  const back = importProfile(JSON.parse(JSON.stringify(data)));
  assert.equal(back.name, 'FPS');
  assert.equal(back.matchExe, 'cs2.exe');
  assert.equal(back.rules.length, 1);
  assert.notEqual(back.rules[0].id, 'r1', 'regra ganha id novo');
  assert.notEqual(importProfile(data).id, back.id, 'dois imports não colidem');

  assert.throws(() => importProfile({ rules: [] }), /não é um perfil/);
  assert.throws(() => importProfile({ app: 'keybinds-redemptions', kind: 'profile' }), /não tem regras/);
});

test('trocar de perfil troca as regras que disparam e solta as teclas', async (t) => {
  const c = ctrl(t);
  const padrao = c.profile.id;
  const r = c.addRule();
  c.updateRule(r.id, { trigger: 'bits', min: 1, keys: ['KeyA'], holdMs: 10 });

  const outro = c.addProfile('FPS');
  assert.equal(c.rules.length, 1, 'criar perfil não troca o ativo');
  c.setActiveProfile(outro.id);
  assert.equal(c.rules.length, 0, 'o perfil novo começa vazio');
  assert.equal(c.snapshot().rules.length, 0);

  // A regra do perfil antigo não dispara mais.
  c.dispatch({ kind: 'bits', amount: 50, user: 'X', action: 'mandou', target: '50 bits' });
  assert.equal(c.getLog()[0].outcome, 'ignored');

  c.setActiveProfile(padrao);
  assert.equal(c.rules.length, 1);
  assert.equal(c.snapshot().profiles.length, 2);
  assert.deepEqual(
    c.snapshot().profiles.map((p) => [p.name, p.ruleCount]),
    [['Padrão', 1], ['FPS', 0]]
  );
});

test('perfis sobrevivem ao fechar o app e o último não pode ser apagado', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-prof-'));
  const c = ctrl(t, { dir });
  const fps = c.addProfile('FPS');
  c.setActiveProfile(fps.id);
  c.updateProfile(fps.id, { matchExe: 'cs2.exe' });
  const r = c.addRule();
  c.updateRule(r.id, { keys: ['KeyB'] });

  const again = ctrl(t, { dir });
  assert.equal(again.profile.name, 'FPS', 'o perfil ativo volta igual');
  assert.equal(again.profile.matchExe, 'cs2.exe');
  assert.equal(again.rules.length, 1);

  again.removeProfile(again.config.profiles[0].id);
  assert.equal(again.config.profiles.length, 1);
  assert.throws(() => again.removeProfile(again.profile.id), /pelo menos um perfil/);
});

test('apagar o perfil ativo cai para o que sobrou', (t) => {
  const c = ctrl(t);
  const outro = c.addProfile('FPS');
  c.setActiveProfile(outro.id);
  c.removeProfile(outro.id);
  assert.equal(c.config.profiles.length, 1);
  assert.equal(c.profile.id, c.config.profiles[0].id);
});

test('duplicar copia as regras mas não os programas', (t) => {
  const c = ctrl(t);
  const r = c.addRule();
  c.updateRule(r.id, { keys: ['KeyC'] });
  c.updateProfile(c.profile.id, { matchExe: 'cs2.exe' });
  const copia = c.duplicateProfile(c.profile.id);
  assert.equal(copia.name, 'Padrão (cópia)');
  assert.equal(copia.rules.length, 1);
  assert.notEqual(copia.rules[0].id, r.id);
  assert.equal(copia.matchExe, '', 'dois perfis com o mesmo jogo confundiriam a troca automática');
});

test('troca automática segue o programa em foco e ignora o resto', (t) => {
  let exe = '';
  const fg = createForegroundWatcher({ read: () => exe, pollMs: 10 });
  const c = ctrl(t, { foreground: fg });
  const fps = c.addProfile('FPS');
  c.updateProfile(fps.id, { matchExe: 'cs2.exe' });
  const padrao = c.config.profiles[0].id;

  // Desligada: o foco não muda nada.
  exe = 'cs2.exe';
  fg.tick();
  assert.equal(c.profile.id, padrao);

  c.updateSettings({ autoSwitch: true });
  assert.equal(c.profile.id, fps.id, 'ao ligar, já entra no perfil do que está aberto');

  exe = 'chrome.exe';
  fg.tick();
  assert.equal(c.profile.id, fps.id, 'programa sem perfil não troca nada');
  assert.equal(c.snapshot().autoSwitch.exe, 'chrome.exe');

  exe = '';
  fg.tick();
  assert.equal(c.profile.id, fps.id);

  c.updateSettings({ autoSwitch: false });
  exe = 'cs2.exe';
  fg.tick();
  assert.equal(c.profile.id, fps.id, 'desligada de novo: para de seguir');
});

test('vigia desiste depois de três falhas seguidas, mas não na primeira', () => {
  const logs = [];
  let fail = true;
  const fg = createForegroundWatcher({
    read: () => {
      if (fail) throw new Error('boom');
      return 'ok.exe';
    },
    pollMs: 10,
    log: (m) => logs.push(m),
  });
  assert.equal(fg.supported, true);
  fg.tick();
  fg.tick();
  assert.equal(fg.supported, true, 'duas falhas não derrubam');
  fail = false;
  fg.tick();
  assert.equal(fg.current, 'ok.exe', 'uma leitura boa zera a contagem');
  fail = true;
  fg.tick();
  fg.tick();
  fg.tick();
  assert.equal(fg.supported, false);
  assert.match(logs.join(' '), /desligada depois de falhar/);
});

test('fora do Windows o vigia existe mas nunca dispara', () => {
  const fg = createForegroundWatcher({ platform: 'linux' });
  assert.equal(fg.supported, false);
  fg.on('change', () => assert.fail('não devia disparar'));
  fg.start();
  fg.tick();
  fg.stop();
});

test('perfil importado no controller entra como ativo', (t) => {
  const c = ctrl(t);
  const arquivo = {
    app: 'keybinds-redemptions',
    kind: 'profile',
    version: 1,
    name: 'Do amigo',
    matchExe: 'cs2.exe',
    rules: [{ id: 'x', trigger: 'bits', min: 100, keys: ['KeyB'] }],
  };
  const p = c.importProfile(arquivo);
  assert.equal(c.profile.id, p.id);
  assert.equal(c.rules.length, 1);
  assert.equal(c.rules[0].trigger, 'bits');
  assert.ok(c.getLog().some((e) => /importado com 1 regras/.test(e.text || '')));
});

test('o vigia emite só quando o programa muda', () => {
  let exe = 'a.exe';
  const seen = [];
  const fg = createForegroundWatcher({ read: () => exe, pollMs: 10 });
  fg.on('change', (e) => seen.push(e));
  fg.tick();
  fg.tick();
  exe = 'b.exe';
  fg.tick();
  assert.deepEqual(seen, ['a.exe', 'b.exe']);
  assert.ok(fg instanceof EventEmitter);
});
