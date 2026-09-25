// Formato de uma regra "recompensa → tecla" e os limites de cada campo.
//
// Tudo que chega da tela passa por aqui antes de ser salvo, então o arquivo de
// configuração nunca tem valor fora da faixa, mesmo que alguém edite na mão.

const crypto = require('node:crypto');
const { normalizeCombo } = require('../shared/keys');

const LIMITS = {
  // Jogo lê o teclado uma vez por frame; toque mais curto que ~2 frames pode
  // não ser visto. 60 ms cobre até jogo rodando a 30 fps.
  holdMs: { min: 10, max: 60_000, default: 60 },
  repeat: { min: 1, max: 100, default: 1 },
  gapMs: { min: 0, max: 10_000, default: 100 },
};

function clampInt(value, { min, max, default: fallback }) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Regra nova, sem recompensa e sem tecla — a tela preenche. */
function newRule() {
  return normalizeRule({ id: crypto.randomUUID(), enabled: true });
}

function normalizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: cleanText(r.id, 64) || crypto.randomUUID(),
    enabled: r.enabled !== false,
    rewardId: cleanText(r.rewardId, 64),
    // Guardamos o título só para mostrar se a recompensa sumir do canal.
    rewardTitle: cleanText(r.rewardTitle, 100),
    keys: normalizeCombo(r.keys),
    holdMs: clampInt(r.holdMs, LIMITS.holdMs),
    repeat: clampInt(r.repeat, LIMITS.repeat),
    gapMs: clampInt(r.gapMs, LIMITS.gapMs),
  };
}

/** Aplica só os campos editáveis de `patch` numa regra existente. */
function patchRule(rule, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const editable = ['enabled', 'rewardId', 'rewardTitle', 'keys', 'holdMs', 'repeat', 'gapMs'];
  const next = { ...rule };
  for (const field of editable) {
    if (Object.prototype.hasOwnProperty.call(p, field)) next[field] = p[field];
  }
  return normalizeRule(next);
}

/** Uma regra só dispara se estiver ligada e completa. */
function isRunnable(rule) {
  return rule.enabled && rule.rewardId !== '' && rule.keys.length > 0;
}

function actionOf(rule) {
  return { keys: rule.keys, holdMs: rule.holdMs, repeat: rule.repeat, gapMs: rule.gapMs };
}

module.exports = { LIMITS, newRule, normalizeRule, patchRule, isRunnable, actionOf };
