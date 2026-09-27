// Login na Twitch pelo "Device Code Flow" — o mesmo da TV e do console:
//
//   1. o app pede um código (POST /oauth2/device);
//   2. o streamer abre twitch.tv/activate, confere o código e autoriza;
//   3. enquanto isso o app pergunta de tempos em tempos se já liberou.
//
// Por que esse fluxo: app desktop não consegue guardar segredo (qualquer um
// abre o .exe e lê), e este fluxo não precisa de client secret nem de servidor
// para receber o redirect. Para funcionar, o app cadastrado em
// dev.twitch.tv/console/apps tem que ser do tipo "Público".
//
// Detalhe de app público: o refresh token é de uso único (cada renovação
// devolve um novo, que precisa ser salvo) e vence depois de 30 dias parado.

const ID_BASE = 'https://id.twitch.tv/oauth2';

// Só leitura: resgates (e a lista de recompensas), bits, subs e as mensagens
// do chat (para as regras de comando). O app não consegue mudar nada no canal
// nem mandar mensagem.
const SCOPES = [
  'channel:read:redemptions',
  'bits:read',
  'channel:read:subscriptions',
  'user:read:chat',
];

class TwitchAuthError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'TwitchAuthError';
    this.status = status;
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function explainClientError(data, status) {
  const msg = String((data && data.message) || '').toLowerCase();
  if (msg.includes('invalid client')) {
    return 'Client ID inválido. Confira o Client ID do seu app em dev.twitch.tv/console/apps.';
  }
  return `A Twitch recusou o pedido (${status}${data && data.message ? `: ${data.message}` : ''}).`;
}

function toTokens(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt: Date.now() + (Number(data.expires_in) || 0) * 1000,
    scopes: Array.isArray(data.scope) ? data.scope : [],
  };
}

/** Passo 1: pede o código que o streamer vai digitar em twitch.tv/activate. */
async function startDeviceFlow({ clientId, scopes = SCOPES, fetch = globalThis.fetch }) {
  const body = new FormData();
  body.set('client_id', clientId);
  body.set('scopes', scopes.join(' '));
  const res = await fetch(`${ID_BASE}/device`, { method: 'POST', body });
  const data = await readJson(res);
  if (!res.ok) throw new TwitchAuthError(explainClientError(data, res.status), res.status);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000,
    interval: Math.max(1, Number(data.interval) || 5),
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new TwitchAuthError('Login cancelado.'));
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new TwitchAuthError('Login cancelado.'));
        },
        { once: true }
      );
    }
  });
}

/** Passo 3: espera o streamer autorizar e devolve os tokens. */
async function pollDeviceToken({
  clientId,
  device,
  scopes = SCOPES,
  signal,
  fetch = globalThis.fetch,
  sleep = wait,
}) {
  let interval = device.interval * 1000;
  while (Date.now() < device.expiresAt) {
    await sleep(interval, signal);
    const body = new FormData();
    body.set('client_id', clientId);
    body.set('scopes', scopes.join(' '));
    body.set('device_code', device.deviceCode);
    body.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    const res = await fetch(`${ID_BASE}/token`, { method: 'POST', body, signal });
    const data = await readJson(res);
    if (res.ok) return toTokens(data);

    const msg = String(data.message || '').toLowerCase();
    if (msg === 'authorization_pending') continue;
    if (msg === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (msg.includes('invalid device code')) {
      throw new TwitchAuthError('O código expirou. Clique em "Entrar com a Twitch" de novo.', res.status);
    }
    if (msg.includes('denied')) {
      throw new TwitchAuthError('Autorização recusada na Twitch.', res.status);
    }
    throw new TwitchAuthError(explainClientError(data, res.status), res.status);
  }
  throw new TwitchAuthError('O código expirou. Clique em "Entrar com a Twitch" de novo.');
}

/** Troca o refresh token por um par novo (o antigo deixa de valer). */
async function refreshTokens({ clientId, refreshToken, fetch = globalThis.fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(`${ID_BASE}/token`, { method: 'POST', body });
  const data = await readJson(res);
  if (!res.ok) {
    throw new TwitchAuthError('A sessão da Twitch expirou. Entre de novo.', res.status);
  }
  return toTokens(data);
}

/**
 * GET /oauth2/validate — a Twitch pede que todo app chame isso ao abrir e de
 * hora em hora. Devolve null se o token não vale mais.
 */
async function validateToken({ accessToken, fetch = globalThis.fetch }) {
  const res = await fetch(`${ID_BASE}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (res.status === 401) return null;
  const data = await readJson(res);
  if (!res.ok) throw new TwitchAuthError(`Falha ao validar o token (${res.status}).`, res.status);
  return {
    clientId: data.client_id,
    login: data.login,
    userId: data.user_id,
    scopes: data.scopes || [],
    expiresIn: data.expires_in,
  };
}

/** Invalida o token na Twitch ao sair. Falha aqui não impede o logout local. */
async function revokeToken({ clientId, token, fetch = globalThis.fetch }) {
  const body = new URLSearchParams({ client_id: clientId, token });
  await fetch(`${ID_BASE}/revoke`, { method: 'POST', body });
}

module.exports = {
  SCOPES,
  TwitchAuthError,
  startDeviceFlow,
  pollDeviceToken,
  refreshTokens,
  validateToken,
  revokeToken,
};
