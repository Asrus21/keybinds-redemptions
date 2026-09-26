// Formato de uma regra "evento → tecla", os limites de cada campo e a escolha
// de quais regras disparam para um evento.
//
// Tudo que chega da tela passa por aqui antes de ser salvo, então o arquivo de
// configuração nunca tem valor fora da faixa, mesmo que alguém edite na mão.
//
// Gatilhos:
//   reward   — resgate de uma recompensa de pontos do canal (rewardId)
//   bits     — cheer com X bits ou mais (min/max)
//   sub      — sub nova ou renovada (tier: any | 1000 | 2000 | 3000)
//   gift     — alguém deu X subs de presente ou mais (min/max)
//   donation — doação de X ou mais (min/max), de um serviço ou de qualquer um

const crypto = require('node:crypto');
const { normalizeCombo } = require('../shared/keys');

const TRIGGERS = ['reward', 'bits', 'sub', 'gift', 'donation'];
const TIERS = ['any', '1000', '2000', '3000'];
const DONATION_SOURCES = ['any', 'streamelements', 'streamlabs', 'livepix'];

const LIMITS = {
  // Jogo lê o teclado uma vez por frame; toque mais curto que ~2 frames pode
  // não ser visto. 60 ms cobre até jogo rodando a 30 fps.
  holdMs: { min: 10, max: 60_000, default: 60 },
  repeat: { min: 1, max: 100, default: 1 },
  gapMs: { min: 0, max: 10_000, default: 100 },
};

// Faixa de valor de cada gatilho. max = 0 quer dizer "sem limite".
const AMOUNT = {
  bits: { min: 1, max: 10_000_000, default: 100, decimals: 0 },
  gift: { min: 1, max: 1_000, default: 1, decimals: 0 },
  donation: { min: 0.01, max: 10_000_000, default: 5, decimals: 2 },
};

function clampInt(value, { min, max, default: fallback }) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Aceita "10,50" (vírgula brasileira) além de 10.5. */
function toNumber(value) {
  if (typeof value === 'string') value = value.trim().replace(',', '.');
  return Number(value);
}

function round(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeAmount(value, trigger, { allowZero = false } = {}) {
  const spec = AMOUNT[trigger];
  if (!spec) return 0;
  const n = toNumber(value);
  if (allowZero && (!Number.isFinite(n) || n <= 0)) return 0;
  if (!Number.isFinite(n)) return spec.default;
  return round(Math.min(spec.max, Math.max(spec.min, n)), spec.decimals);
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Regra nova, de recompensa, sem recompensa e sem tecla — a tela preenche. */
function newRule() {
  return normalizeRule({ id: crypto.randomUUID(), enabled: true });
}

function normalizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  // Regras salvas antes dos gatilhos existirem são todas de recompensa.
  const trigger = TRIGGERS.includes(r.trigger) ? r.trigger : 'reward';
  const min = normalizeAmount(r.min, trigger);
  let max = normalizeAmount(r.max, trigger, { allowZero: true });
  if (max && max < min) max = min;
  return {
    id: cleanText(r.id, 64) || crypto.randomUUID(),
    enabled: r.enabled !== false,
    trigger,
    rewardId: cleanText(r.rewardId, 64),
    // Guardamos o título só para mostrar se a recompensa sumir do canal.
    rewardTitle: cleanText(r.rewardTitle, 100),
    min,
    max,
    tier: TIERS.includes(r.tier) ? r.tier : 'any',
    source: DONATION_SOURCES.includes(r.source) ? r.source : 'any',
    keys: normalizeCombo(r.keys),
    holdMs: clampInt(r.holdMs, LIMITS.holdMs),
    repeat: clampInt(r.repeat, LIMITS.repeat),
    gapMs: clampInt(r.gapMs, LIMITS.gapMs),
  };
}

/** Aplica só os campos editáveis de `patch` numa regra existente. */
function patchRule(rule, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const editable = [
    'enabled', 'trigger', 'rewardId', 'rewardTitle', 'min', 'max', 'tier', 'source',
    'keys', 'holdMs', 'repeat', 'gapMs',
  ];
  const next = { ...rule };
  for (const field of editable) {
    if (Object.prototype.hasOwnProperty.call(p, field)) next[field] = p[field];
  }
  // Trocou o tipo de gatilho: a faixa antiga não faz sentido no novo
  // (100 bits ≠ R$ 100), então volta para o padrão dele.
  if (next.trigger !== rule.trigger && !('min' in p)) {
    next.min = AMOUNT[next.trigger] ? AMOUNT[next.trigger].default : 0;
    next.max = 0;
  }
  return normalizeRule(next);
}

/** Uma regra só dispara se estiver ligada e completa. */
function isRunnable(rule) {
  if (!rule.enabled || rule.keys.length === 0) return false;
  return rule.trigger !== 'reward' || rule.rewardId !== '';
}

/**
 * Quais regras disparam para um evento.
 *
 * `event`: { kind, rewardId?, amount?, tier?, source? } — `kind` é um dos
 * TRIGGERS.
 *
 * Nos gatilhos com valor (bits, gift, doação), se mais de uma faixa servir,
 * vale só a de maior "a partir de": com regras de R$ 5+ e R$ 10+, uma doação
 * de R$ 12 aperta só a de R$ 10+. É o jeito de montar "quanto mais doar,
 * maior o efeito" sem as faixas se somarem.
 */
function matchRules(rules, event) {
  const candidates = rules.filter((r) => r.trigger === event.kind && isRunnable(r));
  if (event.kind === 'reward') return candidates.filter((r) => r.rewardId === event.rewardId);
  if (event.kind === 'sub') return candidates.filter((r) => r.tier === 'any' || r.tier === event.tier);

  const amount = Number(event.amount);
  if (!Number.isFinite(amount)) return [];
  const inRange = candidates.filter(
    (r) =>
      (event.kind !== 'donation' || r.source === 'any' || r.source === event.source) &&
      amount >= r.min &&
      (!r.max || amount <= r.max)
  );
  if (inRange.length === 0) return [];
  const best = Math.max(...inRange.map((r) => r.min));
  return inRange.filter((r) => r.min === best);
}

const TIER_LABELS = { any: 'qualquer tier', 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };
const SOURCE_LABELS = {
  any: 'qualquer serviço',
  streamelements: 'StreamElements',
  streamlabs: 'Streamlabs',
  livepix: 'LivePix',
};

function formatMoney(amount, currency) {
  try {
    if (currency) return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(amount);
  } catch {}
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

function rangeText(rule, unit) {
  const fmt = (n) => (rule.trigger === 'donation' ? formatMoney(n) : n.toLocaleString('pt-BR'));
  const suffix = unit ? ` ${unit}` : '';
  if (rule.max === rule.min) return `${fmt(rule.min)}${suffix}`;
  if (rule.max) return `${fmt(rule.min)} a ${fmt(rule.max)}${suffix}`;
  return `${fmt(rule.min)}${suffix} ou mais`;
}

/** Texto curto do gatilho, para o registro ("Bits: 100 ou mais"). */
function describeTrigger(rule) {
  switch (rule.trigger) {
    case 'bits':
      return `Bits: ${rangeText(rule, 'bits')}`;
    case 'sub':
      return `Sub (${TIER_LABELS[rule.tier]})`;
    case 'gift':
      return `Gift sub: ${rangeText(rule, rule.min === 1 && !rule.max ? 'sub' : 'subs')}`;
    case 'donation':
      return `Doação: ${rangeText(rule)} (${SOURCE_LABELS[rule.source]})`;
    default:
      return rule.rewardTitle || 'Recompensa';
  }
}

function actionOf(rule) {
  return { keys: rule.keys, holdMs: rule.holdMs, repeat: rule.repeat, gapMs: rule.gapMs };
}

module.exports = {
  TRIGGERS,
  TIERS,
  DONATION_SOURCES,
  LIMITS,
  AMOUNT,
  TIER_LABELS,
  SOURCE_LABELS,
  newRule,
  normalizeRule,
  patchRule,
  isRunnable,
  matchRules,
  describeTrigger,
  formatMoney,
  actionOf,
};
