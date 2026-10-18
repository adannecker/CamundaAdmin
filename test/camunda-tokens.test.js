const test = require('node:test');
const assert = require('node:assert/strict');
const { CamundaApi } = require('../lib/camunda-api');
const credentials = { CAMUNDA_CLIENT_ID: 'runtime-client', CAMUNDA_CLIENT_SECRET: 'runtime-secret', CAMUNDA_CONSOLE_CLIENT_ID: 'org-client', CAMUNDA_CONSOLE_CLIENT_SECRET: 'org-secret' };
const tokenResponse = value => ({ ok: true, json: async () => ({ access_token: value, expires_in: 3600 }) });

test('rebuilt contexts and concurrent API reads share one token until its refresh boundary', async () => {
  let clock = 0, calls = 0;
  const fetchImpl = async () => { calls++; await Promise.resolve(); return tokenResponse('token-' + calls); };
  const api = () => new CamundaApi({ ...credentials }, { fetchImpl, now: () => clock });
  const values = await Promise.all(Array.from({ length: 60 }, () => api().token(true)));
  assert.equal(calls, 1); assert.ok(values.every(t => t === 'token-1'));
  assert.equal(await api().token(true), 'token-1'); assert.equal(calls, 1);
  clock = 3540001;
  await Promise.all(Array.from({ length: 30 }, () => api().token(true))); assert.equal(calls, 2);
});

test('credential rotation, audiences, endpoints and organization clients never reuse another scope token', async () => {
  let calls = 0; const fetchImpl = async () => tokenResponse('token-' + ++calls);
  const api = changed => new CamundaApi({ ...credentials, ...changed }, { fetchImpl });
  const values = [await api().token(true), await api().token(false), await api({ CAMUNDA_CLIENT_SECRET: 'rotated' }).token(true), await api({ CAMUNDA_TOKEN_AUDIENCE: 'other' }).token(true), await api({ CAMUNDA_OAUTH_URL: 'https://other.test/token' }).token(true)];
  assert.equal(new Set(values).size, 5); assert.equal(calls, 5);
  assert.equal(await api().token(true), values[0]); assert.equal(calls, 5);
});

test('429 Retry-After applies across contexts without a token request storm or automatic retries', async () => {
  let clock = 0, calls = 0;
  const fetchImpl = async () => ++calls === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) } : tokenResponse('recovered');
  const api = () => new CamundaApi(credentials, { fetchImpl, now: () => clock });
  await assert.rejects(api().token(true), e => e.status === 429 && e.retryAt === 120000);
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => api().token(true)));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.status === 429)); assert.equal(calls, 1);
  clock = 120001; assert.equal(await api().token(true), 'recovered'); assert.equal(calls, 2);
});

test('a failed OAuth connection does not poison subsequent token requests', async () => {
  let calls = 0; const fetchImpl = async () => { if (++calls === 1) throw Error('private network details'); return tokenResponse('recovered'); };
  const api = () => new CamundaApi(credentials, { fetchImpl });
  await assert.rejects(api().token(true), /OAuth-Verbindung fehlgeschlagen/);
  assert.equal(await api().token(true), 'recovered'); assert.equal(calls, 2);
});

test('token reuse does not retry a rejected mutation', async () => {
  let tokens = 0, writes = 0;
  const fetchImpl = async url => { if (url.includes('oauth/token')) { tokens++; return tokenResponse('token'); } writes++; return { ok: false, status: 503 }; };
  const api = new CamundaApi(credentials, { fetchImpl });
  await assert.rejects(api.runtime('https://runtime.test', '/v2/groups', { method: 'POST', body: { groupId: 'test' } }), e => e.status === 503);
  assert.equal(tokens, 1); assert.equal(writes, 1);
});
