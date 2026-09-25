// Chamadas à Helix com o token do streamer, renovando quando precisa.
//
// Quem usa só chama `api.helix(...)`: se o token venceu, renova e repete uma
// vez; se nem a renovação funciona, sobe um SessionExpiredError e o app volta
// para a tela de login.

const { refreshTokens, validateToken, TwitchAuthError } = require('./auth');

const HELIX = 'https://api.twitch.tv/helix';
// Renova um pouco antes de vencer, para não cair no meio de uma chamada.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

class SessionExpiredError extends Error {
  constructor(message = 'A sessão da Twitch expirou. Entre de novo.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

class HelixError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HelixError';
    this.status = status;
  }
}

class TwitchApi {
  /**
   * @param {{ clientId: string, tokens: object, onTokens: (t: object) => void, fetch?: typeof fetch }} opts
   *   onTokens é chamado a cada renovação — o refresh token antigo morre na
   *   hora, então o novo PRECISA ser salvo.
   */
  constructor({ clientId, tokens, onTokens, fetch = globalThis.fetch }) {
    this.clientId = clientId;
    this.tokens = tokens;
    this.onTokens = onTokens;
    this.fetch = fetch;
    this.refreshing = null;
  }

  /** Uma renovação por vez: duas chamadas com 401 ao mesmo tempo esperam a mesma. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (!this.tokens.refreshToken) throw new SessionExpiredError();
        try {
          const next = await refreshTokens({
            clientId: this.clientId,
            refreshToken: this.tokens.refreshToken,
            fetch: this.fetch,
          });
          this.tokens = { ...this.tokens, ...next };
          this.onTokens(this.tokens);
          return this.tokens;
        } catch (err) {
          // 400/401 = refresh token recusado. Erro de rede não desloga ninguém.
          if (err instanceof TwitchAuthError && err.status >= 400 && err.status < 500) {
            throw new SessionExpiredError();
          }
          throw err;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async accessToken() {
    if (this.tokens.expiresAt && this.tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  /** Confere o token na Twitch (ao abrir e de hora em hora). */
  async validate() {
    let info = await validateToken({ accessToken: await this.accessToken(), fetch: this.fetch });
    if (!info) {
      await this.refresh();
      info = await validateToken({ accessToken: this.tokens.accessToken, fetch: this.fetch });
      if (!info) throw new SessionExpiredError();
    }
    return info;
  }

  async helix(method, path, { query, body } = {}) {
    const url = new URL(HELIX + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

    const send = async (token) =>
      this.fetch(url, {
        method,
        headers: {
          'Client-Id': this.clientId,
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    let res = await send(await this.accessToken());
    if (res.status === 401) {
      await this.refresh();
      res = await send(this.tokens.accessToken);
      if (res.status === 401) throw new SessionExpiredError();
    }

    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      throw new HelixError(data.message || `Erro ${res.status} da Twitch`, res.status);
    }
    return data;
  }

  async getSelf() {
    const { data } = await this.helix('GET', '/users');
    const u = data && data[0];
    if (!u) throw new HelixError('A Twitch não devolveu o usuário.', 500);
    return {
      id: u.id,
      login: u.login,
      displayName: u.display_name || u.login,
      avatar: u.profile_image_url || '',
      broadcasterType: u.broadcaster_type || '',
    };
  }

  async getRewards(broadcasterId) {
    const { data } = await this.helix('GET', '/channel_points/custom_rewards', {
      query: { broadcaster_id: broadcasterId },
    });
    return (data || [])
      .map((r) => ({
        id: r.id,
        title: r.title,
        cost: r.cost,
        enabled: r.is_enabled !== false,
        paused: !!r.is_paused,
        color: r.background_color || '',
        image: (r.image && r.image.url_2x) || (r.default_image && r.default_image.url_2x) || '',
      }))
      .sort((a, b) => a.cost - b.cost || a.title.localeCompare(b.title));
  }

  /** Liga a sessão da EventSub (WebSocket) aos resgates do canal. */
  async subscribeRedemptions(sessionId, broadcasterId) {
    const { data } = await this.helix('POST', '/eventsub/subscriptions', {
      body: {
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: broadcasterId },
        transport: { method: 'websocket', session_id: sessionId },
      },
    });
    return data && data[0];
  }
}

module.exports = { TwitchApi, HelixError, SessionExpiredError };
