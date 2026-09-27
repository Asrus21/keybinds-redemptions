// Processo principal do Electron: janela, ícone na bandeja e a ponte (IPC)
// entre a tela e o Controller. A lógica de verdade mora no controller.js.

const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
} = require('electron');

const { Controller } = require('./controller');
const { Store } = require('./store');
const { createKeyboard, createSimulatedKeyboard } = require('./keyboard');
const { createInstaller } = require('./autoupdate');
const pkg = require('../../package.json');

const APP_ID = 'app.asrus.keybinds-redemptions';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');

// Links que a tela pode abrir no navegador. Qualquer outro é ignorado.
const EXTERNAL_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'dev.twitch.tv', 'github.com']);

let win = null;
let tray = null;
let controller = null;
let quitting = false;
let trayHintShown = false;

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) shell.openExternal(u.toString());
  } catch {}
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow({ hidden }) {
  win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Keybinds Redemptions',
    backgroundColor: '#111110',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(RENDERER);

  // A tela nunca navega nem abre janelas; links vão para o navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });

  win.on('close', (e) => {
    if (quitting || !controller.config.settings.closeToTray) return;
    // Fechar só esconde: o app continua escutando os eventos na bandeja.
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'Keybinds Redemptions continua rodando',
        body: 'Os eventos seguem apertando teclas. Para sair de vez, use o ícone da bandeja.',
        icon: path.join(ASSETS, 'icon.png'),
      }).show();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

let trayKey = '';

function refreshTray() {
  if (!tray || !controller) return;
  const s = controller.snapshot();
  // O estado muda a cada resgate; o menu só precisa ser refeito quando
  // pausa/conexão mudam.
  const key = `${s.paused}|${s.connection}`;
  if (key === trayKey) return;
  trayKey = key;
  const conn = {
    online: 'escutando eventos',
    connecting: 'conectando…',
    reconnecting: 'reconectando…',
    offline: 'desconectado',
  }[s.connection] || s.connection;
  tray.setToolTip(`Keybinds Redemptions — ${s.paused ? 'PAUSADO' : conn}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      { type: 'separator' },
      {
        label: 'Pausar (eventos não apertam teclas)',
        type: 'checkbox',
        checked: s.paused,
        click: (item) => controller.setPaused(item.checked),
      },
      { label: 'Parar tudo (soltar teclas)', click: () => controller.stopAll() },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  refreshTray();
}

function applyLoginItem(settings) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  // No .exe portátil o processo roda de uma pasta temporária; o caminho que
  // vale para abrir com o Windows é o do arquivo original.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({
    openAtLogin: !!settings.openAtLogin,
    path: exe,
    args: ['--hidden'],
  });
}

function buildKeyboard() {
  try {
    return createKeyboard({ log: (m) => console.log(m) });
  } catch (err) {
    // Sem a DLL/binário nativo: o app abre, avisa, e só simula.
    console.error('Falha ao carregar o teclado nativo:', err);
    const kb = createSimulatedKeyboard((m) => console.log(m));
    kb.name = `Simulação (erro ao carregar SendInput: ${err.message})`;
    return kb;
  }
}

// Métodos que a tela pode chamar. Nada fora desta lista passa pelo IPC.
function ipcApi() {
  return {
    getState: () => controller.snapshot(),
    getLog: () => controller.getLog(),
    getVersion: () => app.getVersion(),
    setClientId: (id) => controller.setClientId(id),
    // O login fica esperando o streamer autorizar; não segura a resposta. Os
    // erros dele aparecem no aviso da tela.
    login: () => {
      if (!controller.clientId) throw new Error('Informe o Client ID do seu app da Twitch primeiro.');
      controller.login().catch((err) => controller.setNotice(err.message));
    },
    cancelLogin: () => controller.cancelLogin(),
    openActivation: () => controller.openActivation(),
    logout: () => controller.logout(),
    refreshRewards: () => controller.refreshRewards(),
    addRule: () => controller.addRule(),
    updateRule: (id, patch) => controller.updateRule(id, patch),
    removeRule: (id) => controller.removeRule(id),
    testRule: (id) => controller.testRule(id),
    setPaused: (paused) => controller.setPaused(paused),
    stopAll: () => controller.stopAll(),
    updateSettings: (patch) => controller.updateSettings(patch),
    connectDonation: (name, credentials) => controller.connectDonation(name, credentials),
    disconnectDonation: (name) => controller.disconnectDonation(name),
    dismissNotice: () => controller.setNotice(''),
    dismissUpdate: () => controller.dismissUpdate(),
    openUpdate: () => controller.update && openExternal(controller.update.url),
    // Fecha, instala em silêncio e abre de novo (o before-quit solta as teclas).
    installUpdate: () => controller.installUpdate(),
    openExternal: (url) => openExternal(url),
    // Abre %APPDATA%\Keybinds Redemptions no explorador (regras e backups).
    openDataFolder: () => shell.openPath(app.getPath('userData')),
  };
}

function wireIpc() {
  const api = ipcApi();
  ipcMain.handle('kr:call', async (event, method, ...args) => {
    // Só a nossa página (file://…/index.html) conversa com o processo principal.
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !url.startsWith('file://') || !url.endsWith('/renderer/index.html')) {
      return { ok: false, error: 'origem não autorizada' };
    }
    if (!Object.prototype.hasOwnProperty.call(api, method)) {
      return { ok: false, error: `método desconhecido: ${method}` };
    }
    try {
      return { ok: true, value: await api[method](...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  controller.on('state', () => {
    refreshTray();
    if (win && !win.isDestroyed()) win.webContents.send('kr:state', controller.snapshot());
  });
  controller.on('log', (entry) => {
    if (win && !win.isDestroyed()) win.webContents.send('kr:log', entry);
  });
  controller.on('settings', applyLoginItem);
}

async function start() {
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  const store = new Store({
    dir: app.getPath('userData'),
    cipher: {
      available: safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
    },
    log: (m) => console.warn(m),
  });

  controller = new Controller({
    store,
    keyboard: buildKeyboard(),
    openExternal,
    envClientId: process.env.TWITCH_CLIENT_ID || '',
    defaultClientId: pkg.twitchClientId || '',
    appVersion: app.getVersion(),
    installer: createInstaller({ app, log: (m) => console.warn(m) }),
  });

  controller.load();
  wireIpc();
  createWindow({ hidden: process.argv.includes('--hidden') });
  createTray();
  await controller.init();
}

if (!app.requestSingleInstanceLock()) {
  // Já tem um aberto (provavelmente na bandeja): ele mesmo se mostra.
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
  app.on('before-quit', () => {
    quitting = true;
    // Solta qualquer tecla que esteja sendo segurada antes de fechar.
    if (controller) controller.dispose();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
