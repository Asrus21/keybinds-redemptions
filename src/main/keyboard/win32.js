// Aperta teclas de verdade no Windows, pela SendInput da user32.dll.
//
// É a mesma API que teclado virtual, AutoHotkey e afins usam: o evento entra
// na fila de entrada do sistema como se viesse do teclado, e vai para a janela
// que estiver em foco (o jogo, normalmente).
//
// Duas pegadinhas que valem saber:
//   - Se o jogo roda como administrador e o app não, o Windows descarta o
//     evento (UIPI) e a SendInput devolve 0. Rodar o app como administrador
//     resolve.
//   - Alguns anticheats ignoram entrada sintética de propósito. Aí não tem o
//     que fazer daqui.

const { KEYS } = require('../../shared/keys');

const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

/**
 * Monta os campos do KEYBDINPUT para uma tecla da tabela. Separado da FFI
 * para dar para testar em qualquer sistema.
 */
function keyboardEventFields(code, up) {
  const key = KEYS[code];
  if (!key) throw new Error(`Tecla desconhecida: ${code}`);

  let flags = up ? KEYEVENTF_KEYUP : 0;
  if (key.ext) flags |= KEYEVENTF_EXTENDEDKEY;

  if (key.vk) {
    // Teclas de mídia: vão como tecla virtual, que é o que o Windows espera.
    return { wVk: key.vk, wScan: key.scan, dwFlags: flags };
  }
  // O resto vai só como scancode: o Windows deduz a tecla virtual pelo layout
  // ativo, e jogo que lê scancode também recebe.
  return { wVk: 0, wScan: key.scan, dwFlags: flags | KEYEVENTF_SCANCODE };
}

let types = null;

// Os tipos do koffi ficam num registro global por nome; declarar duas vezes
// dá erro, então declaramos uma só.
function win32Types(koffi) {
  if (types) return types;
  // int32_t/uint32_t explícitos (e não long/DWORD) para o layout ser o mesmo
  // do Windows em qualquer lugar — é o que deixa o teste rodar no Linux.
  const MOUSEINPUT = koffi.struct('KR_MOUSEINPUT', {
    dx: 'int32_t',
    dy: 'int32_t',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KR_KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('KR_HARDWAREINPUT', {
    uMsg: 'uint32_t',
    wParamL: 'uint16_t',
    wParamH: 'uint16_t',
  });
  const INPUT = koffi.struct('KR_INPUT', {
    type: 'uint32_t',
    u: koffi.union('KR_INPUT_UNION', {
      mi: MOUSEINPUT,
      ki: KEYBDINPUT,
      hi: HARDWAREINPUT,
    }),
  });
  types = { INPUT };
  return types;
}

/**
 * @param {{ libraryPath?: string, koffi?: any }} [opts]
 *   libraryPath só muda nos testes, que carregam uma user32 de mentira.
 */
function createWin32Keyboard(opts = {}) {
  const koffi = opts.koffi || require('koffi');
  const lib = koffi.load(opts.libraryPath || 'user32.dll');
  const { INPUT } = win32Types(koffi);
  const SendInput = lib.func(
    'unsigned int __stdcall SendInput(unsigned int cInputs, KR_INPUT *pInputs, int cbSize)'
  );
  const inputSize = koffi.sizeof(INPUT);

  function send(code, up) {
    const input = {
      type: INPUT_KEYBOARD,
      u: { ki: { ...keyboardEventFields(code, up), time: 0, dwExtraInfo: 0 } },
    };
    const sent = SendInput(1, [input], inputSize);
    if (sent !== 1) {
      throw new Error(
        'O Windows bloqueou a tecla. Se o jogo roda como administrador, abra este app como administrador também.'
      );
    }
  }

  return {
    name: 'Windows (SendInput)',
    simulated: false,
    keyDown: (code) => send(code, false),
    keyUp: (code) => send(code, true),
  };
}

module.exports = {
  createWin32Keyboard,
  keyboardEventFields,
  win32Types,
  INPUT_KEYBOARD,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
};
