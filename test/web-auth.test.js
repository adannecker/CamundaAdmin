const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWebAuth, settings, allowedOwner, isVerifiedWrite } = require('../lib/web-auth');
const { allowLocalConfigWrite } = require('../lib/admin-config');

const env = { AUTH_MODE: 'oidc', HOST: '0.0.0.0', BASE_PATH: '/camundaadmin', PUBLIC_URL: 'https://example.test/camundaadmin',
  OIDC_ISSUER: 'https://id.test/realms/fhnw', OIDC_CLIENT_ID: 'camundaadmin', OIDC_CLIENT_SECRET: 'test-secret', OIDC_OWNER_SUB: 'owner-id', OIDC_OWNER_EMAIL: 'owner@example.test' };
const claims = { iss: env.OIDC_ISSUER, sub: 'owner-id', email: 'owner@example.test', email_verified: true, identity_provider: 'switch-eduid' };
function response() {
  return { headers: {}, statusCode: 200, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); }, end(body = '') { this.body = body; } };
}
async function call(gate, path, { method = 'GET', headers = {} } = {}) {
  const req = { url: path, method, headers: { host: 'example.test', ...headers } }, res = response();
  const result = await gate.authorize(req, res); return { req, res, result };
}

test('production requires complete HTTPS configuration and local mode refuses public binding', () => {
  assert.throws(() => settings({ HOST: '0.0.0.0' }), /lokale Bindung/);
  for (const key of ['OIDC_OWNER_SUB', 'OIDC_CLIENT_SECRET', 'OIDC_OWNER_EMAIL', 'OIDC_ISSUER']) assert.throws(() => settings({ ...env, [key]: '' }), /fehlt/);
  assert.throws(() => settings({ ...env, PUBLIC_URL: 'http://example.test/camundaadmin' }), /HTTPS/);
  assert.throws(() => settings({ ...env, PUBLIC_URL: 'https://example.test/elsewhere' }), /passen nicht/);
  assert.throws(() => settings({ ...env, BASE_PATH: '//example.test' }), /ungültig/);
});

test('owner access requires exact subject, issuer, verified email and AAI identity', () => {
  const config = settings(env); assert.equal(allowedOwner(claims, config), true);
  for (const change of [{ sub: 'other' }, { iss: 'https://evil.test' }, { email: 'other@example.test' }, { email_verified: false }, { identity_provider: 'local' }]) assert.equal(allowedOwner({ ...claims, ...change }, config), false);
});

test('real signed OIDC flow, CSRF, logout, expiry, replay, foreign account and invalid signature', async t => {
  const oidc = await import('openid-client'), jose = await import('jose');
  const key = await jose.generateKeyPair('RS256'), attackerKey = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(key.publicKey); Object.assign(jwk, { kid: 'test', alg: 'RS256', use: 'sig' });
  const codes = new Map(); let invalidSignature = false, otherOwner = false, incorrectNonce = false, incorrectAudience = false;
  const provider = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    const parts = []; for await (const part of req) parts.push(part);
    const body = new URLSearchParams(Buffer.concat(parts).toString()); const tx = codes.get(body.get('code')); codes.delete(body.get('code'));
    if (!tx || await oidc.calculatePKCECodeChallenge(body.get('code_verifier')) !== tx.challenge) { res.writeHead(400); res.end('{"error":"invalid_grant"}'); return; }
    const jwt = await new jose.SignJWT({ ...claims, ...(otherOwner ? { sub: 'somebody-else' } : {}), nonce: incorrectNonce ? 'bad-nonce' : tx.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setAudience(incorrectAudience ? 'wrong-client' : env.OIDC_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(invalidSignature ? attackerKey.privateKey : key.privateKey);
    res.end(JSON.stringify({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 300, id_token: jwt }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); t.after(() => provider.close());
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  let clock = Date.now();
  const gate = await createWebAuth(env, { now: () => clock, oidc: { ...oidc, discovery: async () => {
    const config = new oidc.Configuration({ issuer: env.OIDC_ISSUER, authorization_endpoint: 'https://id.test/auth', token_endpoint: providerBase + '/token', jwks_uri: providerBase + '/jwks', id_token_signing_alg_values_supported: ['RS256'] }, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET);
    oidc.allowInsecureRequests(config); return config;
  } } });
  for (const path of ['/api/admin/config', '/api/basel/members', '/dashboard.js', '/styles.css', '/api/cleanup/progress', '/api/operations/events', '/api/operations/pending', '/operations.js', '/operations.css']) {
    const r = await call(gate, '/camundaadmin' + path); assert.equal(r.res.statusCode, 401); assert.equal(r.result, null);
  }
  assert.equal((await call(gate, '/api/admin/config')).res.statusCode, 404);
  assert.equal((await call(gate, '/camundaadmin/healthz')).res.statusCode, 200);
  assert.equal((await call(gate, '/camundaadmin/')).res.headers.location, '/camundaadmin/auth/login');
  assert.equal((await call(gate, '/camundaadmin/auth/login', { headers: { host: 'evil.test', 'x-forwarded-host': 'example.test' } })).res.statusCode, 400);
  assert.equal((await call(gate, '//evil.test/')).res.statusCode, 400);
  async function start() {
    const login = await call(gate, '/camundaadmin/auth/login');
    const url = new URL(login.res.headers.location); const code = String(Math.random());
    assert.equal(url.searchParams.get('kc_idp_hint'), 'switch-eduid'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    codes.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
    return { cookie: login.res.headers['set-cookie'].split(';')[0], path: `/camundaadmin/auth/callback?code=${code}&state=${url.searchParams.get('state')}` };
  }
  const tx = await start();
  assert.equal((await call(gate, tx.path)).res.statusCode, 400); // State alone is insufficient without browser cookie.
  const tx2 = await start(), logged = await call(gate, tx2.path, { headers: { cookie: tx2.cookie } });
  assert.equal(logged.res.statusCode, 303); assert.equal(logged.res.headers.location, '/camundaadmin/');
  const sessionCookie = logged.res.headers['set-cookie'][1]; assert.match(sessionCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(sessionCookie, /Path=\/camundaadmin/); const cookie = sessionCookie.split(';')[0];
  assert.equal((await call(gate, tx2.path, { headers: { cookie: tx2.cookie } })).res.statusCode, 400);
  const session = await call(gate, '/camundaadmin/api/session', { headers: { cookie } });
  const csrf = JSON.parse(session.res.body).csrf; assert.ok(csrf);
  const bad = [{}, { origin: env.PUBLIC_URL }, { origin: 'https://evil.test', 'x-csrf-token': csrf }, { origin: 'https://example.test', 'x-csrf-token': 'wrong' }, { origin: 'https://example.test', 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' }];
  for (const extra of bad) assert.equal((await call(gate, '/camundaadmin/api/admin/config', { method: 'PUT', headers: { cookie, ...extra } })).res.statusCode, 403);
  const write = await call(gate, '/camundaadmin/api/admin/config', { method: 'PUT', headers: { cookie, origin: 'https://example.test', 'x-csrf-token': csrf, 'content-type': 'application/json' } });
  assert.ok(write.result); assert.equal(write.result.url.pathname, '/api/admin/config'); assert.equal(isVerifiedWrite(write.req), true); assert.equal(allowLocalConfigWrite(write.req), true);
  assert.equal(allowLocalConfigWrite({ headers: write.req.headers, appAuth: true }), false);
  const html = gate.render('<head></head><script src="/session.js"></script>', write.result.session); assert.match(html, /src="\/camundaadmin\/session.js"/); assert.match(html, new RegExp(csrf));
  const logout = await call(gate, '/camundaadmin/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://example.test', 'x-csrf-token': csrf } }); assert.equal(logout.res.statusCode, 200);
  assert.equal((await call(gate, '/camundaadmin/api/admin/config', { headers: { cookie } })).res.statusCode, 401);
  for (const fault of ['account', 'signature', 'nonce', 'audience']) {
    otherOwner = fault === 'account'; invalidSignature = fault === 'signature'; incorrectNonce = fault === 'nonce'; incorrectAudience = fault === 'audience';
    const next = await start(), rejected = await call(gate, next.path, { headers: { cookie: next.cookie } }); assert.equal(rejected.res.statusCode, fault === 'account' ? 403 : 400, fault);
    assert.equal(Array.isArray(rejected.res.headers['set-cookie']), false);
  }
  const expired = await start(); clock += 301000;
  assert.equal((await call(gate, expired.path, { headers: { cookie: expired.cookie } })).res.statusCode, 400);
});

test('local gate rejects DNS rebinding and foreign writes', async () => {
  const gate = await createWebAuth({});
  assert.equal((await call(gate, '/api/admin/config')).res.statusCode, 403);
  assert.ok((await call(gate, '/api/admin/config', { headers: { host: '127.0.0.1:3300' } })).result);
  assert.equal((await call(gate, '/api/admin/config', { method: 'PUT', headers: { host: '127.0.0.1:3300', origin: 'https://evil.test' } })).res.statusCode, 403);
});
