// Tela do app. Não tem acesso a Node: tudo passa por `window.kr` (preload.js).
//
// Regra de ouro daqui: texto que vem da Twitch (nome de quem resgatou, título
// da recompensa) só entra na tela por textContent — nunca como HTML.

'use strict';

const { KEYS, GROUPS, isKnownKey, normalizeCombo, labelOf } = window.KeyTable;

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Propriedades que vão direto no elemento (o resto vira atributo).
const PROPS = new Set(['checked', 'value', 'disabled', 'hidden', 'min', 'max', 'step', 'type']);

/** Cria um elemento: h('button', { class: 'btn', onclick }, 'texto'). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function chips(codes, big = false) {
  const wrap = h('span', { class: big ? 'chips big' : 'chips' });
  codes.forEach((code, i) => {
    if (i > 0) wrap.append(h('span', { class: 'plus' }, '+'));
    wrap.append(h('kbd', null, labelOf(code)));
  });
  return wrap;
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

/** Chama o processo principal; erro vira aviso rápido em vez de estourar. */
async function act(method, ...args) {
  try {
    return await window.kr.call(method, ...args);
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

let state = null;
let version = '';

// ------------------------------------------------------------------ topo

function renderTop() {
  const pill = $('#conn-pill');
  let pillState = state.connection;
  let text = {
    online: 'Escutando eventos',
    connecting: 'Conectando…',
    reconnecting: 'Reconectando…',
    offline: state.auth === 'signed-in' ? 'Sem conexão' : 'Desconectado',
  }[state.connection] || state.connection;
  if (state.paused) {
    pillState = 'paused';
    text = 'Pausado';
  }
  pill.dataset.state = pillState;
  pill.querySelector('b').textContent = text;
  pill.title = state.connectionDetail || '';

  const pause = $('#pause-btn');
  pause.textContent = state.paused ? 'Retomar' : 'Pausar';
  pause.classList.toggle('paused', state.paused);

  $('#notice').hidden = !state.notice;
  $('#notice-text').textContent = state.notice;
  $('#paused-banner').hidden = !state.paused;

  // Enquanto baixa, nada de aviso: ele só aparece quando dá para reiniciar
  // (ou, sem atualização automática, com o link da release).
  const up = state.update;
  const ready = !!up && up.stage === 'ready';
  $('#update-banner').hidden = !up || up.stage === 'downloading';
  $('#update-text').textContent = !up
    ? ''
    : ready
      ? `A versão ${up.version} já foi baixada. Reinicie o app para concluir a instalação.`
      : `Nova versão ${up.version} disponível (você está na ${version}).`;
  $('#update-open').textContent = ready ? 'Reiniciar agora' : 'Baixar';
  $('#update-dismiss').textContent = ready ? 'Depois' : 'Agora não';
  $('#update-dismiss').title = ready ? 'A atualização é instalada quando você fechar o app.' : '';

  const sim = $('#sim-banner');
  sim.hidden = !state.keyboard.simulated;
  sim.textContent = state.keyboard.simulated
    ? `Modo simulação — ${state.keyboard.name}. Nenhuma tecla é apertada de verdade; as ações só aparecem na atividade.`
    : '';

  $('#queue-count').textContent = state.queue > 0 ? `${state.queue} na fila` : '';
}

// ------------------------------------------------------------------ conta

let editingClientId = false;
let accountKey = '';

function renderAccount() {
  const key = JSON.stringify([
    state.auth,
    state.device,
    state.account,
    state.connection,
    state.connectionDetail,
    state.clientId,
    state.clientIdLocked,
    editingClientId,
  ]);
  if (key === accountKey) return; // não apaga o campo enquanto o streamer digita
  accountKey = key;

  const card = $('#account-card');
  card.replaceChildren(...accountView().filter(Boolean));
}

function accountView() {
  if (state.auth === 'signed-out' && (!state.clientId || editingClientId)) return clientIdView();

  if (state.auth === 'signed-out') {
    return [
      h('h2', null, 'Conta da Twitch'),
      h('p', { class: 'hint' }, 'Entre com a conta do canal que recebe os resgates.'),
      h('button', { class: 'btn twitch', type: 'button', onclick: () => act('login') }, 'Entrar com a Twitch'),
      h(
        'p',
        { class: 'meta' },
        `Client ID: ${state.clientId.slice(0, 6)}…${state.clientId.slice(-4)}`,
        state.clientIdLocked
          ? ' (fixado por TWITCH_CLIENT_ID)'
          : [
              ' · ',
              h('button', { class: 'link', type: 'button', onclick: () => ((editingClientId = true), renderAccount()) }, 'trocar'),
            ]
      ),
    ];
  }

  if (state.auth === 'signing-in') {
    if (!state.device) {
      return [
        h('h2', null, 'Entrando…'),
        h('p', { class: 'hint' }, 'Pedindo um código para a Twitch…'),
        h('button', { class: 'btn', type: 'button', onclick: () => act('cancelLogin') }, 'Cancelar'),
      ];
    }
    return [
      h('h2', null, 'Autorize na Twitch'),
      h(
        'p',
        { class: 'hint' },
        'Abrimos a página twitch.tv/activate no navegador. Confira se o código é este e clique em “Autorizar”:'
      ),
      h('div', { class: 'code-box' }, h('span', { class: 'code' }, state.device.userCode)),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn twitch', type: 'button', onclick: () => act('openActivation') }, 'Abrir a página de novo'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => act('cancelLogin') }, 'Cancelar')
      ),
      h('p', { class: 'hint small' }, 'Esta tela continua sozinha assim que você autorizar.'),
    ];
  }

  // signed-in
  const a = state.account;
  const status = {
    online: 'Escutando resgates, bits e subs do canal.',
    connecting: 'Conectando à Twitch…',
    reconnecting: state.connectionDetail || 'Reconectando…',
    offline: state.connectionDetail || 'Sem conexão com a Twitch.',
  }[state.connection];
  return [
    h('h2', null, 'Conta da Twitch'),
    a
      ? h(
          'div',
          { class: 'user' },
          a.avatar
            ? h('img', { src: a.avatar, alt: '' })
            : h('div', { class: 'avatar-fallback' }, (a.displayName || '?').slice(0, 1).toUpperCase()),
          h('div', null, h('div', { class: 'name' }, a.displayName), h('div', { class: 'login' }, `twitch.tv/${a.login}`))
        )
      : h('p', { class: 'hint' }, 'Recuperando a sua conta…'),
    h('p', { class: state.connection === 'offline' ? 'hint bad' : 'hint' }, status),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () => act('logout') }, 'Sair')),
  ];
}

function clientIdView() {
  const input = h('input', {
    class: 'input mono',
    id: 'client-id-input',
    value: state.clientId,
    placeholder: 'ex.: abc123def456…',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const save = async () => {
    const saved = await act('setClientId', input.value);
    if (saved === undefined) return; // erro: o aviso já apareceu
    editingClientId = false;
    accountKey = '';
    renderAccount();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  const devLink = h(
    'a',
    { href: '#', onclick: (e) => (e.preventDefault(), act('openExternal', 'https://dev.twitch.tv/console/apps/create')) },
    'dev.twitch.tv/console/apps'
  );
  return [
    h('h2', null, 'Conectar à Twitch'),
    h('p', { class: 'hint' }, 'Só na primeira vez: o app precisa de um “Client ID” seu da Twitch.'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'Entre em ', devLink, ' e registre um aplicativo (qualquer nome).'),
      h('li', null, 'Em ', h('strong', null, 'OAuth Redirect URLs'), ' coloque ', h('code', null, 'http://localhost'), '.'),
      h('li', null, 'Em ', h('strong', null, 'Client Type'), ' escolha ', h('strong', null, 'Public'), '.'),
      h('li', null, 'Crie, clique em ', h('strong', null, 'Manage'), ', copie o ', h('strong', null, 'Client ID'), ' e cole aqui:')
    ),
    h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Salvar')),
    editingClientId && state.clientId
      ? h(
          'button',
          { class: 'link', type: 'button', onclick: () => ((editingClientId = false), renderAccount()) },
          'cancelar'
        )
      : null,
  ];
}

// ------------------------------------------------------------------ regras

const ruleEls = new Map();

function rewardById(id) {
  return state.rewards.find((r) => r.id === id);
}

function renderRewardsStatus() {
  const el = $('#rewards-status');
  el.classList.remove('bad');
  let text = '';
  if (state.auth !== 'signed-in') text = 'Entre com a Twitch para listar as recompensas do canal.';
  else if (state.rewardsStatus === 'loading') text = 'Buscando recompensas…';
  else if (state.rewardsStatus === 'error') {
    text = state.rewardsError;
    el.classList.add('bad');
  } else if (state.rewardsStatus === 'ok') {
    const n = state.rewards.length;
    text = n
      ? `${n} ${n === 1 ? 'recompensa' : 'recompensas'} de pontos no canal.`
      : 'O canal ainda não tem recompensas personalizadas. Crie no Painel do Criador → Pontos do canal e clique em “Atualizar recompensas”.';
  }
  el.textContent = text;
  $('#refresh-rewards').disabled = state.auth !== 'signed-in' || state.rewardsStatus === 'loading';
}

function renderRules() {
  const list = $('#rules-list');
  const ids = new Set(state.rules.map((r) => r.id));
  for (const [id, els] of ruleEls) {
    if (!ids.has(id)) {
      els.root.remove();
      ruleEls.delete(id);
    }
  }
  state.rules.forEach((rule, index) => {
    let els = ruleEls.get(rule.id);
    if (!els) {
      els = createRuleRow(rule.id);
      ruleEls.set(rule.id, els);
    }
    if (list.children[index] !== els.root) list.insertBefore(els.root, list.children[index] || null);
    updateRuleRow(els, rule);
  });
  $('#rules-empty').hidden = state.rules.length > 0;
}

function numberField(label, suffix, field, id, { min, max }) {
  const input = h('input', { type: 'number', min, max, step: 1 });
  input.addEventListener('change', async () => {
    const rule = await act('updateRule', id, { [field]: Number(input.value) });
    if (rule) input.value = rule[field]; // mostra o valor já corrigido para a faixa
  });
  const wrap = h('label', null, label, input, suffix);
  return { wrap, input };
}

const TRIGGER_OPTIONS = [
  ['reward', 'Recompensa'],
  ['bits', 'Bits'],
  ['sub', 'Sub'],
  ['gift', 'Gift sub'],
  ['donation', 'Doação'],
];
const TIER_OPTIONS = [
  ['any', 'Qualquer tier'],
  ['1000', 'Tier 1'],
  ['2000', 'Tier 2'],
  ['3000', 'Tier 3'],
];
const SOURCE_OPTIONS = [
  ['any', 'Qualquer serviço'],
  ['streamelements', 'StreamElements'],
  ['streamlabs', 'Streamlabs'],
  ['livepix', 'LivePix'],
  ['pixgg', 'PixGG'],
];
// Rótulos da faixa de valor de cada gatilho: [antes do mínimo, unidade].
const RANGE_LABELS = {
  bits: ['a partir de', 'bits'],
  gift: ['a partir de', 'subs'],
  donation: ['de', ''],
};

function optionsOf(pairs) {
  return pairs.map(([value, label]) => h('option', { value }, label));
}

/** Campo "a partir de X até Y" dos gatilhos com valor. */
function rangeField(id) {
  const lead = h('span');
  const min = h('input', { type: 'number', min: 0, class: 'amount', 'aria-label': 'Valor mínimo' });
  const max = h('input', { type: 'number', min: 0, class: 'amount', placeholder: 'sem limite', 'aria-label': 'Valor máximo' });
  const unit = h('span');
  const send = async (field, input) => {
    const rule = await act('updateRule', id, { [field]: input.value === '' ? 0 : input.value });
    if (rule) input.value = rule[field] || (field === 'max' ? '' : rule[field]);
  };
  min.addEventListener('change', () => send('min', min));
  max.addEventListener('change', () => send('max', max));
  const wrap = h('span', { class: 'range' }, lead, min, h('span', null, 'até'), max, unit);
  return { wrap, lead, min, max, unit };
}

function createRuleRow(id) {
  const toggle = h('input', { type: 'checkbox', 'aria-label': 'Regra ativa' });
  toggle.addEventListener('change', () => act('updateRule', id, { enabled: toggle.checked }));

  const trigger = h('select', { class: 'select trigger', 'aria-label': 'Tipo de evento' }, optionsOf(TRIGGER_OPTIONS));
  trigger.addEventListener('change', () => act('updateRule', id, { trigger: trigger.value }));

  // Recompensa
  const icon = h('div', { class: 'reward-icon' });
  const select = h('select', { class: 'select', 'aria-label': 'Recompensa' });
  select.addEventListener('change', () => act('updateRule', id, { rewardId: select.value }));
  const rewardWrap = h('span', { class: 'reward-pick' }, icon, select);

  // Sub
  const tier = h('select', { class: 'select', 'aria-label': 'Tier da sub' }, optionsOf(TIER_OPTIONS));
  tier.addEventListener('change', () => act('updateRule', id, { tier: tier.value }));

  // Doação
  const source = h('select', { class: 'select', 'aria-label': 'Serviço de doação' }, optionsOf(SOURCE_OPTIONS));
  source.addEventListener('change', () => act('updateRule', id, { source: source.value }));

  // Bits, gift e doação
  const range = rangeField(id);

  const detail = h('div', { class: 'trigger-detail' }, rewardWrap, tier, source, range.wrap);

  const keysBtn = h('button', { class: 'keys-btn', type: 'button', title: 'Escolher a tecla', onclick: () => openKeyDialog(id) });

  const hold = numberField('Segurar', 'ms', 'holdMs', id, { min: 10, max: 60000 });
  const repeat = numberField('Repetir', '×', 'repeat', id, { min: 1, max: 100 });
  const gap = numberField('Intervalo', 'ms', 'gapMs', id, { min: 0, max: 10000 });

  const warn = h('span', { class: 'rule-warn' });
  const test = h('button', { class: 'btn small', type: 'button' }, 'Testar');
  test.title = 'Espera 3 segundos (tempo de voltar para o jogo) e aperta a tecla';
  const els = {};
  test.addEventListener('click', () => runTest(id, els));
  const remove = h('button', { class: 'btn small ghost', type: 'button' }, 'Remover');
  remove.addEventListener('click', () => {
    const rule = state.rules.find((r) => r.id === id);
    const configured = rule && (rule.rewardId || rule.keys.length || rule.trigger !== 'reward');
    if (configured && !window.confirm('Remover esta regra?')) return;
    act('removeRule', id);
  });

  const root = h(
    'div',
    { class: 'rule' },
    h(
      'div',
      { class: 'rule-main' },
      h('label', { class: 'switch', title: 'Ligar/desligar esta regra' }, toggle, h('span')),
      trigger,
      detail,
      h('span', { class: 'arrow' }, '→'),
      keysBtn
    ),
    h('div', { class: 'rule-details' }, hold.wrap, repeat.wrap, gap.wrap, warn, h('span', { class: 'spacer' }), test, remove)
  );
  return Object.assign(els, {
    root,
    toggle,
    trigger,
    icon,
    select,
    rewardWrap,
    tier,
    source,
    range,
    keysBtn,
    hold,
    repeat,
    gap,
    warn,
    test,
    rewardsKey: '',
    testing: false,
  });
}

function setIfIdle(el, value) {
  if (document.activeElement !== el) el.value = value;
}

function updateRuleRow(els, rule) {
  els.root.classList.toggle('off', !rule.enabled);
  els.root.dataset.trigger = rule.trigger; // cor da faixa do tipo de evento
  els.toggle.checked = rule.enabled;
  setIfIdle(els.trigger, rule.trigger);

  const t = rule.trigger;
  els.rewardWrap.hidden = t !== 'reward';
  els.tier.hidden = t !== 'sub';
  els.source.hidden = t !== 'donation';
  els.range.wrap.hidden = !RANGE_LABELS[t];

  if (t === 'reward') updateRewardPick(els, rule);
  setIfIdle(els.tier, rule.tier);
  setIfIdle(els.source, rule.source);
  if (RANGE_LABELS[t]) {
    const [lead, unit] = RANGE_LABELS[t];
    els.range.lead.textContent = lead;
    els.range.unit.textContent = unit;
    const step = t === 'donation' ? '0.01' : '1';
    els.range.min.step = step;
    els.range.max.step = step;
    setIfIdle(els.range.min, rule.min);
    setIfIdle(els.range.max, rule.max || '');
  }

  els.keysBtn.replaceChildren(
    rule.keys.length ? chips(rule.keys) : h('span', { class: 'placeholder' }, 'Escolher tecla…')
  );

  for (const [f, field] of [
    ['holdMs', els.hold],
    ['repeat', els.repeat],
    ['gapMs', els.gap],
  ]) {
    setIfIdle(field.input, rule[f]);
  }
  // Intervalo só faz sentido quando repete.
  els.gap.wrap.hidden = rule.repeat <= 1;

  const missing = [t === 'reward' && !rule.rewardId && 'a recompensa', !rule.keys.length && 'a tecla'].filter(Boolean);
  els.warn.textContent = missing.length ? `Falta escolher ${missing.join(' e ')}.` : '';
  if (!els.testing) els.test.disabled = !rule.keys.length;
}

function updateRewardPick(els, rule) {
  // Opções da lista: só refaz quando as recompensas (ou a escolhida) mudam.
  const rewardsKey = JSON.stringify([state.rewards, rule.rewardId, rule.rewardTitle]);
  if (rewardsKey !== els.rewardsKey) {
    els.rewardsKey = rewardsKey;
    const options = [h('option', { value: '' }, 'Escolha a recompensa…')];
    for (const r of state.rewards) {
      const flags = [!r.enabled && 'desativada', r.paused && 'pausada'].filter(Boolean).join(', ');
      options.push(
        h('option', { value: r.id }, `${r.title} — ${r.cost.toLocaleString('pt-BR')} pts${flags ? ` (${flags})` : ''}`)
      );
    }
    if (rule.rewardId && !rewardById(rule.rewardId)) {
      const why = state.rewardsStatus === 'ok' ? 'não existe mais no canal' : 'salva';
      options.push(h('option', { value: rule.rewardId }, `${rule.rewardTitle || 'Recompensa'} (${why})`));
    }
    els.select.replaceChildren(...options);
    els.select.value = rule.rewardId;
  }
  setIfIdle(els.select, rule.rewardId);

  const reward = rewardById(rule.rewardId);
  els.icon.style.background = reward && reward.color ? reward.color : '';
  els.icon.replaceChildren(reward && reward.image ? h('img', { src: reward.image, alt: '' }) : '');
}

async function runTest(id, els) {
  if (els.testing) return;
  els.testing = true;
  els.test.disabled = true;
  let finished = false;
  const done = act('testRule', id).finally(() => (finished = true));
  // Para a contagem na hora se o "Parar tudo" cancelar o teste.
  for (let n = 3; n > 0 && !finished; n--) {
    els.test.textContent = `Volte para o jogo… ${n}`;
    await Promise.race([sleep(1000), done]);
  }
  if (!finished) els.test.textContent = 'Apertando…';
  await done;
  els.testing = false;
  els.test.textContent = 'Testar';
  const rule = state.rules.find((r) => r.id === id);
  els.test.disabled = !rule || !rule.keys.length;
}

function flashRule(ruleId) {
  const els = ruleEls.get(ruleId);
  if (!els) return;
  els.root.classList.add('flash');
  setTimeout(() => els.root.classList.remove('flash'), 1200);
}

// ------------------------------------------------------------------ diálogo da tecla

const dialog = $('#key-dialog');
const capture = $('#capture');
let dialogRuleId = null;
let combo = [];
const pressed = new Set();

function fillKeySelect() {
  const select = $('#key-select');
  for (const [group, label] of GROUPS) {
    const og = h('optgroup', { label });
    for (const [code, key] of Object.entries(KEYS)) {
      if (key.group === group) og.append(h('option', { value: code }, key.label));
    }
    select.append(og);
  }
  select.value = 'F13';
}

function renderCombo(message) {
  $('#capture-keys').replaceChildren(combo.length ? chips(combo, true) : '');
  $('#capture-hint').textContent =
    message || (combo.length ? 'Solte e clique em “Salvar” — ou aperte outra combinação.' : 'Aperte a tecla ou a combinação agora (ex.: Ctrl + G)');
}

function openKeyDialog(id) {
  const rule = state.rules.find((r) => r.id === id);
  if (!rule) return;
  dialogRuleId = id;
  combo = [...rule.keys];
  pressed.clear();
  $('#key-dialog-reward').textContent = rule.rewardTitle
    ? `Quando alguém resgatar “${rule.rewardTitle}”.`
    : 'Escolha a tecla que esta regra vai apertar.';
  renderCombo();
  dialog.showModal();
  capture.focus();
}

capture.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') return; // deixa o Esc fechar o diálogo
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  if (pressed.size === 0) combo = []; // primeira tecla de uma combinação nova
  pressed.add(e.code);
  if (isKnownKey(e.code)) {
    combo = normalizeCombo([...combo, e.code]);
    renderCombo();
  } else {
    renderCombo(`Essa tecla (${e.code || e.key}) não é suportada — escolha outra ou use a lista.`);
  }
});

capture.addEventListener('keyup', (e) => {
  if (e.code === 'Escape') return;
  e.preventDefault();
  // Print Screen só gera keyup no Windows.
  if (!pressed.has(e.code) && pressed.size === 0 && isKnownKey(e.code)) {
    combo = [e.code];
    renderCombo();
  }
  pressed.delete(e.code);
});

capture.addEventListener('blur', () => pressed.clear());
capture.addEventListener('click', () => capture.focus());

$('#key-add').addEventListener('click', () => {
  combo = normalizeCombo([...combo, $('#key-select').value]);
  renderCombo();
});
$('#key-clear').addEventListener('click', () => {
  combo = [];
  renderCombo();
  capture.focus();
});
$('#key-cancel').addEventListener('click', () => dialog.close());
$('#key-save').addEventListener('click', async () => {
  const id = dialogRuleId;
  dialog.close();
  if (id) await act('updateRule', id, { keys: combo });
});

// ------------------------------------------------------------------ atividade

const logEls = new Map();
const LOG_MAX = 200;
const OUTCOMES = {
  queued: ['queued', 'na fila'],
  done: ['done', 'apertou'],
  error: ['error', 'falhou'],
  aborted: ['aborted', 'interrompido'],
  paused: ['paused', 'pausado'],
  ignored: ['', 'sem regra'],
};

function timeOf(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fillLogItem(li, entry) {
  li.className = entry.kind;
  if (entry.trigger) li.dataset.trigger = entry.trigger;
  const what = h('div', { class: 'what' });
  if (entry.kind === 'event' || entry.kind === 'test') {
    if (entry.kind === 'event') {
      what.append(h('strong', null, entry.user), ` ${entry.action} `, h('span', { class: 'reward' }, entry.target));
      if (entry.via) what.append(h('span', { class: 'via' }, entry.via));
    } else {
      what.append('Teste — ', h('span', { class: 'reward' }, entry.target));
    }
    if (entry.keys && entry.keys.length) what.append(h('span', { class: 'plus' }, '→'), chips(entry.keys));
    if (entry.error) what.append(h('span', { class: 'hint bad' }, entry.error));
  } else {
    what.append(entry.text);
  }
  const [cls, label] = OUTCOMES[entry.outcome] || ['', ''];
  li.replaceChildren(
    h('time', null, timeOf(entry.at)),
    what,
    label ? h('span', { class: `badge ${cls}`, title: entry.error || '' }, label) : h('span')
  );
}

function upsertLog(entry, { initial = false } = {}) {
  const list = $('#log-list');
  let li = logEls.get(entry.id);
  if (!li) {
    li = h('li');
    logEls.set(entry.id, li);
    if (initial) list.append(li);
    else {
      list.prepend(li);
      if (entry.ruleId && entry.outcome === 'queued') flashRule(entry.ruleId);
    }
    while (list.children.length > LOG_MAX) {
      const last = list.lastElementChild;
      for (const [id, el] of logEls) if (el === last) logEls.delete(id);
      last.remove();
    }
  }
  fillLogItem(li, entry);
  $('#log-empty').hidden = list.children.length > 0;
}

// ------------------------------------------------------------------ doações

const STATE_LABELS = {
  online: 'conectado',
  connecting: 'conectando…',
  reconnecting: 'reconectando…',
  error: 'erro',
  offline: 'desconectado',
};
let donationsKey = '';
const openSources = new Set();

function renderDonations() {
  // Não refaz enquanto o streamer digita um token.
  const key = JSON.stringify([state.donations, [...openSources]]);
  if (key === donationsKey) return;
  // Só campo editável conta como "digitando". Botão clicado (Desconectar,
  // Copiar…) também fica com o foco, e antes isso segurava a tela até o
  // streamer clicar em outro lugar.
  const active = document.activeElement;
  const typing = active && active.matches && active.matches('#donations-list input:not([readonly])');
  if (typing) return;
  donationsKey = key;
  $('#donations-list').replaceChildren(...state.donations.map(sourceView));
}

function sourceView(src) {
  const pillState = src.state === 'error' ? 'error' : src.configured ? src.state : 'offline';
  const head = h(
    'div',
    { class: 'source-head' },
    h('strong', null, src.label),
    h('span', { class: 'pill small', 'data-state': pillState }, h('i'), h('b', null, src.configured ? STATE_LABELS[src.state] || src.state : 'não configurado'))
  );
  const children = [head];
  if (src.detail) children.push(h('p', { class: src.state === 'error' ? 'hint bad' : 'hint' }, src.detail));
  if (src.webhookUrl) {
    const url = h('input', { class: 'input mono', readonly: true, value: src.webhookUrl, 'aria-label': 'URL de webhook' });
    url.addEventListener('focus', () => url.select());
    const copy = h('button', { class: 'btn small', type: 'button' }, 'Copiar');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(src.webhookUrl);
        copy.textContent = 'Copiado!';
      } catch {
        url.select();
        copy.textContent = 'Ctrl+C para copiar';
      }
      setTimeout(() => (copy.textContent = 'Copiar'), 2000);
    });
    children.push(h('p', { class: 'hint small' }, 'URL de webhook desta conexão:'), h('div', { class: 'field-row' }, url, copy));
  }

  const editing = openSources.has(src.name) || !src.configured;
  if (src.configured && !openSources.has(src.name)) {
    children.push(
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => (openSources.add(src.name), (donationsKey = ''), renderDonations()) }, 'Trocar token'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => act('disconnectDonation', src.name) }, 'Desconectar')
      )
    );
  } else if (editing) {
    const inputs = src.fields.map((f) =>
      h('input', { class: 'input mono', type: 'password', placeholder: f.label, 'aria-label': f.label, autocomplete: 'off', spellcheck: 'false' })
    );
    const save = async () => {
      const creds = {};
      src.fields.forEach((f, i) => (creds[f.key] = inputs[i].value));
      if (!(await act('connectDonation', src.name, creds))) return; // erro: o aviso já apareceu
      openSources.delete(src.name);
      document.activeElement.blur();
      donationsKey = '';
      renderDonations();
    };
    for (const input of inputs) input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    children.push(
      h('div', { class: 'source-fields' }, inputs),
      h('p', { class: 'hint small' }, `Onde achar: ${src.help}`),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn small primary', type: 'button', onclick: save }, 'Conectar'),
        src.configured
          ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => (openSources.delete(src.name), (donationsKey = ''), renderDonations()) }, 'Cancelar')
          : null
      )
    );
  }
  return h('details', { class: 'source', open: src.configured || openSources.has(src.name) ? true : null }, h('summary', null, head), ...children.slice(1));
}

// ------------------------------------------------------------------ preferências

function renderSettings() {
  $('#set-tray').checked = !!state.settings.closeToTray;
  $('#set-login').checked = !!state.settings.openAtLogin;
  const up = state.update;
  const downloading = up && up.stage === 'downloading' ? ` · Baixando a ${up.version}… ${up.percent || 0}%` : '';
  $('#meta-line').textContent = `Versão ${version}${downloading} · Teclas: ${state.keyboard.name}`;
}

$('#set-tray').addEventListener('change', (e) => act('updateSettings', { closeToTray: e.target.checked }));
$('#set-login').addEventListener('change', (e) => act('updateSettings', { openAtLogin: e.target.checked }));

// ------------------------------------------------------------------ ligação

$('#pause-btn').addEventListener('click', () => act('setPaused', !state.paused));
$('#stop-btn').addEventListener('click', async () => {
  const n = await act('stopAll');
  if (n === undefined) return;
  toast(n ? `Parado: ${n} ${n === 1 ? 'ação interrompida' : 'ações interrompidas'}. Teclas soltas.` : 'Nada estava rodando. Teclas soltas por garantia.');
});
$('#notice-close').addEventListener('click', () => act('dismissNotice'));
$('#update-open').addEventListener('click', () =>
  act(state.update && state.update.stage === 'ready' ? 'installUpdate' : 'openUpdate')
);
$('#update-dismiss').addEventListener('click', () => act('dismissUpdate'));
$('#refresh-rewards').addEventListener('click', () => act('refreshRewards'));
$('#add-rule').addEventListener('click', async () => {
  const rule = await act('addRule');
  if (rule) {
    await sleep(0);
    const els = ruleEls.get(rule.id);
    if (els) {
      els.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      els.select.focus();
    }
  }
});

function render(next) {
  state = next;
  renderTop();
  renderAccount();
  renderRewardsStatus();
  renderRules();
  renderDonations();
  renderSettings();
}

async function boot() {
  fillKeySelect();
  window.kr.onState(render);
  window.kr.onLog((entry) => upsertLog(entry));
  version = await act('getVersion');
  render(await act('getState'));
  const log = (await act('getLog')) || [];
  for (const entry of log) upsertLog(entry, { initial: true });
  $('#log-empty').hidden = log.length > 0;
}

boot();
