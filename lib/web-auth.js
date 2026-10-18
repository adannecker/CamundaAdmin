const crypto = require('node:crypto');

// Only the authentication gate can mark a request as a verified remote write.
const verifiedWrites = new WeakSet();
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const random = () => crypto.randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function settings(env = process.env) {
  const mode = env.AUTH_MODE || 'local';
  const basePath = env.BASE_PATH || '';
  if (basePath && !/^\/[a-z0-9-]+$/.test(basePath)) throw new Error('BASE_PATH ist ungültig.');
  if (mode === 'local') {
    if (!['127.0.0.1', '::1', 'localhost'].includes(env.HOST || '127.0.0.1')) throw new Error('Ohne OIDC ist nur eine lokale Bindung erlaubt.');
    return { mode, basePath };
  }
  if (mode !== 'oidc') throw new Error('AUTH_MODE muss local oder oidc sein.');
  for (const key of ['PUBLIC_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_OWNER_SUB', 'OIDC_OWNER_EMAIL']) {
    if (!env[key]?.trim()) throw new Error(`${key} fehlt. OIDC-Start abgebrochen.`);
  }
  const publicUrl = new URL(env.PUBLIC_URL);
  const issuer = new URL(env.OIDC_ISSUER);
  if (publicUrl.protocol !== 'https:' || issuer.protocol !== 'https:' || publicUrl.username || publicUrl.password || issuer.username || issuer.password || publicUrl.search || publicUrl.hash || issuer.search || issuer.hash) throw new Error('OIDC und PUBLIC_URL benötigen feste HTTPS-Adressen.');
  if (publicUrl.pathname.replace(/\/$/, '') !== basePath) throw new Error('PUBLIC_URL und BASE_PATH passen nicht zusammen.');
  return { mode, basePath, origin: publicUrl.origin, host: publicUrl.host, issuer: issuer.href.replace(/\/$/, ''), clientId: env.OIDC_CLIENT_ID,
    secret: env.OIDC_CLIENT_SECRET, ownerSub: env.OIDC_OWNER_SUB, ownerEmail: env.OIDC_OWNER_EMAIL.trim().toLowerCase(), provider: 'switch-eduid',
    callback: `${publicUrl.origin}${basePath}/auth/callback` };
}

function allowedOwner(claims, config) {
  return claims.iss === config.issuer && claims.sub === config.ownerSub && claims.email_verified === true
    && typeof claims.email === 'string' && claims.email.toLowerCase() === config.ownerEmail && claims.identity_provider === config.provider;
}

async function createWebAuth(env = process.env, dependencies = {}) {
  const config = settings(env);
  const now = dependencies.now || Date.now;
  const sessions = new Map(), transactions = new Map();
  let oidc, client;
  if (config.mode === 'oidc') {
    oidc = dependencies.oidc || await import('openid-client');
    client = await oidc.discovery(new URL(config.issuer), config.clientId, config.secret);
    oidc.enableNonRepudiationChecks(client);
  }
  const cookieName = '__Secure-camundaadmin', transactionName = '__Secure-camundaadmin-login';
  function cookie(name, value, seconds) {
    return `${name}=${value}; Path=${config.basePath || '/'}; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
  }
  function cookies(request) {
    return Object.fromEntries(String(request.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(part => part.length === 2));
  }
  function json(response, status, data) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
  function redirect(response, location) { response.writeHead(303, { location }); response.end(); }
  function message(response, status, title, detail) {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Camunda Admin</title><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><a href="${config.basePath}/auth/login">Mit AAI anmelden</a></body></html>`);
  }
  const prune = map => { for (const [id, item] of map) if (item.expires <= now()) map.delete(id); };

  async function authorize(request, response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const raw = request.url || '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u0020]/.test(raw)) { json(response, 400, { error: 'Ungültiger Pfad.' }); return null; }
    const url = new URL(raw, 'http://internal.invalid');
    if (config.basePath && url.pathname === config.basePath) { redirect(response, `${config.basePath}/`); return null; }
    if (!url.pathname.startsWith(`${config.basePath}/`)) { json(response, 404, { error: 'Nicht gefunden.' }); return null; }
    url.pathname = url.pathname.slice(config.basePath.length);
    if (request.method === 'GET' && url.pathname === '/healthz') { json(response, 200, { ok: true }); return null; }
    if (config.mode === 'local') {
      const host = request.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) || (!safeMethods.has(request.method) && request.headers.origin && request.headers.origin !== `http://${host}`)) { json(response, 403, { error: 'Nur lokaler Zugriff erlaubt.' }); return null; }
      if (url.pathname === '/api/session') { json(response, 200, { mode: 'local', basePath: config.basePath }); return null; }
      return { url, session: null };
    }
    if (request.headers.host !== config.host) { json(response, 400, { error: 'Unbekannter Host.' }); return null; }
    prune(sessions); prune(transactions);
    const incoming = cookies(request);
    if (request.method === 'GET' && url.pathname === '/auth/login') {
      if (transactions.size >= 500) { message(response, 503, 'Bitte später erneut versuchen', 'Zu viele laufende Anmeldungen.'); return null; }
      const id = random(), state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      transactions.set(id, { state, nonce, verifier, expires: now() + 300000 });
      response.setHeader('set-cookie', cookie(transactionName, id, 300));
      const target = oidc.buildAuthorizationUrl(client, { redirect_uri: config.callback, scope: 'openid email profile', response_mode: 'query',
        state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', kc_idp_hint: config.provider });
      redirect(response, target.href); return null;
    }
    if (request.method === 'GET' && url.pathname === '/auth/callback') {
      const transactionId = incoming[transactionName], tx = transactions.get(transactionId);
      transactions.delete(transactionId);
      response.setHeader('set-cookie', cookie(transactionName, '', 0));
      if (!tx || !equal(url.searchParams.get('state'), tx.state)) { message(response, 400, 'Anmeldung abgelaufen', 'Bitte die Anmeldung erneut beginnen.'); return null; }
      try {
        const tokens = await oidc.authorizationCodeGrant(client, new URL(config.callback + url.search), { pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true });
        const claims = tokens.claims();
        if (!claims || !allowedOwner(claims, config)) { message(response, 403, 'Kein Zugriff', 'Dieses AAI-Konto ist für Camunda Admin nicht freigegeben.'); return null; }
        if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now() || sessions.size >= 100) throw new Error('Session refused');
        const expires = now() + 3600000;
        sessions.delete(incoming[cookieName]);
        const id = random();
        sessions.set(id, { expires, csrf: random(), user: { email: config.ownerEmail, name: String(claims.name || config.ownerEmail), role: 'owner' } });
        response.setHeader('set-cookie', [cookie(transactionName, '', 0), cookie(cookieName, id, Math.floor((expires - now()) / 1000))]);
        redirect(response, `${config.basePath}/`);
      } catch (error) { dependencies.onError?.(error); message(response, 400, 'Anmeldung fehlgeschlagen', 'Die Anmeldeantwort konnte nicht bestätigt werden. Bitte erneut anmelden.'); }
      return null;
    }
    if (request.method === 'GET' && url.pathname === '/auth/signed-out') { message(response, 200, 'Abgemeldet', 'Die Sitzung in Camunda Admin wurde beendet.'); return null; }
    const session = sessions.get(incoming[cookieName]);
    if (!session) {
      if (url.pathname.startsWith('/api/') || !['/', '/index.html'].includes(url.pathname)) json(response, 401, { error: 'Bitte mit AAI anmelden.', loginUrl: `${config.basePath}/auth/login` });
      else redirect(response, `${config.basePath}/auth/login`);
      return null;
    }
    if (!safeMethods.has(request.method)) {
      if (request.headers.origin !== config.origin || !equal(request.headers['x-csrf-token'], session.csrf) || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) { json(response, 403, { error: 'Die Anfrage konnte nicht bestätigt werden. Bitte Seite neu laden.' }); return null; }
      verifiedWrites.add(request);
    }
    if (request.method === 'POST' && url.pathname === '/auth/logout') {
      sessions.delete(incoming[cookieName]); response.setHeader('set-cookie', cookie(cookieName, '', 0));
      json(response, 200, { redirect: `${config.basePath}/auth/signed-out` }); return null;
    }
    if (request.method === 'GET' && url.pathname === '/api/session') { json(response, 200, { mode: 'oidc', basePath: config.basePath, user: session.user, csrf: session.csrf }); return null; }
    return { url, session };
  }
  function render(html, session) {
    const metadata = `<meta name="app-base" content="${escapeHtml(config.basePath)}"><meta name="app-csrf" content="${escapeHtml(session?.csrf || '')}">`;
    return html.replace('</head>', metadata + '</head>').replace(/(src|href)="\/(?!\/)/g, `$1="${config.basePath}/`);
  }
  return { authorize, render, config };
}

module.exports = { createWebAuth, settings, allowedOwner, isVerifiedWrite: request => verifiedWrites.has(request) };
