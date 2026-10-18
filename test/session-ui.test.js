const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(response = { status: 401 }, handler) {
  const requests = [];
  function element(tag) {
    return { tag, children: [], hidden: false, open: false, listeners: {}, showCount: 0, showModal() { this.open = true; this.showCount++; }, close() { this.open = false; }, focus() { this.focused = true; }, append(...nodes) { this.children.push(...nodes); }, prepend(...nodes) { this.children.unshift(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
  }
  const aside = element('aside'), main = element('main'), body = element('body'); body.append(aside, main);
  const find = (node, id) => node.id === id ? node : node.children?.map(child => find(child, id)).find(Boolean);
  const document = { body,
    querySelector(selector) { return selector === 'aside' ? aside : selector === 'main' ? main : { content: selector.includes('app-base') ? '/camundaadmin' : 'test-csrf' }; },
    createElement: element, createTextNode: text => ({ text }),
    getElementById: id => find(body, id),
  };
  const listeners = new Map();
  const window = { fetch: async (url, init) => { requests.push({ url, init }); return handler ? handler(url, init) : response; }, addEventListener(type, listener) { listeners.set(type, listener); }, dispatchEvent(event) { listeners.get(event.type)?.(event); } };
  const sandbox = {
    document, window, URL, Request, Headers, Event, setTimeout: () => 0, setInterval: () => 0, AbortSignal, location: { href: 'https://example.test/camundaadmin/', origin: 'https://example.test' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/session.js'), 'utf8'), sandbox);
  return { document, window, requests, main, aside, body, element, sandbox };
}

test('expired local API requests retain a working AAI login link and one modal, including repeated failures', async () => {
  const response = { status: 401 }, f = fixture(response), { document, window, requests, main } = f;
  const notice = document.getElementById('session-notice');
  assert.equal(main.children[0], notice);
  assert.equal(notice.className, 'session-notice');
  assert.equal(notice.hidden, true);
  for (let i = 0; i < 2; i++) {
    assert.equal(await window.fetch('/api/classes'), response);
    assert.equal(notice.hidden, false);
    assert.match(notice.children[0].text, /Sitzung abgelaufen/);
    assert.equal(notice.children.length, 2);
    assert.equal(notice.children[1].href, '/camundaadmin/auth/login');
    assert.equal(notice.children[1].textContent, 'Erneut mit AAI anmelden');
  }
  const overlay = document.getElementById('session-dialog');
  assert.equal(overlay.open, true); assert.equal(overlay.showCount, 1);
  assert.equal(window.SessionState.expired, true);
  const login = overlay.children[0].children[2].children[0];
  assert.equal(login.href, '/camundaadmin/auth/login'); assert.equal(login.focused, true);
  let prevented = false; overlay.listeners.cancel({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  assert.equal(requests[0].url, 'https://example.test/camundaadmin/api/classes');
});

test('foreign 401 responses do not expire the application session or open its overlay', async () => {
  const f = fixture(); await f.window.fetch('https://other.test/api/example');
  assert.equal(f.window.SessionState.expired, false);
  assert.equal(f.document.getElementById('session-dialog').open, false);
});

test('explicit logout shows the relogin overlay without navigating or automatically signing back in', async () => {
  const f = fixture({ ok: true, status: 200 });
  const logout = f.aside.children[0].children[1];
  await logout.listeners.click();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, 'https://example.test/camundaadmin/auth/logout');
  assert.equal(f.requests[0].init.method, 'POST');
  assert.equal(f.document.getElementById('session-dialog').open, true);
  assert.match(f.document.getElementById('session-dialog-detail').textContent, /Du bist abgemeldet/);
});

test('an expired session closes the wait overlay and later progress cannot cover the relogin button', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const f = fixture(undefined, url => url.endsWith('/cleanup/progress') ? { ok: true, status: 200, json: async () => ({ runs: [] }) } : pending);
  for (const id of ['wait-overlay', 'wait-title', 'wait-detail', 'wait-counter', 'wait-elapsed']) { const e = f.element(id === 'wait-overlay' ? 'dialog' : 'p'); e.id = id; f.body.append(e); }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/wait-overlay.js'), 'utf8'), f.sandbox);
  const task = f.window.WaitOverlay.begin({ title: 'Test', detail: 'Läuft' });
  const request = f.window.fetch('/api/classes');
  const wait = f.document.getElementById('wait-overlay'); assert.equal(wait.open, true);
  resolve({ ok: false, status: 401 }); await request;
  const login = f.document.getElementById('session-dialog'); assert.equal(login.open, true); assert.equal(wait.open, false);
  const shown = wait.showCount; task.update('Ergebnis lesen'); task.end();
  const later = f.window.WaitOverlay.begin({ title: 'Weitere Anfrage' }); later.end();
  assert.equal(wait.showCount, shown); assert.equal(wait.open, false); assert.equal(login.showCount, 1);
});
