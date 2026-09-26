// Onde o app guarda as coisas, dentro da pasta de dados do usuário
// (%APPDATA%\Keybinds Redemptions no Windows):
//
//   config.json — Client ID, regras e preferências. Nada secreto.
//   tokens.bin  — tokens da Twitch, cifrados com o safeStorage do Electron
//                 (DPAPI no Windows: só o seu usuário do Windows consegue ler).
//   donations.bin — tokens dos serviços de doação, cifrados do mesmo jeito.
//
// Escrita atômica (arquivo temporário + rename) para uma queda de energia no
// meio do salvamento não deixar um JSON pela metade.

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_VERSION = 1;

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    clientId: '',
    rules: [],
    paused: false,
    settings: {
      closeToTray: true,
      openAtLogin: false,
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
    fs.mkdirSync(dir, { recursive: true });
  }

  loadConfig() {
    const base = defaultConfig();
    try {
      const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      return {
        ...base,
        ...saved,
        settings: { ...base.settings, ...(saved && saved.settings) },
        rules: Array.isArray(saved && saved.rules) ? saved.rules : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Arquivo corrompido: guarda uma cópia para não perder as regras de vez.
        this.log(`config.json ilegível (${err.message}); começando do zero.`);
        try {
          fs.copyFileSync(this.configFile, `${this.configFile}.corrompido`);
        } catch {}
      }
      return base;
    }
  }

  saveConfig(config) {
    writeAtomic(this.configFile, JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2));
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
