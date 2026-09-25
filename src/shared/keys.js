// Tabela das teclas que o app sabe apertar.
//
// A chave de cada entrada é o `KeyboardEvent.code` do navegador — o nome da
// posição FÍSICA da tecla ("KeyW" é a tecla do W no QWERTY, seja qual for o
// layout). É isso que a tela grava quando o streamer aperta a tecla, e é o que
// fica salvo na regra.
//
// Na hora de apertar, usamos o scancode (Set 1) da mesma posição física. Jogo
// que lê DirectInput/Raw Input só enxerga scancode — tecla virtual (VK) sozinha
// passa batido em muitos deles. Os valores seguem a "Keyboard Scan Code
// Specification" da Microsoft, que é a mesma tabela da spec UI Events.
//
//   scan — scancode
//   ext  — prefixo E0 (vira KEYEVENTF_EXTENDEDKEY). Sem ele, a seta para cima
//          vira o 8 do teclado numérico, por exemplo.
//   vk   — só nas teclas de mídia: essas o Windows trata melhor como VK.
//
// O mesmo arquivo roda no processo principal (require) e na tela (<script>),
// daí o embrulho abaixo: na tela ele vira `window.KeyTable`.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeyTable = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const GROUPS = [
    ['letters', 'Letras'],
    ['digits', 'Números'],
    ['function', 'F1 a F24'],
    ['modifiers', 'Modificadores'],
    ['editing', 'Edição e espaço'],
    ['navigation', 'Navegação'],
    ['symbols', 'Símbolos'],
    ['numpad', 'Teclado numérico'],
    ['media', 'Mídia e volume'],
  ];

  /** @type {Record<string, {label: string, group: string, scan: number, ext?: boolean, vk?: number}>} */
  const KEYS = {};

  function add(group, code, label, scan, extra = {}) {
    KEYS[code] = { label, group, scan, ...extra };
  }

  // Letras
  const LETTER_SCANS = {
    A: 0x1e, B: 0x30, C: 0x2e, D: 0x20, E: 0x12, F: 0x21, G: 0x22, H: 0x23,
    I: 0x17, J: 0x24, K: 0x25, L: 0x26, M: 0x32, N: 0x31, O: 0x18, P: 0x19,
    Q: 0x10, R: 0x13, S: 0x1f, T: 0x14, U: 0x16, V: 0x2f, W: 0x11, X: 0x2d,
    Y: 0x15, Z: 0x2c,
  };
  for (const [letter, scan] of Object.entries(LETTER_SCANS)) {
    add('letters', `Key${letter}`, letter, scan);
  }

  // Fileira de números (1 = 0x02 … 9 = 0x0A, 0 = 0x0B)
  for (let d = 1; d <= 9; d++) add('digits', `Digit${d}`, String(d), 0x01 + d);
  add('digits', 'Digit0', '0', 0x0b);

  // F1–F10 são contínuas; F11/F12 e F13–F24 não. F13–F24 não existem no teclado
  // comum — ótimas para atalho do OBS, porque nada mais usa.
  for (let f = 1; f <= 10; f++) add('function', `F${f}`, `F${f}`, 0x3a + f);
  add('function', 'F11', 'F11', 0x57);
  add('function', 'F12', 'F12', 0x58);
  for (let f = 13; f <= 23; f++) add('function', `F${f}`, `F${f}`, 0x64 + (f - 13));
  add('function', 'F24', 'F24', 0x76);

  // Modificadores
  add('modifiers', 'ControlLeft', 'Ctrl', 0x1d);
  add('modifiers', 'ControlRight', 'Ctrl dir.', 0x1d, { ext: true });
  add('modifiers', 'ShiftLeft', 'Shift', 0x2a);
  add('modifiers', 'ShiftRight', 'Shift dir.', 0x36);
  add('modifiers', 'AltLeft', 'Alt', 0x38);
  add('modifiers', 'AltRight', 'AltGr', 0x38, { ext: true });
  add('modifiers', 'MetaLeft', 'Win', 0x5b, { ext: true });
  add('modifiers', 'MetaRight', 'Win dir.', 0x5c, { ext: true });

  // Edição e espaço
  add('editing', 'Space', 'Espaço', 0x39);
  add('editing', 'Enter', 'Enter', 0x1c);
  add('editing', 'Tab', 'Tab', 0x0f);
  add('editing', 'Backspace', 'Backspace', 0x0e);
  add('editing', 'Escape', 'Esc', 0x01);
  add('editing', 'CapsLock', 'Caps Lock', 0x3a);
  add('editing', 'ContextMenu', 'Menu', 0x5d, { ext: true });
  add('editing', 'PrintScreen', 'Print Screen', 0x37, { ext: true });
  add('editing', 'ScrollLock', 'Scroll Lock', 0x46);

  // Navegação
  add('navigation', 'ArrowUp', '↑', 0x48, { ext: true });
  add('navigation', 'ArrowDown', '↓', 0x50, { ext: true });
  add('navigation', 'ArrowLeft', '←', 0x4b, { ext: true });
  add('navigation', 'ArrowRight', '→', 0x4d, { ext: true });
  add('navigation', 'Insert', 'Insert', 0x52, { ext: true });
  add('navigation', 'Delete', 'Delete', 0x53, { ext: true });
  add('navigation', 'Home', 'Home', 0x47, { ext: true });
  add('navigation', 'End', 'End', 0x4f, { ext: true });
  add('navigation', 'PageUp', 'Page Up', 0x49, { ext: true });
  add('navigation', 'PageDown', 'Page Down', 0x51, { ext: true });

  // Símbolos — o rótulo é o do ABNT2, o teclado mais comum por aqui. O que vale
  // é a posição física; num teclado americano a mesma tecla tem outro desenho.
  add('symbols', 'Backquote', "' \"", 0x29);
  add('symbols', 'Minus', '- _', 0x0c);
  add('symbols', 'Equal', '= +', 0x0d);
  add('symbols', 'BracketLeft', '´ `', 0x1a);
  add('symbols', 'BracketRight', '[ {', 0x1b);
  add('symbols', 'Backslash', '] }', 0x2b);
  add('symbols', 'Semicolon', 'Ç', 0x27);
  add('symbols', 'Quote', '~ ^', 0x28);
  add('symbols', 'Comma', ', <', 0x33);
  add('symbols', 'Period', '. >', 0x34);
  add('symbols', 'Slash', '; :', 0x35);
  add('symbols', 'IntlBackslash', '\\ |', 0x56);
  add('symbols', 'IntlRo', '/ ?', 0x73);

  // Teclado numérico
  const NUMPAD_SCANS = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49];
  NUMPAD_SCANS.forEach((scan, n) => add('numpad', `Numpad${n}`, `Num ${n}`, scan));
  add('numpad', 'NumpadAdd', 'Num +', 0x4e);
  add('numpad', 'NumpadSubtract', 'Num -', 0x4a);
  add('numpad', 'NumpadMultiply', 'Num *', 0x37);
  add('numpad', 'NumpadDivide', 'Num /', 0x35, { ext: true });
  add('numpad', 'NumpadDecimal', 'Num ,', 0x53);
  add('numpad', 'NumpadComma', 'Num .', 0x7e);
  add('numpad', 'NumpadEnter', 'Num Enter', 0x1c, { ext: true });

  // Mídia
  add('media', 'MediaPlayPause', 'Play/Pause', 0x22, { ext: true, vk: 0xb3 });
  add('media', 'MediaStop', 'Parar mídia', 0x24, { ext: true, vk: 0xb2 });
  add('media', 'MediaTrackNext', 'Próxima faixa', 0x19, { ext: true, vk: 0xb0 });
  add('media', 'MediaTrackPrevious', 'Faixa anterior', 0x10, { ext: true, vk: 0xb1 });
  add('media', 'AudioVolumeMute', 'Mudo', 0x20, { ext: true, vk: 0xad });
  add('media', 'AudioVolumeDown', 'Volume -', 0x2e, { ext: true, vk: 0xae });
  add('media', 'AudioVolumeUp', 'Volume +', 0x30, { ext: true, vk: 0xaf });

  const MODIFIER_ORDER = [
    'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  ];

  /** Uma combinação tem no máximo isso de teclas (Ctrl+Shift+Alt+X já é muito). */
  const MAX_COMBO = 4;

  function isKnownKey(code) {
    return Object.prototype.hasOwnProperty.call(KEYS, code);
  }

  function isModifier(code) {
    return MODIFIER_ORDER.includes(code);
  }

  /**
   * Deixa a combinação no formato canônico: só teclas conhecidas, sem repetição,
   * modificadores primeiro (Ctrl, Shift, Alt, Win) e no máximo MAX_COMBO teclas.
   */
  function normalizeCombo(codes) {
    if (!Array.isArray(codes)) return [];
    const unique = [...new Set(codes.filter((c) => typeof c === 'string' && isKnownKey(c)))];
    const mods = MODIFIER_ORDER.filter((m) => unique.includes(m));
    const rest = unique.filter((c) => !isModifier(c));
    return [...mods, ...rest].slice(0, MAX_COMBO);
  }

  function labelOf(code) {
    return isKnownKey(code) ? KEYS[code].label : code;
  }

  function describeCombo(codes) {
    const combo = normalizeCombo(codes);
    return combo.length ? combo.map(labelOf).join(' + ') : '—';
  }

  return {
    KEYS,
    GROUPS,
    MAX_COMBO,
    isKnownKey,
    isModifier,
    normalizeCombo,
    labelOf,
    describeCombo,
  };
});
