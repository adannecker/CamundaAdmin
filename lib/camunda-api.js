const fs = require('node:fs');
const crypto = require('node:crypto');
// Contexts are rebuilt to observe credential changes. Token reuse must outlive a context.
// Separate fetch implementations keep isolated clients/tests from sharing credentials.
const tokenPools = new WeakMap();
function tokenPool(fetchImpl) { if (!tokenPools.has(fetchImpl)) tokenPools.set(fetchImpl, new Map()); return tokenPools.get(fetchImpl); }

function readCredentials(filename) {
  const values = {};
  for (let line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    line = line.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

class ApiError extends Error {
  constructor(label, status) {
    super(`${label}: HTTP ${status}`);
    this.status = status;
  }
}

class CamundaApi {
  constructor(credentials, { fetchImpl = fetch, freshReads = false, now = Date.now } = {}) {
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.freshReads = freshReads;
    this.now = now;
    this.tokens = tokenPool(fetchImpl);
  }

  async token(runtime = false) {
    const c = this.credentials;
    const clientId = runtime ? c.CAMUNDA_CLIENT_ID || c.ZEEBE_CLIENT_ID : c.CAMUNDA_CONSOLE_CLIENT_ID;
    const clientSecret = runtime ? c.CAMUNDA_CLIENT_SECRET || c.ZEEBE_CLIENT_SECRET : c.CAMUNDA_CONSOLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error(runtime ? 'Runtime-Credentials fehlen (CAMUNDA_CLIENT_ID und CAMUNDA_CLIENT_SECRET).' : 'Administration-Credentials fehlen.');
    const audience = runtime ? c.CAMUNDA_TOKEN_AUDIENCE || c.ZEEBE_TOKEN_AUDIENCE || 'zeebe.camunda.io' : c.CAMUNDA_CONSOLE_OAUTH_AUDIENCE || 'api.cloud.camunda.io';
    const oauthUrl = c.CAMUNDA_OAUTH_URL || c.ZEEBE_AUTHORIZATION_SERVER_URL || 'https://login.cloud.camunda.io/oauth/token';
    const key = crypto.createHash('sha256').update(JSON.stringify([oauthUrl, clientId, clientSecret, audience])).digest('hex');
    const cached = this.tokens.get(key);
    if (cached?.value && cached.expires > this.now()) return cached.value;
    if (cached?.pending) return cached.pending;
    if (cached?.retryAt > this.now()) throw Object.assign(new ApiError('OAuth: Token-Abruf vorübergehend begrenzt', 429), { retryAt: cached.retryAt });
    for (const [id, entry] of this.tokens) if (!entry.pending && (entry.expires || 0) <= this.now() && (entry.retryAt || 0) <= this.now()) this.tokens.delete(id);
    const entry = { expires: 0 }; this.tokens.set(key, entry);
    entry.pending = this.requestToken(oauthUrl, clientId, clientSecret, audience, entry);
    try { return await entry.pending; }
    finally { entry.pending = null; if (!entry.value && !entry.retryAt) this.tokens.delete(key); }
  }

  async requestToken(oauthUrl, clientId, clientSecret, audience, entry) {
    let response;
    try {
      response = await this.fetch(oauthUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }),
      });
    } catch { throw new Error('OAuth-Verbindung fehlgeschlagen.'); }
    if (!response.ok) {
      if (response.status === 429) {
        const retry = response.headers?.get('retry-after');
        const milliseconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now();
        entry.retryAt = this.now() + Math.max(1000, Math.min(900000, Number.isFinite(milliseconds) ? milliseconds : 60000));
      }
      throw Object.assign(new ApiError('OAuth', response.status), entry.retryAt ? { retryAt: entry.retryAt } : {});
    }
    const data = await response.json();
    if (!data.access_token) throw new Error('OAuth lieferte kein Zugriffstoken.');
    entry.value = data.access_token;
    entry.expires = this.now() + Math.max(0, (Number(data.expires_in) || 300) - 60) * 1000;
    return data.access_token;
  }

  async request(base, endpoint, { method = 'GET', body, runtime = false } = {}) {
    return require('./activity-log').remoteWrite(endpoint, { method, body }, () => this.performRequest(base, endpoint, { method, body, runtime }));
  }

  async performRequest(base, endpoint, { method = 'GET', body, runtime = false } = {}) {
    const token = await this.token(runtime);
    let response;
    try {
      response = await this.fetch(base.replace(/\/$/, '') + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(this.freshReads && method === 'GET' ? { 'cache-control': 'no-cache' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error(`${method} ${endpoint}: Verbindung fehlgeschlagen.`); }
    if (!response.ok) throw new ApiError(`${method} ${endpoint}`, response.status);
    if (response.status === 204) return null;
    const raw = await response.text();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { throw new Error(`${method} ${endpoint}: Keine JSON-Antwort.`); }
  }

  hub(endpoint, options) { return this.request('https://hub.camunda.io/api/v2', endpoint, options); }
  console(endpoint, options) { return this.request('https://api.cloud.camunda.io', endpoint, options); }
  runtime(base, endpoint, options = {}) { return this.request(base, endpoint, { ...options, runtime: true }); }
}

module.exports = { readCredentials, ApiError, CamundaApi };
