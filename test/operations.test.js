const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActivityLog, remoteWrite } = require('../lib/activity-log');
const { OpenAssignments } = require('../lib/open-assignments');
const { reconcileClassCleanup } = require('../lib/class-cleanup-state');

function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-operations-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('activity survives restart, filters exactly and pages without losing events with identical timestamps', async t => {
  const root = directory(t); let log = new ActivityLog(root, { now: () => Date.parse('2026-10-18T10:00:00Z') });
  await log.run({ actor: 'owner@example.org', site: 'basel', lecturerEmail: 'teacher@example.org' }, () => log.operation('class.provision', { classId: 'class-1' }, async () => {
    await remoteWrite('/v2/groups/group-1/users/student%40example.org?secret=do-not-log', { method: 'PUT', body: { clientSecret: 'never-store-secret', base64: 'excel-private-cells' } }, async () => null);
    return { status: 'completed' };
  }));
  const first = log.query({ site: 'basel', limit: 2 }); assert.equal(first.events.length, 2); assert.ok(first.next);
  const second = log.query({ site: 'basel', limit: 2, before: first.next }); assert.equal(second.events.length, 2); assert.equal(second.next, null);
  assert.equal(new Set([...first.events, ...second.events].map(e => e.id)).size, 4);
  assert.equal(first.events[0].status, 'completed');
  const all = log.query({ lecturerEmail: 'teacher@example.org', since: '2026-10-18T09:00:00Z', until: '2026-10-18T11:00:00Z' }).events;
  assert.equal(all.length, 4); assert.ok(all.every(e => e.actor === 'owner@example.org'));
  assert.equal(log.query({ event: 'remote.write', status: 'accepted', q: 'student@example.org' }).events.length, 1);
  assert.equal(log.query({ site: 'brugg' }).events.length, 0);
  assert.equal(log.query({ q: '%' }).events.length, 0);
  assert.doesNotMatch(JSON.stringify(all), /do-not-log|never-store-secret|excel-private-cells/);
  log.close(); log = new ActivityLog(root); assert.equal(log.query().events.length, 4); log.close();
});

test('search POSTs are read-only, uncertain writes and incomplete runs remain distinguishable', async t => {
  let log; t.after(() => log?.close()); log = new ActivityLog(directory(t));
  await log.operation('class.provision', {}, async () => {
    await remoteWrite('/v2/groups/search', { method: 'POST' }, async () => null);
    await assert.rejects(remoteWrite('/v2/groups', { method: 'POST' }, async () => { throw Error('secret-error-body'); }));
    return { status: 'incomplete' };
  });
  const events = log.query().events;
  assert.equal(events.length, 4); assert.equal(events[0].status, 'incomplete');
  assert.ok(events.some(e => e.status === 'uncertain')); assert.doesNotMatch(JSON.stringify(events), /secret-error-body/);
});

test('historical receipts are imported once, have provenance and cannot leak arbitrary receipt fields', t => {
  let log; t.after(() => log?.close());
  const root = directory(t), file = 'class-action-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.local.json';
  fs.writeFileSync(path.join(root, file), JSON.stringify({ classId: 'class-1', type: 'provision', status: 'completed', checkedAt: '2026-10-17T11:00:00Z', results: ['Workspace'], secret: 'secret-value' }));
  log = new ActivityLog(root);
  log.importReceipts([{ id: 'class-1', site: 'basel', lecturerEmail: 'teacher@example.org' }]); log.importReceipts([]);
  const events = log.query().events; assert.equal(events.length, 1); assert.equal(events[0].source, 'history'); assert.equal(events[0].count, 1); assert.equal(events[0].site, 'basel'); assert.doesNotMatch(JSON.stringify(events), /secret-value/);
});

function assignmentsFixture(t) {
  const root = directory(t), c = { id: 'class-1', revision: 'r1', site: 'basel', lecturerEmail: 'teacher@example.org', lecturerName: 'Teacher', day: 'mi', status: 'pending', autoAccess: { enabled: true, status: 'waiting' },
    groups: [{ id: 'group-1', name: 'Gruppe 1', workspaceName: 'Teacher_Mi_Gruppe 1', workspaceKey: 'workspace-1', runtimeGroupId: 'group-1', tenantId: 'tenant-1', students: [{ name: 'Student', email: 'student@example.org' }] }] };
  const records = [], state = { orgPending: true, workspace: false, runtime: false, rights: true, failWorkspace: false, failOrg: false, failRuntime: false };
  const page = items => ({ items, page: { totalItems: items.length, hasMoreTotalItems: false } });
  const organizationApi = { async hub(endpoint, options) {
    records.push({ endpoint, options }); if (endpoint === '/info') { if (state.failOrg) throw Error(); return { authorizedOrganization: 'org-1' }; }
    assert.equal(endpoint, '/members/search'); assert.equal(options.method, 'POST'); if (state.failWorkspace) throw Object.assign(Error(), { status: 403 });
    return page(state.workspace ? [{ email: 'student@example.org', role: 'editor' }] : []);
  }, async console(endpoint) { assert.equal(endpoint, '/members'); return [{ email: 'student@example.org', invitePending: state.orgPending, roles: ['modeler'] }]; } };
  const runtimeApi = { async runtime(_base, endpoint, options) {
    records.push({ endpoint, options }); assert.ok(endpoint.endsWith('/search')); assert.equal(options.method, 'POST'); if (state.failRuntime) throw Object.assign(Error(), { status: 403 });
    if (endpoint.includes('/users/search')) return page(state.runtime ? [{ username: 'student@example.org' }] : []);
    if (endpoint.includes('/roles/search')) return page([{ roleId: 'studierende' }]);
    if (endpoint.includes('/tenants/')) return page([{ groupId: 'group-1' }]);
    if (endpoint === '/v2/authorizations/search') return page(state.rights ? [{ ownerType: 'GROUP', ownerId: 'group-1', resourceType: 'TENANT', resourceId: 'tenant-1', permissionTypes: ['READ'] }] : []);
    assert.fail(endpoint);
  } };
  const service = new OpenAssignments({ root, classroom: { load: () => ({ classes: [c] }) }, contextForSite: () => ({ organizationApi, runtimeApi, expectedOrganization: 'org-1', runtimeBase: 'https://runtime.example.org' }) });
  return { c, records, state, service };
}
test('open assignments separates invitations from missing access, only reads, and survives restart through saved snapshots', async t => {
  const f = assignmentsFixture(t); assert.equal((await f.service.get()).summary.unknown, 1);
  let result = await f.service.get({}, true); assert.equal(result.summary.invitations, 1); assert.equal(result.summary.assignments, 1); assert.equal(result.summary.ready, 0);
  const row = result.classes[0].groups[0].students[0]; assert.equal(row.organization.state, 'pending'); assert.equal(row.workspace.state, 'missing'); assert.equal(row.runtime.state, 'missing'); assert.equal(row.rights.state, 'ready');
  assert.ok(f.records.every(r => !r.options || r.options.method === 'POST' && r.endpoint.endsWith('/search')));
  f.state.orgPending = false; f.state.workspace = true; f.state.runtime = true;
  result = await f.service.get({}, true); assert.equal(result.summary.ready, 1); assert.equal(result.summary.invitations, 0);
  assert.equal((await f.service.get()).summary.ready, 1); f.c.revision = 'changed'; assert.equal((await f.service.get()).summary.unknown, 1);
  assert.equal((await f.service.get({ lecturerEmail: 'someone-else@example.org' })).classes.length, 0);
  assert.equal((await f.service.get({ site: 'brugg' })).classes.length, 0);
});
test('permission failures stay unknown, and drafts and unsafe groups are never displayed as ready', async t => {
  const f = assignmentsFixture(t); f.state.orgPending = false; f.state.workspace = true; f.state.runtime = true;
  f.state.failWorkspace = true; let result = await f.service.get({}, true); assert.equal(result.summary.ready, 0); assert.equal(result.summary.unknown, 1); assert.equal(result.classes[0].groups[0].students[0].workspace.state, 'unknown');
  f.state.failWorkspace = false; f.state.failRuntime = true; result = await f.service.get({}, true); assert.equal(result.classes[0].groups[0].students[0].rights.state, 'unknown');
  f.state.failRuntime = false; f.state.rights = false; result = await f.service.get({}, true); assert.equal(result.classes[0].groups[0].students[0].rights.state, 'missing');
  f.state.failOrg = true; result = await f.service.get({}, true); assert.equal(result.classes[0].groups[0].students[0].organization.state, 'unknown');
  f.c.status = 'draft'; result = await f.service.get({}, true); assert.equal(result.summary.ready, 0); assert.equal(result.classes[0].groups[0].students[0].runtime.state, 'not_prepared'); assert.ok(result.classes[0].issues.length);
});

test('a formerly completed class with subsequently missing access requires review rather than claiming completion', async t => {
  const f = assignmentsFixture(t); f.c.status = 'ready'; f.c.autoAccess.status = 'completed';
  const result = await f.service.get({}, true);
  assert.equal(result.classes[0].automatic.status, 'needs_review');
  assert.equal(result.summary.ready, 0); assert.ok(result.classes[0].issues.some(s => s.includes('früheren Einrichtungsabschluss')));
});

test('confirmed cleanup reconciles all targets, disables automation and hides retired students from pending totals', async t => {
  const f = assignmentsFixture(t), root = path.dirname(f.service.file), classFile = path.join(root, 'classes.local.json');
  f.c.createdAt = '2026-10-18T08:00:00Z'; f.c.autoAccess.authorizedAt = '2026-10-18T09:00:00Z'; f.c.status = 'ready'; f.c.autoAccess.status = 'completed';
  fs.writeFileSync(classFile, JSON.stringify({ schemaVersion: 1, classes: [f.c] }));
  const receipt = { site: 'basel', status: 'completed', checkedAt: '2026-10-18T10:00:00Z', results: [
    { kind: 'students', id: 'student@example.org', status: 'verified' }, { kind: 'workspaces', id: 'workspace-1', status: 'verified' },
    { kind: 'groups', id: 'group-1', status: 'verified' }, { kind: 'tenants', id: 'tenant-1', status: 'verified' },
  ] };
  fs.writeFileSync(path.join(root, 'cleanup-basel-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.local.json'), JSON.stringify(receipt));
  assert.equal(reconcileClassCleanup(root), 1); assert.equal(reconcileClassCleanup(root), 0);
  Object.assign(f.c, JSON.parse(fs.readFileSync(classFile)).classes[0]);
  assert.equal(f.c.status, 'cleaned'); assert.equal(f.c.autoAccess.enabled, false); assert.equal(f.c.autoAccess.status, 'cleanup');
  const normal = await f.service.get(); assert.equal(normal.classes.length, 0); assert.equal(normal.summary.cleaned, 1); assert.equal(normal.summary.students, 0);
  const history = await f.service.get({ includeCleaned: '1' }, true); assert.equal(history.classes.length, 1); assert.equal(history.summary.students, 0);
  assert.equal(history.classes[0].groups[0].students[0].organization.state, 'removed'); assert.equal(history.classes[0].automatic.status, 'cleanup');
});

test('uncertain, old and other-site deletions never retire a new class; partial confirmed deletion stops its automation', t => {
  const root = directory(t), file = path.join(root, 'classes.local.json');
  const c = { id: 'test', site: 'basel', createdAt: '2026-10-18T09:00:00Z', status: 'ready', autoAccess: { enabled: true, status: 'completed' }, groups: [{ workspaceKey: 'w', tenantId: 't', runtimeGroupId: 'g', students: [{ email: 'student@example.org' }] }] };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, classes: [c] }));
  const receiptFile = path.join(root, 'cleanup-basel-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.local.json');
  const receipt = { site: 'basel', status: 'incomplete', checkedAt: '2026-10-18T10:00:00Z', results: [{ kind: 'students', id: 'student@example.org', status: 'uncertain' }] };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt)); assert.equal(reconcileClassCleanup(root), 0);
  receipt.results[0].status = 'verified'; receipt.site = 'olten'; fs.writeFileSync(receiptFile, JSON.stringify(receipt)); assert.equal(reconcileClassCleanup(root), 0);
  receipt.site = 'basel'; receipt.checkedAt = '2026-10-18T08:00:00Z'; fs.writeFileSync(receiptFile, JSON.stringify(receipt)); assert.equal(reconcileClassCleanup(root), 0);
  receipt.checkedAt = '2026-10-18T10:00:00Z'; fs.writeFileSync(receiptFile, JSON.stringify(receipt)); assert.equal(reconcileClassCleanup(root), 1);
  const updated = JSON.parse(fs.readFileSync(file)).classes[0]; assert.equal(updated.status, 'attention'); assert.equal(updated.autoAccess.enabled, false);
  assert.deepEqual(updated.cleanupState.students, ['student@example.org']);
});
