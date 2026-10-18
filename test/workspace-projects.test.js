const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureProjects, readProjects } = require('../lib/workspace-projects');
function fixture(projects = []) {
  const group = { workspaceKey: 'w1' }, writes = [];
  const api = { async hub(endpoint, options) {
    assert.equal(options.body.workspaceKey || options.body.filter.workspaceKey.$eq, 'w1');
    if (endpoint === '/projects/search') return { items: structuredClone(projects) };
    assert.equal(endpoint, '/projects'); writes.push(options.body);
    const p = { ...options.body, projectKey: 'p' + (projects.length + 1) }; projects.push(p); return p;
  } };
  return { api, group, writes, projects, save() {}, write: async (_label, call) => call(), verify: async read => read() };
}
test('backfills only missing named projects, preserves other content, and is idempotent', async () => {
  const f = fixture([{ projectKey: 'existing', workspaceKey: 'w1', name: 'Projektarbeit 1' }, { projectKey: 'other', workspaceKey: 'w1', name: 'Eigene Arbeit' }]);
  await ensureProjects(f); await ensureProjects(f);
  assert.deepEqual(f.writes.map(p => p.name), ['Projektarbeit 2']);
  assert.equal(f.group.projects[0].projectKey, 'existing');
  assert.equal(f.projects.find(p => p.projectKey === 'other').name, 'Eigene Arbeit');
});
test('duplicate names and foreign workspace results block writes', async () => {
  for (const projects of [[{ projectKey: 'a', workspaceKey: 'other', name: 'Projektarbeit 1' }], ['a', 'b'].map(projectKey => ({ projectKey, workspaceKey: 'w1', name: 'Projektarbeit 1' }))]) {
    const f = fixture(projects); await assert.rejects(ensureProjects(f)); assert.equal(f.writes.length, 0);
  }
});
test('unknown create outcome is persisted and never blindly retried; a later confirmed project is reused', async () => {
  const f = fixture(); const original = f.api.hub;
  f.api.hub = async (endpoint, options) => { if (endpoint === '/projects') { f.writes.push(options.body); throw Error('Connection lost'); } return original(endpoint, options); };
  await assert.rejects(ensureProjects(f), /Connection lost/);
  assert.equal(f.group.projectCreateAttempts['Projektarbeit 1'].status, 'reserved');
  await assert.rejects(ensureProjects(f), /unbestätigt/); assert.equal(f.writes.length, 1);
  f.projects.push({ projectKey: 'confirmed', workspaceKey: 'w1', name: 'Projektarbeit 1' }); f.api.hub = original;
  await ensureProjects(f); assert.equal(f.group.projects[0].projectKey, 'confirmed'); assert.equal(f.group.projectCreateAttempts['Projektarbeit 1'].status, 'verified');
});
