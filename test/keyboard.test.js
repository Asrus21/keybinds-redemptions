const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KEYS, normalizeCombo, describeCombo } = require('../src/shared/keys');
const {
  keyboardEventFields,
  createWin32Keyboard,
  win32Types,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
} = require('../src/main/keyboard/win32');

test('scancodes das teclas mais usadas batem com a tabela da Microsoft', () => {
  assert.equal(KEYS.KeyW.scan, 0x11);
  assert.equal(KEYS.KeyA.scan, 0x1e);
  assert.equal(KEYS.Space.scan, 0x39);
  assert.equal(KEYS.Digit1.scan, 0x02);
  assert.equal(KEYS.Digit0.scan, 0x0b);
  assert.equal(KEYS.F1.scan, 0x3b);
  assert.equal(KEYS.F10.scan, 0x44);
  assert.equal(KEYS.F13.scan, 0x64);
  assert.equal(KEYS.F23.scan, 0x6e);
  assert.equal(KEYS.F24.scan, 0x76);
  assert.equal(KEYS.Numpad7.scan, 0x47);
  assert.equal(KEYS.Numpad0.scan, 0x52);
  assert.equal(KEYS.ArrowUp.scan, 0x48);
  assert.equal(KEYS.ArrowUp.ext, true);
  assert.equal(KEYS.Numpad8.ext, undefined);
});

test('nenhum par (scancode, E0) se repete — senão duas teclas seriam a mesma', () => {
  const seen = new Map();
  for (const [code, k] of Object.entries(KEYS)) {
    const id = `${k.ext ? 'e0' : ''}${k.scan}`;
    assert.ok(!seen.has(id), `${code} e ${seen.get(id)} têm o mesmo scancode`);
    seen.set(id, code);
  }
});

test('normalizeCombo põe modificadores primeiro, tira repetidas e desconhecidas', () => {
  assert.deepEqual(normalizeCombo(['KeyG', 'ShiftLeft', 'ControlLeft', 'KeyG', 'Nope']), [
    'ControlLeft',
    'ShiftLeft',
    'KeyG',
  ]);
  assert.deepEqual(normalizeCombo(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE']).length, 4);
  assert.deepEqual(normalizeCombo('KeyA'), []);
  assert.equal(describeCombo(['KeyG', 'ControlLeft']), 'Ctrl + G');
  assert.equal(describeCombo([]), '—');
});

test('campos do KEYBDINPUT: scancode, E0 e teclas de mídia', () => {
  assert.deepEqual(keyboardEventFields('KeyW', false), {
    wVk: 0,
    wScan: 0x11,
    dwFlags: KEYEVENTF_SCANCODE,
  });
  assert.deepEqual(keyboardEventFields('KeyW', true), {
    wVk: 0,
    wScan: 0x11,
    dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
  });
  assert.deepEqual(keyboardEventFields('ArrowLeft', false), {
    wVk: 0,
    wScan: 0x4b,
    dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY,
  });
  assert.deepEqual(keyboardEventFields('MediaPlayPause', true), {
    wVk: 0xb3,
    wScan: 0x22,
    dwFlags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP,
  });
  assert.throws(() => keyboardEventFields('Nope', false), /desconhecida/);
});

// Compila uma user32 de mentira e chama a SendInput pelo koffi de verdade:
// confere que o struct INPUT chega do lado C com o layout do Windows.
const canCompile = process.platform === 'linux' && process.arch === 'x64' && hasGcc();

function hasGcc() {
  try {
    execFileSync('gcc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('SendInput recebe o INPUT com o layout do Windows x64', { skip: !canCompile && 'precisa de gcc no Linux x64' }, () => {
  const koffi = require('koffi');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-user32-'));
  const so = path.join(dir, 'fake-user32.so');
  execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', so, path.join(__dirname, 'fixtures', 'fake-user32.c')]);

  const kb = createWin32Keyboard({ libraryPath: so });
  const fake = koffi.load(so);
  const count = fake.func('int FakeCount(void)');
  const cb = fake.func('int FakeLastCbSize(void)');
  const expected = fake.func('int FakeExpectedSize(void)');
  const type = fake.func('uint32_t FakeType(int)');
  const vk = fake.func('uint32_t FakeVk(int)');
  const scan = fake.func('uint32_t FakeScan(int)');
  const flags = fake.func('uint32_t FakeFlags(int)');
  const setFail = fake.func('void FakeSetFail(int)');

  kb.keyDown('ControlLeft');
  kb.keyDown('ArrowUp');
  kb.keyUp('ArrowUp');
  kb.keyUp('MediaPlayPause');

  assert.equal(expected(), 40, 'sizeof(INPUT) no x64 é 40');
  assert.equal(cb(), expected(), 'cbSize passado bate com o sizeof do C');
  assert.equal(count(), 4);
  for (let i = 0; i < 4; i++) assert.equal(type(i), 1, 'INPUT_KEYBOARD');

  assert.deepEqual([vk(0), scan(0), flags(0)], [0, 0x1d, KEYEVENTF_SCANCODE]);
  assert.deepEqual([vk(1), scan(1), flags(1)], [0, 0x48, KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY]);
  assert.deepEqual(
    [vk(2), scan(2), flags(2)],
    [0, 0x48, KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP]
  );
  assert.deepEqual([vk(3), scan(3), flags(3)], [0xb3, 0x22, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP]);

  // SendInput devolvendo 0 (UIPI) vira erro legível.
  setFail(1);
  assert.throws(() => kb.keyDown('KeyA'), /administrador/);
});

// No Windows (CI): carrega a user32.dll de verdade e confere que o INPUT do
// koffi tem o tamanho que a SendInput exige — se não bater, ela recusa tudo.
test('no Windows, a user32 carrega e o INPUT tem o tamanho do winuser.h', { skip: process.platform !== 'win32' && 'só no Windows' }, () => {
  const koffi = require('koffi');
  const kb = createWin32Keyboard();
  assert.equal(kb.simulated, false);
  const expected = { x64: 40, arm64: 40, ia32: 28 }[process.arch];
  assert.equal(koffi.sizeof(win32Types(koffi).INPUT), expected);
});
