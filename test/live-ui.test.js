const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(response) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: '', disabled: false, addEventListener() {} });
      return elements.get(selector);
    },
    querySelectorAll: () => [],
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8'), { document, window: { addEventListener() {} }, fetch: async () => response, AbortSignal, setTimeout, setInterval: () => 0 });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  return elements;
}

test('expired application session is not reported as three failed Camunda connections', async () => {
  const elements = await fixture({ ok: false, status: 401 });
  for (const site of ['basel', 'brugg', 'olten']) {
    const card = elements.get('#card-' + site).innerHTML;
    assert.match(card, /Anmeldung erforderlich/);
    assert.match(card, /Camunda-Verbindung wurde nicht geprüft/);
    assert.doesNotMatch(card, /badge bad|Prüfung fehlgeschlagen|HTTP 401/);
  }
  assert.equal(elements.get('#refresh').disabled, false);
});

test('actual upstream authentication errors remain connection failures', async () => {
  const elements = await fixture({ ok: true, status: 200, json: async () => ({ ok: false, error: 'Console API: HTTP 401', checkedAt: new Date().toISOString() }) });
  for (const site of ['basel', 'brugg', 'olten']) {
    const card = elements.get('#card-' + site).innerHTML;
    assert.match(card, /Zugriff fehlgeschlagen/);
    assert.match(card, /Console API: HTTP 401/);
    assert.doesNotMatch(card, /Anmeldung erforderlich/);
  }
});
