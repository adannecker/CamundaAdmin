const fs = require('node:fs');

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
  constructor(credentials, { fetchImpl = fetch, freshReads = false } = {}) {
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.freshReads = freshReads;
    this.tokens = new Map();
  }

  async token(runtime = false) {
    const cached = this.tokens.get(runtime);
    if (cached && cached.expires > Date.now()) return cached.value;
    const c = this.credentials;
    const clientId = runtime ? c.CAMUNDA_CLIENT_ID || c.ZEEBE_CLIENT_ID : c.CAMUNDA_CONSOLE_CLIENT_ID;
    const clientSecret = runtime ? c.CAMUNDA_CLIENT_SECRET || c.ZEEBE_CLIENT_SECRET : c.CAMUNDA_CONSOLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error(runtime ? 'Runtime-Credentials fehlen (CAMUNDA_CLIENT_ID und CAMUNDA_CLIENT_SECRET).' : 'Administration-Credentials fehlen.');
    const audience = runtime ? c.CAMUNDA_TOKEN_AUDIENCE || c.ZEEBE_TOKEN_AUDIENCE || 'zeebe.camunda.io' : c.CAMUNDA_CONSOLE_OAUTH_AUDIENCE || 'api.cloud.camunda.io';
    let response;
    try {
      response = await this.fetch(c.CAMUNDA_OAUTH_URL || c.ZEEBE_AUTHORIZATION_SERVER_URL || 'https://login.cloud.camunda.io/oauth/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }),
      });
    } catch { throw new Error('OAuth-Verbindung fehlgeschlagen.'); }
    if (!response.ok) throw new ApiError('OAuth', response.status);
    const data = await response.json();
    if (!data.access_token) throw new Error('OAuth lieferte kein Zugriffstoken.');
    this.tokens.set(runtime, { value: data.access_token, expires: Date.now() + Math.max(0, (Number(data.expires_in) || 300) - 60) * 1000 });
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
