// Escolhe como as teclas vão ser apertadas.
//
// No Windows é a SendInput de verdade. Em qualquer outro sistema o app abre do
// mesmo jeito (útil para mexer na tela), mas as teclas só aparecem no registro
// — a tela avisa que é simulação.

const { labelOf } = require('../../shared/keys');

function createSimulatedKeyboard(log = () => {}) {
  const events = [];
  return {
    name: 'Simulação (fora do Windows)',
    simulated: true,
    events,
    keyDown(code) {
      events.push(['down', code]);
      log(`[simulação] ↓ ${labelOf(code)}`);
    },
    keyUp(code) {
      events.push(['up', code]);
      log(`[simulação] ↑ ${labelOf(code)}`);
    },
  };
}

function createKeyboard({ platform = process.platform, log } = {}) {
  if (platform === 'win32') {
    const { createWin32Keyboard } = require('./win32');
    return createWin32Keyboard();
  }
  return createSimulatedKeyboard(log);
}

module.exports = { createKeyboard, createSimulatedKeyboard };
