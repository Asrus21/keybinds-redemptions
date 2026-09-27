// Onde o app guarda as coisas, dentro da pasta de dados do usuário
// (%APPDATA%\Keybinds Redemptions no Windows):
//
//   config.json — Client ID, regras e preferências. Nada secreto.
//   tokens.bin  — tokens da Twitch, cifrados com o safeStorage do Electron
//                 (DPAPI no Windows: só o seu usuário do Windows consegue ler).
//   donations.bin — tokens dos serviços de doação, cifrados do mesmo jeito.
//   backups/    — cópias antigas do config.json (ver abaixo).
//
// Escrita atômica (arquivo temporário + rename) para uma queda de energia no
// meio do salvamento não deixar um JSON pela metade.
//
// Backup: antes de sobrescrever o config.json, o conteúdo antigo vai para
// backups/config-<data>.json. Guardamos as BACKUP_KEEP cópias mais novas, e no
// máximo uma a cada BACKUP_GAP_MS — senão editar cinco campos seguidos
// encheria a pasta e jogaria fora o histórico de verdade. Se o config.json
// sumir ou vier ilegível, o app volta sozinho para a cópia mais nova que der
// para ler: perder as regras de um mês por um arquivo corrompido seria o pior
// defeito possível aqui.

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_VERSION = 1;
const BACKUP_KEEP = 10;
const BACKUP_GAP_MS = 5 * 60 * 1000;

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    clientId: '',
    rules: [],
    paused: false,
    settings: {
      closeToTray: true,
      openAtLogin: false,
      dismissedUpdate: '', // versão cujo aviso o streamer dispensou
    },
  };
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Store {
  /**
   * @param {{ dir: string, cipher?: { available: boolean, encrypt(s: string): Buffer, decrypt(b: Buffer): string }, log?: (m: string) => void }} opts
   *   Sem `cipher` disponível, os tokens ficam em texto puro (só acontece fora
   *   do Windows, em Linux sem chaveiro).
   */
  constructor({ dir, cipher, log = () => {} }) {
    this.dir = dir;
    this.cipher = cipher && cipher.available ? cipher : null;
    this.log = log;
    this.configFile = path.join(dir, 'config.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Cópias do config.json, da mais nova para a mais velha. */
  listBackups() {
    let names;
    try {
      names = fs.readdirSync(this.backupDir);
    } catch {
      return [];
    }
    // O nome começa com a data em formato que ordena igual ao tempo.
    return names
      .filter((n) => n.startsWith('config-') && n.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => ({ name, file: path.join(this.backupDir, name) }));
  }

  /** Guarda `text` como cópia, se já não houver uma igual ou recente. */
  backupConfig(text) {
    const [newest] = this.listBackups();
    if (newest) {
      try {
        if (fs.readFileSync(newest.file, 'utf8') === text) return; // nada mudou
        if (Date.now() - fs.statSync(newest.file).mtimeMs < BACKUP_GAP_MS) return;
      } catch {
        // Cópia ilegível: segue e grava uma nova por cima do rodízio.
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      writeAtomic(path.join(this.backupDir, `config-${stamp}.json`), text);
      for (const old of this.listBackups().slice(BACKUP_KEEP)) fs.rmSync(old.file, { force: true });
    } catch (err) {
      this.log(`Não deu para guardar a cópia do config.json (${err.message}).`);
    }
  }

  loadConfig() {
    const base = defaultConfig();
    const merge = (saved) => ({
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved && saved.settings) },
      rules: Array.isArray(saved && saved.rules) ? saved.rules : [],
    });
    try {
      return merge(JSON.parse(fs.readFileSync(this.configFile, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Arquivo corrompido: guarda como está, para não perder nada de vez.
        this.log(`config.json ilegível (${err.message}).`);
        try {
          fs.copyFileSync(this.configFile, `${this.configFile}.corrompido`);
        } catch {}
      }
      // Sumiu ou não abre: volta para a cópia mais nova que der para ler.
      for (const backup of this.listBackups()) {
        try {
          const saved = merge(JSON.parse(fs.readFileSync(backup.file, 'utf8')));
          this.log(`Recuperando as regras da cópia ${backup.name}.`);
          this.restoredFrom = backup.name;
          return saved;
        } catch {}
      }
      if (err.code !== 'ENOENT') this.log('Nenhuma cópia serviu; começando do zero.');
      return base;
    }
  }

  saveConfig(config) {
    const text = JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2);
    try {
      this.backupConfig(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      // Primeira gravação: ainda não há o que copiar.
    }
    writeAtomic(this.configFile, text);
  }

  loadTokens() {
    return this.loadSecret('tokens');
  }

  saveTokens(tokens) {
    this.saveSecret('tokens', tokens);
  }

  secretFile(name) {
    return path.join(this.dir, `${name}.bin`);
  }

  /** Lê um JSON cifrado (`<nome>.bin`). null se não existe ou não dá para ler. */
  loadSecret(name) {
    let raw;
    try {
      raw = fs.readFileSync(this.secretFile(name));
    } catch {
      return null;
    }
    try {
      const text = raw.subarray(0, 6).toString() === 'plain:'
        ? raw.subarray(6).toString('utf8')
        : this.cipher
          ? this.cipher.decrypt(raw)
          : null;
      return text ? JSON.parse(text) : null;
    } catch (err) {
      this.log(`Não deu para ler ${name}.bin (${err.message}); será preciso configurar de novo.`);
      return null;
    }
  }

  /** Grava um JSON cifrado; null apaga o arquivo. */
  saveSecret(name, value) {
    const file = this.secretFile(name);
    if (!value) {
      fs.rmSync(file, { force: true });
      return;
    }
    const text = JSON.stringify(value);
    const data = this.cipher
      ? this.cipher.encrypt(text)
      : Buffer.concat([Buffer.from('plain:'), Buffer.from(text, 'utf8')]);
    writeAtomic(file, data);
  }
}

module.exports = { Store, defaultConfig };
