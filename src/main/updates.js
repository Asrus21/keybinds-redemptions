// Aviso de versão nova: pergunta ao GitHub qual é o release mais recente e
// compara com a versão instalada. Não baixa nem instala nada — só mostra o
// aviso com o link do release, e o streamer decide quando atualizar.

const LATEST_URL = 'https://api.github.com/repos/Asrus21/keybinds-redemptions/releases/latest';

/** "v1.2.3" ou "1.2.3" → [1, 2, 3]; null se não for uma versão. */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** true se `a` é mais nova que `b`. */
function isNewer(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] > vb[i];
  }
  return false;
}

/**
 * Devolve { version, url } se houver release mais novo que `currentVersion`,
 * senão null. Erro de rede vira null também: aviso de atualização nunca pode
 * atrapalhar a live.
 */
async function checkForUpdate({ currentVersion, fetch = globalThis.fetch, url = LATEST_URL }) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'keybinds-redemptions' },
    });
    if (!res.ok) return null;
    const release = await res.json();
    if (!release || release.draft || release.prerelease) return null;
    const version = String(release.tag_name || '').replace(/^v/, '');
    const link = String(release.html_url || '');
    if (!isNewer(version, currentVersion)) return null;
    if (!link.startsWith('https://github.com/')) return null;
    return { version, url: link };
  } catch {
    return null;
  }
}

module.exports = { checkForUpdate, isNewer, parseVersion, LATEST_URL };
