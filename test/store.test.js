const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');

test('backup: guarda o conteúdo antigo, dedupe e rodízio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-bk-'));
  const store = new Store({ dir });
  store.saveConfig({ clientId: 'a', rules: [] });
  assert.equal(store.listBackups().length, 0, 'primeira gravação não tem o que copiar');
  store.saveConfig({ clientId: 'b', rules: [] });
  assert.equal(store.listBackups().length, 1);
  assert.match(fs.readFileSync(store.listBackups()[0].file, 'utf8'), /"clientId": "a"/);
  // Gravação logo em seguida não cria outra cópia (janela de 5 min).
  store.saveConfig({ clientId: 'c', rules: [] });
  assert.equal(store.listBackups().length, 1);
});

test('config ilegível volta da cópia mais nova', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-bk-'));
  const store = new Store({ dir, log: () => {} });
  store.saveConfig({ clientId: 'bom', rules: [{ id: 'r1' }] });
  store.saveConfig({ clientId: 'bom2', rules: [{ id: 'r1' }] }); // gera a cópia
  fs.writeFileSync(store.configFile, '{quebrado');
  const back = new Store({ dir, log: () => {} });
  const cfg = back.loadConfig();
  assert.equal(cfg.clientId, 'bom');
  assert.equal(cfg.rules.length, 1);
  assert.ok(back.restoredFrom);
  assert.ok(fs.existsSync(`${store.configFile}.corrompido`));
});

test('config apagado volta da cópia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-bk-'));
  const store = new Store({ dir, log: () => {} });
  store.saveConfig({ clientId: 'x', rules: [] });
  store.saveConfig({ clientId: 'y', rules: [] });
  fs.rmSync(store.configFile);
  const cfg = new Store({ dir, log: () => {} }).loadConfig();
  assert.equal(cfg.clientId, 'x');
});

test('primeira abertura não inventa erro nem cópia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-bk-'));
  const store = new Store({ dir, log: () => { throw new Error('não devia logar'); } });
  assert.equal(store.loadConfig().clientId, '');
  assert.equal(store.restoredFrom, undefined);
});
