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
//   command  — alguém digitou um comando no chat (!som), com um nível mínimo
//              de quem pode usar

const crypto = require('node:crypto');
const { normalizeCombo } = require('../shared/keys');

const TRIGGERS = ['reward', 'bits', 'sub', 'gift', 'donation', 'command'];
// Quem pode usar um comando do chat. É uma escada: quem está acima também
// pode. VIP não é "mais" que sub na Twitch, mas como escolha de "nível
// mínimo" é o que o streamer espera de um menu com essas quatro opções.
const CHATTERS = ['all', 'sub', 'vip', 'mod'];
const CHATTER_LEVEL = { all: 0, sub: 1, vip: 2, mod: 3 };
const COMMAND_MAX = 30;
const TIERS = ['any', '1000', '2000', '3000'];
const DONATION_SOURCES = ['any', 'streamelements', 'streamlabs', 'livepix', 'pixgg'];

// O que uma regra faz é uma SEQUÊNCIA de passos, não uma tecla só: dá para
// apertar Ctrl+G, esperar meio segundo e apertar W. Cada passo diz quanto
// tempo segurar e quanto esperar depois dele.
//
//   keys — aperta uma combinação
//   open — abre um arquivo ou programa (o .bat do OBS, por exemplo)
//   url  — abre um link no navegador
//
// `open` e `url` saem pelo shell do Electron, sem interpretador de comandos no
// meio: não existe linha de comando para alguém injetar coisa. E o caminho é
// sempre o que o streamer escolheu na regra — nada vem do chat nem da doação.
const STEP_KINDS = ['keys', 'open', 'url'];
const STEP_TEXT_MAX = 500;
const MAX_STEPS = 20;

const LIMITS = {
  // Jogo lê o teclado uma vez por frame; toque mais curto que ~2 frames pode
  // não ser visto. 60 ms cobre até jogo rodando a 30 fps.
  holdMs: { min: 10, max: 60_000, default: 60 },
  repeat: { min: 1, max: 100, default: 1 },
  gapMs: { min: 0, max: 10_000, default: 100 },
  // 0 = sem espera. O teto de 1 hora é o que cabe numa live.
  cooldownMs: { min: 0, max: 3_600_000, default: 0 },
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

function normalizeStep(raw) {
  const st = raw && typeof raw === 'object' ? raw : {};
  const kind = STEP_KINDS.includes(st.kind) ? st.kind : 'keys';
  return {
    kind,
    keys: kind === 'keys' ? normalizeCombo(st.keys) : [],
    text: kind === 'keys' ? '' : cleanText(st.text, STEP_TEXT_MAX),
    holdMs: clampInt(st.holdMs, LIMITS.holdMs),
    gapMs: clampInt(st.gapMs, LIMITS.gapMs),
  };
}

/** Um passo sem tecla (ou sem caminho) não faz nada; fora da lista. */
function stepIsComplete(step) {
  return step.kind === 'keys' ? step.keys.length > 0 : step.text !== '';
}

/**
 * Passos de uma regra, aceitando o formato antigo (uma tecla solta em
 * `keys`/`holdMs`/`gapMs`), que vira um passo só.
 */
function normalizeSteps(rule) {
  if (Array.isArray(rule.steps)) {
    return rule.steps.slice(0, MAX_STEPS).map(normalizeStep).filter(stepIsComplete);
  }
  const keys = normalizeCombo(rule.keys);
  if (keys.length === 0) return [];
  return [normalizeStep({ kind: 'keys', keys, holdMs: rule.holdMs, gapMs: rule.gapMs })];
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Um comando é sempre a PRIMEIRA palavra da mensagem, em minúsculas. Se o
 * streamer digitar "!som alto" no campo, guardamos "!som": o resto da
 * mensagem é assunto de quem escreveu, não parte do comando.
 */
function cleanCommand(value) {
  return cleanText(value, COMMAND_MAX).toLowerCase().split(/\s+/)[0] || '';
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
    command: cleanCommand(r.command),
    who: CHATTERS.includes(r.who) ? r.who : 'all',
    cooldownMs: clampInt(r.cooldownMs, LIMITS.cooldownMs),
    // Por pessoa: a espera conta para cada nick separado, então uma pessoa
    // sozinha não segura a regra para o resto do chat.
    cooldownPerUser: r.cooldownPerUser === true,
    steps: normalizeSteps(r),
    repeat: clampInt(r.repeat, LIMITS.repeat),
  };
}

/** Aplica só os campos editáveis de `patch` numa regra existente. */
function patchRule(rule, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const editable = [
    'enabled', 'trigger', 'rewardId', 'rewardTitle', 'min', 'max', 'tier', 'source',
    'command', 'who', 'cooldownMs', 'cooldownPerUser', 'steps', 'repeat',
  ];
  const next = { ...rule };
  for (const field of editable) {
    if (Object.prototype.hasOwnProperty.call(p, field)) next[field] = p[field];
  }
  // Atalho para o caso comum, que é o de quase toda regra: uma combinação só.
  // `keys` (com holdMs/gapMs opcionais) troca a sequência inteira por um passo.
  // Com dois ou mais passos, a sequência só muda mandando `steps` inteiro, para
  // um "segurar" solto não apagar o resto sem querer.
  const shortcut = ['keys', 'holdMs', 'gapMs'].some((f) =>
    Object.prototype.hasOwnProperty.call(p, f)
  );
  if (!('steps' in p) && shortcut && rule.steps.length <= 1) {
    const base = rule.steps[0] && rule.steps[0].kind === 'keys' ? rule.steps[0] : {};
    next.steps = [
      {
        kind: 'keys',
        keys: 'keys' in p ? p.keys : base.keys,
        holdMs: 'holdMs' in p ? p.holdMs : base.holdMs,
        gapMs: 'gapMs' in p ? p.gapMs : base.gapMs,
      },
    ];
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
  if (!rule.enabled || rule.steps.length === 0) return false;
  if (rule.trigger === 'reward') return rule.rewardId !== '';
  if (rule.trigger === 'command') return rule.command !== '';
  return true;
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
  if (event.kind === 'command') {
    const level = Number(event.level) || 0;
    return candidates.filter((r) => r.command === event.command && CHATTER_LEVEL[r.who] <= level);
  }
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
const WHO_LABELS = { all: 'todos', sub: 'subs', vip: 'VIPs', mod: 'mods' };
const SOURCE_LABELS = {
  any: 'qualquer serviço',
  streamelements: 'StreamElements',
  streamlabs: 'Streamlabs',
  livepix: 'LivePix',
  pixgg: 'PixGG',
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
    case 'command':
      return `Comando ${rule.command || '(sem comando)'} (${WHO_LABELS[rule.who]})`;
    default:
      return rule.rewardTitle || 'Recompensa';
  }
}

function actionOf(rule) {
  return { steps: rule.steps, repeat: rule.repeat };
}

/** As teclas de todos os passos, na ordem — para a tela e o registro. */
function keysOf(rule) {
  return rule.steps.filter((s) => s.kind === 'keys').flatMap((s) => s.keys);
}

module.exports = {
  STEP_KINDS,
  STEP_TEXT_MAX,
  MAX_STEPS,
  normalizeStep,
  normalizeSteps,
  keysOf,
  TRIGGERS,
  TIERS,
  CHATTERS,
  CHATTER_LEVEL,
  WHO_LABELS,
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
