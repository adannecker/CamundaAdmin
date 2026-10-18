const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdminReconciler } = require('../lib/admin-reconcile');
const { loadAdminConfig } = require('../lib/admin-config');
const { CamundaApi } = require('../lib/camunda-api');

test('fresh administration reads request cache revalidation without changing the mutation contract', async () => {
  const requests = [];
  const api = new CamundaApi({}, { freshReads: true, fetchImpl: async (url, request) => {
    requests.push({ url, request });
    return new Response(request.method === 'GET' ? '[]' : null, { status: request.method === 'GET' ? 200 : 204 });
  } });
  api.token = async () => 'mock-token';
  await api.console('/members');
  await api.console('/members/teacher%40example.org', { method: 'POST', body: { orgRoles: ['admin'] } });
  assert.equal(requests[0].request.headers['cache-control'], 'no-cache');
  assert.equal(requests[1].request.headers['cache-control'], undefined);
  assert.deepEqual(JSON.parse(requests[1].request.body), { orgRoles: ['admin'] });
});

function setup(t, options = {}) {
  const config = {
    schemaVersion: 1,
    organizations: { basel: '11111111-1111-1111-1111-111111111111', brugg: '22222222-2222-2222-2222-222222222222', olten: '33333333-3333-3333-3333-333333333333' },
    organizationRole: 'admin', removeOtherOrganizationRoles: true, unselectedSites: 'leave_unchanged',
    protectedOwners: [{ email: 'owner@example.org', name: 'Owner', sites: { basel: true, brugg: true, olten: true } }],
    lecturers: [{ email: 'teacher@example.org', name: 'Local name', sites: { basel: true, brugg: false, olten: true } }],
  };
  if (options.allSites) config.lecturers[0].sites.brugg = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-reconcile-'));
  const filename = path.join(dir, 'admin-config.json');
  fs.writeFileSync(filename, JSON.stringify(config));
  t.after(() => { fs.unlinkSync(filename); fs.rmdirSync(dir); });
  const members = Object.fromEntries(Object.keys(config.organizations).map(site => [site, [{ email: 'owner@example.org', roles: ['admin', 'owner'] }]]));
  members.basel.push({ email: 'teacher@example.org', roles: ['modeler', 'analyst', 'admin'] });
  members.brugg.push({ email: 'teacher@example.org', roles: ['analyst'] });
  const posts = [], calls = [];
  const apiForSite = site => ({
    async hub(endpoint) {
      assert.equal(endpoint, '/info');
      if (options.unavailable === site) throw new Error('Site unavailable');
      return { authorizedOrganization: config.organizations[site] };
    },
    async console(endpoint, request) {
      calls.push({ site, endpoint, request });
      if (!request) { assert.equal(endpoint, '/members'); return structuredClone(members[site]); }
      assert.equal(request.method, 'POST');
      posts.push({ site, endpoint, request: structuredClone(request) });
      if (options.onPost) await options.onPost(site);
      if (!options.keepOldRoles) {
        const email = decodeURIComponent(endpoint.slice('/members/'.length));
        let member = members[site].find(m => m.email === email);
        if (!member) { member = { email, invitePending: true }; members[site].push(member); }
        member.roles = [...request.body.orgRoles];
      }
      return null;
    },
  });
  let now = 1000000;
  const reconciler = new AdminReconciler({ configFile: filename, apiForSite, now: () => now, wait: async () => {} });
  return { reconciler, config, filename, members, posts, calls, advance: ms => { now += ms; }, preview: () => reconciler.preview(loadAdminConfig(filename).revision) };
}

test('preview reads all sites, plans exact role changes and invitations, and sends no mutations', async t => {
  const f = setup(t), result = await f.preview();
  assert.equal(result.appliedToCamunda, false);
  assert.deepEqual(result.preview.changes.map(c => [c.site, c.action, c.currentRoles, c.targetRoles]), [
    ['basel', 'update', ['modeler', 'analyst', 'admin'], ['admin']], ['olten', 'invite', [], ['admin']],
  ]);
  assert.equal(result.preview.protectedCount, 3);
  assert.equal(f.posts.length, 0);
});

test('apply uses the documented orgRoles contract, verifies results and protects owners/unselected sites', async t => {
  const f = setup(t), { preview } = await f.preview();
  const result = await f.reconciler.apply(preview.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.appliedToCamunda, true);
  assert.ok(result.results.every(r => r.status === 'verified'));
  assert.equal(result.results[1].invitationPending, true);
  assert.deepEqual(f.posts, ['basel', 'olten'].map(site => ({ site, endpoint: '/members/teacher%40example.org', request: { method: 'POST', body: { orgRoles: ['admin'] } } })));
  assert.deepEqual(f.members.brugg[1].roles, ['analyst']);
  for (const site of Object.keys(f.members)) assert.deepEqual(f.members[site][0].roles, ['admin', 'owner']);
  await assert.rejects(f.reconciler.apply(preview.id), /bereits verwendet/);
  assert.equal(f.posts.length, 2);
});

test('a locally changed configuration invalidates preview before any mutation', async t => {
  const f = setup(t), { preview } = await f.preview();
  f.config.lecturers[0].name = 'Updated locally';
  fs.writeFileSync(f.filename, JSON.stringify(f.config));
  await assert.rejects(f.reconciler.apply(preview.id), /Konfiguration wurde/);
  assert.equal(f.posts.length, 0);
});

test('remote role changes, owner changes and pending invitation changes invalidate preview', async t => {
  for (const mutate of [
    f => { f.members.basel[1].roles = ['modeler']; },
    f => { f.members.olten[0].roles = ['admin']; },
    f => { f.members.basel[1].invitePending = true; },
  ]) {
    const f = setup(t), { preview } = await f.preview();
    mutate(f);
    await assert.rejects(f.reconciler.apply(preview.id), /Camunda-Stand|Owner-Zugriff/);
    assert.equal(f.posts.length, 0);
  }
});

test('expired, missing and zero-change previews cannot apply', async t => {
  const f = setup(t), { preview } = await f.preview();
  f.advance(600001);
  await assert.rejects(f.reconciler.apply(preview.id), /abgelaufen/);
  await assert.rejects(f.reconciler.apply('unknown'), /Vorschau fehlt/);
  f.members.basel[1].roles = ['admin'];
  f.members.olten.push({ email: 'teacher@example.org', roles: ['admin'] });
  const current = await f.preview();
  assert.equal(current.preview.changes.length, 0);
  await assert.rejects(f.reconciler.apply(current.preview.id), /keine anzuwendenden/);
  assert.equal(f.posts.length, 0);
});

test('an unavailable selected site cannot arm an apply preview', async t => {
  const f = setup(t, { unavailable: 'basel' });
  await assert.rejects(f.preview(), /nicht vollständig geprüft/);
  assert.equal(f.reconciler.plans.size, 0);
  assert.equal(f.posts.length, 0);
});

test('network failure stops remaining changes, reports partial outcome and never retries POST', async t => {
  const f = setup(t, { allSites: true, onPost: async site => { if (site === 'brugg') throw new Error('Connection lost'); } });
  const { preview } = await f.preview(), result = await f.reconciler.apply(preview.id);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.results.map(r => r.status), ['verified', 'uncertain']);
  assert.deepEqual(result.notAttempted.map(r => r.site), ['olten']);
  assert.equal(f.posts.length, 2);
  await assert.rejects(f.reconciler.apply(preview.id), /bereits verwendet/);
});

test('unconfirmed read-back performs only GET retries, then stops the batch', async t => {
  const f = setup(t, { keepOldRoles: true }), { preview } = await f.preview();
  const result = await f.reconciler.apply(preview.id);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.results[0].status, 'pending');
  assert.equal(result.notAttempted.length, 1);
  assert.equal(f.posts.length, 1);
  const firstPost = f.calls.findIndex(c => c.request);
  assert.equal(f.calls.slice(firstPost + 1).length, 3);
  assert.ok(f.calls.slice(firstPost + 1).every(c => c.request === undefined));
});

test('a simultaneous second apply is rejected while the first batch is active', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const f = setup(t, { onPost: async () => { entered(); await gate; } });
  const first = await f.preview(), second = await f.preview();
  const applying = f.reconciler.apply(first.preview.id);
  await ready;
  try { await assert.rejects(f.reconciler.apply(second.preview.id), /läuft bereits/); }
  finally { release(); }
  assert.equal((await applying).status, 'completed');
  assert.equal(f.posts.length, 2);
});
