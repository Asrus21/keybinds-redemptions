// Perfis: conjuntos de regras que o streamer troca conforme o que está
// fazendo ("Valorant", "Just Chatting", "Live de sábado").
//
// Só um perfil fica ativo por vez, e só as regras dele disparam. Cada perfil
// pode listar executáveis ("valorant.exe, cs2.exe"); com a troca automática
// ligada, abrir um desses jogos ativa o perfil sozinho.
//
// Configuração antiga (uma lista de regras solta) vira um perfil "Padrão" na
// migração, então quem atualiza não perde nada nem precisa fazer nada.

const crypto = require('node:crypto');
const { normalizeRule } = require('./rules');

const LIMITS = {
  name: 40,
  matchExe: 300,
  profiles: 30,
  rules: 300,
};

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Executáveis de um perfil, em minúsculas e sem repetir. Aceita separar por
 * vírgula, ponto e vírgula, espaço ou quebra de linha, e aceita caminho
 * inteiro colado do Gerenciador de Tarefas (fica só o nome do arquivo).
 */
function exeList(matchExe) {
  const seen = new Set();
  for (const raw of String(matchExe || '').split(/[,;\n\r\t ]+/)) {
    const name = raw.trim().replace(/^.*[\\/]/, '').toLowerCase();
    if (name) seen.add(name.endsWith('.exe') ? name : `${name}.exe`);
  }
  return [...seen];
}

function newProfile(name = 'Novo perfil') {
  return normalizeProfile({ id: crypto.randomUUID(), name });
}

function normalizeProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const rules = Array.isArray(p.rules) ? p.rules.slice(0, LIMITS.rules) : [];
  return {
    id: cleanText(p.id, 64) || crypto.randomUUID(),
    name: cleanText(p.name, LIMITS.name) || 'Sem nome',
    matchExe: cleanText(p.matchExe, LIMITS.matchExe),
    rules: rules.map(normalizeRule),
  };
}

/**
 * Perfis e perfil ativo de uma configuração, aceitando tanto o formato novo
 * quanto o antigo (`rules` solto na raiz).
 */
function normalizeProfiles(config) {
  const c = config && typeof config === 'object' ? config : {};
  let list = Array.isArray(c.profiles) ? c.profiles.slice(0, LIMITS.profiles) : [];
  if (list.length === 0) {
    // Formato antigo (ou config zerada): as regras da raiz viram o "Padrão".
    list = [{ id: crypto.randomUUID(), name: 'Padrão', rules: Array.isArray(c.rules) ? c.rules : [] }];
  }
  const profiles = list.map(normalizeProfile);
  const active = profiles.some((p) => p.id === c.activeProfileId) ? c.activeProfileId : profiles[0].id;
  return { profiles, activeProfileId: active };
}

/**
 * Qual perfil corresponde a um executável em foco. `null` quando nenhum
 * lista esse programa — aí a troca automática não mexe em nada, para não
 * derrubar o perfil do streamer toda vez que ele abrir o navegador.
 *
 * Dois perfis listando o mesmo jogo: vale o primeiro da lista.
 */
function profileForExe(profiles, exe) {
  const name = String(exe || '').replace(/^.*[\\/]/, '').toLowerCase();
  if (!name) return null;
  return profiles.find((p) => exeList(p.matchExe).includes(name)) || null;
}

/** O que sai no arquivo de exportação (nada de token ou Client ID). */
function exportProfile(profile) {
  return {
    app: 'keybinds-redemptions',
    kind: 'profile',
    version: 1,
    name: profile.name,
    matchExe: profile.matchExe,
    rules: profile.rules,
  };
}

/**
 * Lê um arquivo exportado e devolve um perfil novo (ids próprios, para dois
 * perfis importados não colidirem). Joga erro se não for um export nosso.
 */
function importProfile(raw, { name } = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  if (data.app !== 'keybinds-redemptions' || data.kind !== 'profile') {
    throw new Error('Este arquivo não é um perfil do Keybinds Redemptions.');
  }
  if (!Array.isArray(data.rules)) throw new Error('O arquivo não tem regras.');
  return normalizeProfile({
    id: crypto.randomUUID(),
    name: cleanText(name, LIMITS.name) || cleanText(data.name, LIMITS.name) || 'Perfil importado',
    matchExe: data.matchExe,
    // Id novo em cada regra: as do arquivo podem bater com as já existentes.
    rules: data.rules.map((r) => ({ ...r, id: crypto.randomUUID() })),
  });
}

module.exports = {
  LIMITS,
  exeList,
  newProfile,
  normalizeProfile,
  normalizeProfiles,
  profileForExe,
  exportProfile,
  importProfile,
};
