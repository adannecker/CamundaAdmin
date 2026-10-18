const test = require('node:test');
const assert = require('node:assert/strict');
const { loadOpenAiConfig, openAiStatus, checkOpenAiConnection, analyzeNames, connectorEnvSecrets } = require('../lib/openai');

const config = { apiKey: 'secret-test-key', model: 'gpt-5-mini' };
const jsonResponse = data => ({ ok: true, json: async () => data });
const completed = result => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
const entry = id => ({ id, normalizedName: 'Test Name', duplicateOf: null, note: '' });

test('configuration status exposes no API key and missing credentials fail before network access', async () => {
  const loaded = loadOpenAiConfig({ filename: 'does-not-exist.env', env: { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-5-mini' } });
  assert.deepEqual(openAiStatus(loaded), { configured: true, model: 'gpt-5-mini' });
  await assert.rejects(checkOpenAiConnection({ apiKey: '', model: config.model }, { fetchImpl: async () => assert.fail('No network without a key') }), /OPENAI_API_KEY fehlt/);
});

test('connection check only retrieves model metadata and sends no names or files', async () => {
  const result = await checkOpenAiConnection(config, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models/gpt-5-mini');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer secret-test-key');
    return jsonResponse({ id: 'gpt-5-mini' });
  } });
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
});

test('provider error bodies and transport errors cannot leak the key or submitted input', async () => {
  await assert.rejects(checkOpenAiConnection(config, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => assert.fail('Do not read error bodies') }) }), error => error.message.includes('HTTP 401') && !error.message.includes(config.apiKey));
  await assert.rejects(checkOpenAiConnection(config, { fetchImpl: async () => { throw new Error(config.apiKey); } }), error => !error.message.includes(config.apiKey));
});

test('name analysis sends only supplied names with structured output and returns reviewable suggestions', async () => {
  const result = await analyzeNames(config, ['  Test Name  '], { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(JSON.parse(body.input), [{ id: 1, name: 'Test Name' }]);
    return jsonResponse(completed({ entries: [entry(1)], warnings: [] }));
  } });
  assert.equal(result.suggestionsOnly, true);
  assert.equal(result.entries[0].originalName, 'Test Name');
});

test('invalid names, missing input IDs, and self-referencing duplicates are rejected', async () => {
  await assert.rejects(analyzeNames(config, [], { fetchImpl: async () => assert.fail('No network for invalid input') }), /Namen/);
  for (const entries of [[entry(1), entry(1)], [entry(1), entry(3)], [entry(1), { ...entry(2), duplicateOf: 2 }]]) {
    await assert.rejects(analyzeNames(config, ['Test One', 'Test Two'], { fetchImpl: async () => jsonResponse(completed({ entries, warnings: [] })) }), /ungültige Zuordnungen/);
  }
});

test('refusals and incomplete generations are not treated as successful name analyses', async () => {
  for (const response of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }]) {
    await assert.rejects(analyzeNames(config, ['Test Name'], { fetchImpl: async () => jsonResponse(response) }), /nicht vollständig|abgelehnt/);
  }
});

test('local OpenAI service credentials and model configuration are excluded from Camunda connector export', () => {
  assert.deepEqual(connectorEnvSecrets({ OPENAI_API_KEY: config.apiKey, OPENAI_MODEL: config.model, PYTHON_BIN: 'local-python', GOOGLE_API_KEY: 'connector-secret' }), [{ name: 'GOOGLE_API_KEY', secretValue: 'connector-secret' }]);
});
