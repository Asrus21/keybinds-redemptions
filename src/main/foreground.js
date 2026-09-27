// Descobre qual programa está em foco, para a troca automática de perfil.
//
// No Windows: GetForegroundWindow → GetWindowThreadProcessId → OpenProcess →
// QueryFullProcessImageNameW. Só pedimos PROCESS_QUERY_LIMITED_INFORMATION,
// que é o direito mínimo para ler o caminho e funciona mesmo com processos de
// nível mais alto (jogo como administrador, por exemplo) — com o
// PROCESS_QUERY_INFORMATION antigo, o OpenProcess falharia justo nos jogos.
//
// Consulta por tempo (1 s) em vez de hook de evento: um SetWinEventHook
// precisaria de bomba de mensagens no processo principal do Electron, e um
// segundo de atraso para trocar de perfil não faz diferença nenhuma aqui.
//
// Fora do Windows não existe detecção: devolve um vigia que nunca dispara,
// e a tela avisa que a troca automática só vale no Windows.

const { EventEmitter } = require('node:events');

const POLL_MS = 1000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_PATH_WIDE = 32768;

function createWin32Reader() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const GetForegroundWindow = user32.func('void *__stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)'
  );
  const OpenProcess = kernel32.func(
    'void *__stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'
  );
  const QueryFullProcessImageNameW = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)'
  );
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *hObject)');

  /** Nome do .exe em foco, em minúsculas, ou '' se não der para saber. */
  return function readForegroundExe() {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return ''; // ninguém em foco (tela de bloqueio, troca de área)
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!pid[0]) return '';
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
    if (!handle) return ''; // processo do sistema: sem permissão, e tudo bem
    try {
      const buf = new Uint16Array(MAX_PATH_WIDE);
      const size = [buf.length];
      if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return '';
      const path = Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le');
      return path.replace(/^.*[\\/]/, '').toLowerCase();
    } finally {
      CloseHandle(handle);
    }
  };
}

/**
 * Vigia do programa em foco.
 *
 * @param {{ platform?: string, read?: () => string, pollMs?: number, log?: (m: string) => void }} opts
 *   `read` existe para os testes trocarem a leitura de verdade.
 * @returns {EventEmitter & { supported: boolean, current: string, start(): void, stop(): void }}
 *   Emite 'change' com o nome do .exe sempre que ele muda.
 */
function createForegroundWatcher({ platform = process.platform, read, pollMs = POLL_MS, log = () => {} } = {}) {
  const watcher = new EventEmitter();
  let reader = read || null;
  if (!reader && platform === 'win32') {
    try {
      reader = createWin32Reader();
    } catch (err) {
      log(`Troca automática de perfil indisponível: ${err.message}`);
    }
  }
  let timer = null;
  let failures = 0;

  watcher.supported = !!reader;
  watcher.current = '';

  watcher.tick = () => {
    if (!reader) return;
    let exe;
    try {
      exe = reader();
      failures = 0;
    } catch (err) {
      // Uma falha isolada não é motivo para desistir; um defeito de verdade
      // repetiria toda vez e encheria o registro, então desligamos depois de 3.
      if (++failures >= 3) {
        log(`Troca automática de perfil desligada depois de falhar: ${err.message}`);
        watcher.stop();
        watcher.supported = false;
      }
      return;
    }
    if (exe === watcher.current) return;
    watcher.current = exe;
    watcher.emit('change', exe);
  };

  watcher.start = () => {
    if (timer || !reader) return;
    watcher.tick();
    timer = setInterval(watcher.tick, pollMs);
    if (timer.unref) timer.unref();
  };

  watcher.stop = () => {
    clearInterval(timer);
    timer = null;
  };

  return watcher;
}

module.exports = { createForegroundWatcher, POLL_MS };
