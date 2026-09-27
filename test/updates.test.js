const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkForUpdate, isNewer } = require('../src/main/updates');
const { Controller } = require('../src/main/controller');
const { Store } = require('../src/main/store');
const { createSimulatedKeyboard } = require('../src/main/keyboard');

function github(release, status = 200) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(release), { status });
  };
  return { fetch, calls };
}

const RELEASE = {
  tag_name: 'v0.3.0',
  html_url: 'https://github.com/Asrus21/keybinds-redemptions/releases/tag/v0.3.0',
  draft: false,
  prerelease: false,
};

test('compara versões número a número (0.10.0 é mais nova que 0.9.9)', () => {
  assert.equal(isNewer('0.3.0', '0.2.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('lixo', '0.2.0'), false);
});

test('acha o release mais novo e ignora o que não serve', async () => {
  assert.deepEqual(await checkForUpdate({ currentVersion: '0.2.0', fetch: github(RELEASE).fetch }), {
    version: '0.3.0',
    url: RELEASE.html_url,
  });
  assert.equal(await checkForUpdate({ currentVersion: '0.3.0', fetch: github(RELEASE).fetch }), null);
  assert.equal(await checkForUpdate({ currentVersion: '0.2.0', fetch: github({ ...RELEASE, prerelease: true }).fetch }), null);
  // Link fora do GitHub não vira botão de download.
  assert.equal(
    await checkForUpdate({ currentVersion: '0.2.0', fetch: github({ ...RELEASE, html_url: 'https://evil.example/x' }).fetch }),
    null
  );
  assert.equal(await checkForUpdate({ currentVersion: '0.2.0', fetch: github({}, 404).fetch }), null);
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(await checkForUpdate({ currentVersion: '0.2.0', fetch: offline }), null, 'sem internet não é erro');
});

test('o aviso aparece, "Agora não" esconde esta versão e uma mais nova volta a avisar', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-upd-'));
  let release = RELEASE;
  const fetch = async () => new Response(JSON.stringify(release), { status: 200 });
  const make = () =>
    new Controller({ store: new Store({ dir }), keyboard: createSimulatedKeyboard(), fetch, appVersion: '0.2.0' });

  const ctrl = make();
  t.after(() => ctrl.dispose());
  await ctrl.init();
  await ctrl.checkUpdates();
  assert.deepEqual(ctrl.snapshot().update, { version: '0.3.0', url: RELEASE.html_url });

  ctrl.dismissUpdate();
  assert.equal(ctrl.snapshot().update, null);

  // Dispensa fica salva ao reabrir o app.
  const again = make();
  t.after(() => again.dispose());
  await again.init();
  await again.checkUpdates();
  assert.equal(again.snapshot().update, null);

  release = { ...RELEASE, tag_name: 'v0.4.0', html_url: RELEASE.html_url.replace('0.3.0', '0.4.0') };
  await again.checkUpdates();
  assert.equal(again.snapshot().update.version, '0.4.0');
});
