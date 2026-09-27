// Baixa e instala a versão nova por dentro do app (electron-updater, lendo o
// latest.yml que o workflow publica junto do instalador na release).
//
// Só vale para o app INSTALADO no Windows. O .exe portátil e o `npm start`
// não têm como se substituir: para eles continua o aviso com o link da
// release (ver updates.js).
//
// O Controller não conhece o electron-updater; ele recebe só isto:
//   download() → Promise<versão baixada>   (rejeita se não achar ou falhar)
//   install()  → fecha o app, instala em silêncio e abre de novo
//   evento 'progress' (0–100)

const { EventEmitter } = require('node:events');

/**
 * @param {{ app: import('electron').App, log?: (m: string) => void }} opts
 * @returns {EventEmitter & { download(): Promise<string>, install(): void } | null}
 */
function createInstaller({ app, log = () => {} }) {
  if (process.platform !== 'win32' || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return null;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log(`Atualização automática indisponível: ${err.message}`);
    return null;
  }

  autoUpdater.autoDownload = true;
  // Se o streamer não clicar em "Reiniciar agora", instala quando o app fechar.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info() {}, debug() {}, warn: (m) => log(String(m)), error: (m) => log(String(m)) };

  const installer = new EventEmitter();
  let lastPercent = -1;
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent || 0);
    if (percent === lastPercent) return;
    lastPercent = percent;
    installer.emit('progress', percent);
  });

  installer.download = async () => {
    lastPercent = -1;
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable || !result.downloadPromise) {
      throw new Error('a release não tem o instalador para atualização automática');
    }
    await result.downloadPromise;
    return result.updateInfo.version;
  };

  // Silencioso (sem as telas do instalador) e abrindo o app de novo no fim.
  installer.install = () => autoUpdater.quitAndInstall(true, true);

  return installer;
}

module.exports = { createInstaller };
