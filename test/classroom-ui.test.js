const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
function fixture({ metadataError } = {}) {
  const elements = new Map(), calls = [], tasks = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false, open: false,
      options: [{ value: 'teacher@example.org' }], parentElement: { hidden: false }, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      showModal() { this.open = true; }, close() { this.open = false; },
      classList: { toggle() {} },
    });
    return elements.get(id);
  }
  element('class-site').value = 'basel'; element('class-lecturer').value = 'teacher@example.org'; element('class-day').value = 'sa';
  const classroom = { id: 'test-class', site: 'basel', lecturerEmail: 'teacher@example.org', day: 'sa', status: 'draft', groups: [{ id: 'test-group', name: 'Team 1', workspaceName: 'Teacher_Sa_Team 1', students: [{ name: 'Test', email: 'test@example.org' }] }] };
  const metadata = { classes: [classroom], lecturers: [{ email: 'teacher@example.org', name: 'Teacher', sites: { basel: true } }] };
  const preview = deferred(), apply = deferred();
  const document = { getElementById: element, querySelector: () => element('sidebar'), querySelectorAll: () => [...elements.values()] };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/classes') return { ok: !metadataError, json: async () => metadataError ? { error: metadataError } : metadata };
    if (url.endsWith('/preview')) return { ok: true, json: () => preview.promise };
    if (url.endsWith('/apply')) return { ok: true, json: () => apply.promise };
    assert.fail('Unexpected request ' + url);
  };
  const window = { addEventListener() {}, WaitOverlay: { begin(info) { const task = { info, ended: false, update(detail) { this.info.detail = detail; }, end() { this.ended = true; } }; tasks.push(task); return task; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/classroom.js'), 'utf8'), { document, window, fetch, AbortSignal, setTimeout, clearTimeout, setInterval: () => 0 });
  return { element, calls, tasks, classroom, preview, apply, async open() {
    await element('class-refresh').listeners.click();
    element('class-board').listeners.click({ target: { closest: () => ({ id: 'class-provision', dataset: {} }) } });
    await settle();
  } };
}

test('an expired session does not present unloaded lecturers as an empty class', async () => {
  const f = fixture({ metadataError: 'Bitte mit AAI anmelden.' });
  await f.element('class-refresh').listeners.click();
  assert.equal(f.element('class-status').textContent, 'Bitte mit AAI anmelden.');
  assert.match(f.element('class-board').innerHTML, /Klassen und Dozenten noch nicht geladen/);
  assert.doesNotMatch(f.element('class-board').innerHTML, /Noch keine Klasse für diese Auswahl/);
});

test('creation preview holds the overlay until the JSON body is ready and requires acknowledgement before applying once', async () => {
  const f = fixture(); await f.open();
  assert.match(f.element('class-board').innerHTML, /In Camunda anlegen/);
  assert.equal(f.element('class-dialog').open, true);
  assert.equal(f.element('class-dialog-apply').hidden, true);
  assert.equal(f.tasks[0].ended, false);
  f.preview.resolve({ previewId: 'preview-1', groups: [{ name: 'Teacher_Sa_Team 1', students: 1, adminEmail: 'teacher@example.org', projects: [{ name: 'Projektarbeit 1', action: 'reuse' }, { name: 'Projektarbeit 2', action: 'create' }] }], invitations: ['test@example.org'], changes: ['Tenant und Rechte anlegen'] });
  await settle();
  assert.equal(f.tasks[0].ended, true);
  assert.match(f.element('class-dialog-preview').innerHTML, /Projektarbeit 1 \(vorhanden\)/);
  assert.match(f.element('class-dialog-preview').innerHTML, /Projektarbeit 2 \(anlegen\)/);
  assert.equal(f.element('class-dialog-apply').textContent, 'Jetzt in Camunda anlegen');
  assert.equal(f.element('class-dialog-apply').disabled, true);
  await f.element('class-dialog-apply').listeners.click();
  assert.ok(!f.calls.some(c => c.url.endsWith('/apply')));
  f.element('class-dialog-ack').checked = true;
  const applying = f.element('class-dialog-apply').listeners.click(); await settle();
  assert.equal(f.tasks[1].ended, false);
  assert.equal(f.element('class-dialog-close').disabled, true);
  await f.element('class-dialog-apply').listeners.click();
  assert.equal(f.calls.filter(c => c.url.endsWith('/apply')).length, 1);
  f.apply.resolve({ status: 'completed', results: ['Gruppen-Workspace anlegen', 'Studierendenkonto einladen'], classroom: { ...f.classroom, pendingStudents: [{ email: 'test@example.org', reason: 'Einladung annehmen.' }] } });
  await applying;
  assert.equal(f.tasks[1].ended, true);
  assert.match(f.element('class-dialog-result').innerHTML, /Gruppen-Workspace anlegen/);
  assert.match(f.element('class-dialog-result').innerHTML, /test@example.org: Einladung annehmen/);
  assert.equal(f.element('class-dialog-apply').hidden, true);
  assert.equal(f.element('class-dialog-close').disabled, false);
});

test('a failed creation preview remains visible in its dialog without an apply action', async () => {
  const f = fixture(); await f.open();
  f.preview.resolve({}); // malformed preview must also release the overlay and remove its plan
  await settle();
  assert.equal(f.tasks[0].ended, true);
  assert.equal(f.element('class-dialog').open, true);
  assert.match(f.element('class-dialog-preview').textContent, /nicht erstellt/);
  assert.ok(f.element('class-dialog-result').textContent);
  assert.equal(f.element('class-dialog-apply').hidden, true);
  await f.element('class-dialog-apply').listeners.click();
  assert.ok(!f.calls.some(c => c.url.endsWith('/apply')));
});
