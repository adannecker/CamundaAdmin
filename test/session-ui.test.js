const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('expired local API requests retain a working AAI login link, including repeated failures', async () => {
  const requests = [];
  function element(tag) {
    return { tag, children: [], hidden: false, append(...nodes) { this.children.push(...nodes); }, prepend(...nodes) { this.children.unshift(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {}, addEventListener() {} };
  }
  const aside = element('aside'), main = element('main');
  const document = {
    querySelector(selector) { return selector === 'aside' ? aside : selector === 'main' ? main : { content: selector.includes('app-base') ? '/camundaadmin' : 'test-csrf' }; },
    createElement: element, createTextNode: text => ({ text }),
    getElementById: id => [...main.children, ...aside.children].find(node => node.id === id),
  };
  const response = { status: 401 };
  const window = { fetch: async (url, init) => { requests.push({ url, init }); return response; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/session.js'), 'utf8'), {
    document, window, URL, Request, Headers, location: { href: 'https://example.test/camundaadmin/', origin: 'https://example.test' },
  });
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
  assert.equal(requests[0].url, 'https://example.test/camundaadmin/api/classes');
});
