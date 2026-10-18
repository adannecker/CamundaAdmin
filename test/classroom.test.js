const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Classroom } = require('../lib/classroom');
const { Cleanup } = require('../lib/cleanup');
const { ApiError } = require('../lib/camunda-api');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-class-'));
  t.after(() => { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); });
  const org = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', sites = { basel: true, brugg: true, olten: true };
  const config = { schemaVersion: 1, organizations: { basel: org, brugg: org, olten: org }, organizationRole: 'admin', removeOtherOrganizationRoles: true, unselectedSites: 'leave_unchanged', protectedOwners: [{ email: 'owner@example.org', name: 'Owner', sites }], lecturers: [{ email: 'teacher@example.org', name: 'Teacher Name', sites }] };
  fs.writeFileSync(path.join(root, 'admin-config.json'), JSON.stringify(config));
  const people = options.students || [{ email: 'one@example.org', name: 'One', group: 'Gruppe 1' }, { email: 'two@example.org', name: 'Two', group: 'Gruppe 2' }, { email: 'three@example.org', name: 'Three', group: 'Gruppe 3' }];
  const state = { members: [{ email: 'owner@example.org', roles: ['owner'] }, { email: 'teacher@example.org', roles: ['admin'] }, ...people.filter(p => p.email !== options.missingStudent).map(p => ({ email: p.email, roles: ['modeler'] }))], workspaces: [], wm: {}, environments: {}, tenants: [{ tenantId: '<default>', name: 'Default' }], tm: { '<default>': { users: [], groups: [], roles: [{ roleId: 'admin' }], clients: [{ clientId: 'client' }], 'mapping-rules': [] } }, groups: [], gu: {}, gr: {}, roleGroups: [], grants: [{ ownerType: 'CLIENT', ownerId: 'client', resourceType: 'AUTHORIZATION', resourceId: '*', permissionTypes: ['READ', 'CREATE'] }] };
  const writes = [], page = items => ({ items: structuredClone(items), page: { totalItems: items.length, hasMoreTotalItems: false } });
  let failEndpoint;
  const record = (endpoint, request) => { if (request.method === 'POST' && endpoint.endsWith('/search')) return; writes.push({ endpoint, request }); if (endpoint === failEndpoint) { failEndpoint = null; throw new Error('Connection lost'); } };
  const organizationApi = {
    async hub(endpoint, request = {}) {
      if (endpoint === '/info') return { authorizedOrganization: org };
      const filter = request.body?.filter || {}, wid = filter.workspaceKey?.$eq;
      if (endpoint === '/workspaces/search') return page(state.workspaces.filter(w => !filter.name || w.name === filter.name.$eq));
      if (endpoint === '/members/search') return page(wid ? state.wm[wid] || [] : Object.values(state.wm).flat());
      if (endpoint === '/projects/search') return page([]);
      if (endpoint === '/workspaces' && request.method === 'POST') { record(endpoint, request); const w = { workspaceKey: 'w' + (state.workspaces.length + 1), name: request.body.name }; state.workspaces.push(w); state.wm[w.workspaceKey] = []; state.environments[w.workspaceKey] = []; return w; }
      const p = endpoint.split('/').map(decodeURIComponent);
      if (p[1] === 'workspaces' && p[3] === 'members') { record(endpoint, request); if (request.method === 'POST') state.wm[p[2]].push(request.body); else if (request.method === 'DELETE') state.wm[p[2]] = state.wm[p[2]].filter(m => m.email !== p[4]); else throw Error('Unexpected member action'); return null; }
      if (p[1] === 'workspaces' && p[3] === 'environments') { if (request.method === 'PUT') { record(endpoint, request); state.environments[p[2]] = request.body.environmentIds.map(id => ({ id })); } return page(state.environments[p[2]]); }
      throw Error('Unexpected Hub ' + endpoint);
    },
    async console(endpoint, request = {}) { if (endpoint === '/members') return structuredClone(state.members); if (request.method === 'POST') { record(endpoint, request); return null; } throw Error('Unexpected Console ' + endpoint); },
  };
  const runtimeApi = { async runtime(_base, endpoint, request = {}) {
    const p = endpoint.split('/').map(decodeURIComponent);
    if (endpoint.endsWith('/search')) {
      if (endpoint === '/v2/tenants/search') return page(state.tenants);
      if (endpoint === '/v2/groups/search') return page(state.groups);
      if (endpoint === '/v2/roles/search') return page(['studierende', 'admin', 'connectors', 'app-integrations'].map(roleId => ({ roleId })));
      if (endpoint === '/v2/authorizations/search') return page(state.grants.filter(a => a.ownerType === request.body.filter.ownerType && a.ownerId === request.body.filter.ownerId));
      if (p[2] === 'tenants') return page(state.tm[p[3]][p[4]]);
      if (p[2] === 'groups' && p[4] === 'users') return page(state.gu[p[3]].map(username => ({ username })));
      if (p[2] === 'groups' && p[4] === 'roles') return page(state.gr[p[3]].map(roleId => ({ roleId })));
      if (p[2] === 'roles' && p[4] === 'groups') return page(p[3] === 'studierende' ? state.roleGroups.map(groupId => ({ groupId })) : []);
      if (p[2] === 'roles' && p[4] === 'users') return page([]);
      return page([]);
    }
    if (request.method) {
      record(endpoint, request);
      if (endpoint === '/v2/tenants' && request.method === 'POST') { state.tenants.push(request.body); state.tm[request.body.tenantId] = { users: [], groups: [], roles: [], clients: [], 'mapping-rules': [] }; return {}; }
      if (endpoint === '/v2/groups' && request.method === 'POST') { state.groups.push(request.body); state.gu[request.body.groupId] = []; state.gr[request.body.groupId] = []; return {}; }
      if (endpoint === '/v2/authorizations') { state.grants.push({ authorizationKey: 'a' + state.grants.length, ...request.body }); return {}; }
      if (p[2] === 'tenants' && request.method === 'PUT') { const field = { users: 'username', groups: 'groupId', roles: 'roleId', clients: 'clientId' }[p[4]]; state.tm[p[3]][p[4]].push({ [field]: p[5] }); return null; }
      if (p[2] === 'roles' && p[4] === 'groups') { state.roleGroups.push(p[5]); state.gr[p[5]].push(p[3]); return null; }
      if (p[2] === 'groups' && p[4] === 'users') { if (request.method === 'PUT') state.gu[p[3]].push(p[5]); else state.gu[p[3]] = state.gu[p[3]].filter(email => email !== p[5]); return null; }
      throw Error('Unexpected Runtime action ' + endpoint);
    }
    if (p[2] === 'roles') return { roleId: p[3] };
    if (p[2] === 'tenants') { const found = state.tenants.find(t => t.tenantId === p[3]); if (!found) throw new ApiError('Tenant', 404); return found; }
    throw Error('Unexpected Runtime ' + endpoint);
  } };
  const context = { organizationApi, runtimeApi, runtimeBase: 'https://runtime.example.org', environmentId: 'env', expectedOrganization: org, runtimeClientId: 'client', runtimeRole: 'studierende', protectedEmails: ['teacher@example.org', 'owner@example.org'], revision: 'ctx1' };
  const cleanup = new Cleanup({ root, contextForSite: () => context, wait: async () => {} });
  let clock = Date.now();
  const manager = new Classroom({ root, contextForSite: () => context, cleanup, now: () => clock, parse: async () => ({ sheets: [] }), analyze: async () => ({ students: people, warnings: [], model: 'mock', transmittedRows: 3 }) });
  const input = { site: 'basel', lecturerEmail: 'teacher@example.org', day: 'mi', filename: 'roster.xlsx', base64: 'mock', aiConsent: 'full-workbook-v1' };
  return { root, state, writes, manager, context, people, input, advance: () => { clock += 360000; }, fail: endpoint => { failEndpoint = endpoint; }, async draft() { const p = await manager.importPreview(input); return manager.saveImport(p.previewId, true).classroom; }, async provision(c) { const p = await manager.provisionPreview(c.id); return manager.provision(p.previewId, true); } };
}

test('import and local group edits do not write to Camunda and use lecturer/day/group names', async t => {
  const f = fixture(t), c = await f.draft(); assert.equal(c.groups[0].workspaceName, 'Teacher Name_Mi_Gruppe 1'); assert.equal(f.writes.length, 0);
  const p = await f.manager.movePreview(c.id, 'one@example.org', c.groups[1].id); assert.equal(p.localOnly, true); await f.manager.move(p.previewId, true);
  assert.equal(f.manager.get(c.id).groups[1].students.length, 2); assert.equal(f.writes.length, 0);
  f.manager.addGroup(c.id, 'Gruppe 4'); assert.equal(f.manager.get(c.id).groups.length, 4);
});

test('a completely cleaned class can be imported anew without reusing old invitation receipts or deleting its history', async t => {
  const f = fixture(t), c = await f.draft();
  c.status = 'cleaned'; c.cleanupState = { students: ['one@example.org'] }; c.invitationAttempts = { 'one@example.org': { status: 'submitted' } }; c.autoAccess = { status: 'cleanup', enabled: false };
  f.manager.save({ schemaVersion: 1, classes: [c] });
  await assert.rejects(f.manager.provisionPreview(c.id), /bereinigt/);
  const plan = await f.manager.importPreview(f.input), result = f.manager.saveImport(plan.previewId, true);
  assert.equal(result.classroom.status, 'draft'); assert.equal(result.classroom.cleanupState, undefined); assert.equal(result.classroom.invitationAttempts, undefined);
  const stored = f.manager.load(); assert.equal(stored.archivedClasses.length, 1); assert.equal(stored.archivedClasses[0].status, 'cleaned'); assert.equal(f.writes.length, 0);
});

test('configured lecturer and owner accounts are listed separately while students continue to provisioning', async t => {
  const f = fixture(t, { students: [
    { email: 'one@example.org', name: 'One', group: 'Gruppe 1' },
    { email: 'teacher@example.org', name: 'Excel Teacher', group: 'Nur Dozenten', source: { sheet: 'Klasse', row: 3 } },
    { email: 'owner@example.org', name: 'Excel Owner', group: 'Gruppe 1', source: { sheet: 'Klasse', row: 4 } },
  ] });
  const configFile = path.join(f.root, 'admin-config.json'), config = JSON.parse(fs.readFileSync(configFile));
  config.lecturers[0].sites.basel = false; fs.writeFileSync(configFile, JSON.stringify(config));
  const p = await f.manager.importPreview({ ...f.input, lecturerEmail: 'owner@example.org' });
  assert.equal(f.writes.length, 0); assert.equal(p.excludedLecturers.length, 2);
  assert.equal(p.excludedLecturers[0].configuredName, 'Teacher Name'); assert.equal(p.excludedLecturers[0].source.row, 3);
  assert.equal(p.classroom.groups.length, 1); assert.deepEqual(p.classroom.groups[0].students.map(s => s.email), ['one@example.org']);
  assert.deepEqual(p.structuredRoster.groups.flatMap(g => g.students).map(s => s.email), ['one@example.org']);
  assert.equal(p.structuredRoster.excludedLecturers.length, 2); assert.ok(p.warnings.some(w => w.includes('separat')));
  const saved = f.manager.saveImport(p.previewId, true).classroom;
  assert.equal(saved.excludedLecturers.length, 2);
  const result = await f.provision(saved); assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(f.state.gu[result.classroom.groups[0].id], ['one@example.org']);
  assert.ok(f.state.wm[result.classroom.groups[0].workspaceKey].some(m => m.email === 'owner@example.org' && m.role === 'workspace_admin'));
});

test('lecturer-only workbook still returns findings and cannot replace an existing student draft', async t => {
  const f = fixture(t), existing = await f.draft();
  f.manager.analyze = async () => ({ students: [{ email: 'teacher@example.org', name: 'Teacher', group: 'Dozenten' }], warnings: [], model: 'mock', transmittedRows: 2, transmittedSheets: 1 });
  const p = await f.manager.importPreview(f.input);
  assert.equal(p.previewId, null); assert.equal(p.classroom.groups.length, 0); assert.equal(p.excludedLecturers.length, 1);
  assert.ok(p.warnings.some(w => w.includes('Keine Studierenden')));
  assert.throws(() => f.manager.saveImport(p.previewId, true), /Vorschau/);
  assert.equal(f.manager.get(existing.id).revision, existing.revision); assert.equal(f.writes.length, 0);
});
test('variable class groups receive separate workspaces and only their own tenant READ, with idempotent provisioning', async t => {
  const f = fixture(t), c = await f.draft(), before = await f.manager.provisionPreview(c.id); assert.equal(f.writes.length, 0); assert.equal(before.groups.length, 3);
  const r = await f.manager.provision(before.previewId, true); assert.equal(r.status, 'completed', r.error); assert.equal(r.classroom.status, 'ready');
  assert.equal(f.state.workspaces.length, 3); assert.equal(f.state.groups.length, 3); assert.equal(f.state.tenants.length, 4);
  for (const g of r.classroom.groups) {
    assert.ok(f.state.wm[g.workspaceKey].some(m => m.email === 'teacher@example.org' && m.role === 'workspace_admin'));
    assert.ok(before.groups.find(x => x.name === g.workspaceName).adminEmail === 'teacher@example.org');
    assert.ok(f.state.tm[g.tenantId].roles.some(r => r.roleId === 'admin'));
    assert.ok(!f.state.gr[g.runtimeGroupId].includes('admin'));
  }
  for (const g of r.classroom.groups) { assert.deepEqual(f.state.gu[g.runtimeGroupId], g.students.map(s => s.email)); const grant = f.state.grants.find(a => a.ownerId === g.runtimeGroupId); assert.equal(grant.resourceId, g.tenantId); assert.deepEqual(grant.permissionTypes, ['READ']); }
  const count = f.writes.length; const again = await f.provision(f.manager.get(c.id)); assert.equal(again.status, 'completed', again.error); assert.equal(f.writes.length, count);
});

test('stale or missing sample-only consent rejects before reading or sending the workbook', async t => {
  const f = fixture(t);
  f.manager.parse = async () => assert.fail('No file processing without full workbook consent');
  for (const aiConsent of [undefined, false, true, 'sample']) await assert.rejects(f.manager.importPreview({ ...f.input, aiConsent }), /sämtlicher Tabelleninhalte/);
  assert.equal(f.writes.length, 0);
});
test('live group move revokes source access, grants target access and leaves another class membership intact', async t => {
  const f = fixture(t), draft = await f.draft(); const r = await f.provision(draft); const c = r.classroom, from = c.groups[0], to = c.groups[1];
  f.state.groups.push({ groupId: 'outside', name: 'Other class' }); f.state.gu.outside = ['one@example.org']; f.state.gr.outside = ['studierende']; f.state.roleGroups.push('outside');
  const start = f.writes.length, p = await f.manager.movePreview(c.id, 'one@example.org', to.id); assert.equal(f.writes.length, start);
  const result = await f.manager.move(p.previewId, true); assert.equal(result.status, 'completed', result.error);
  assert.ok(!f.state.gu[from.id].includes('one@example.org')); assert.ok(f.state.gu[to.id].includes('one@example.org')); assert.deepEqual(f.state.gu.outside, ['one@example.org']);
  assert.ok(!f.state.wm[from.workspaceKey].some(m => m.email === 'one@example.org')); assert.ok(f.state.wm[to.workspaceKey].some(m => m.email === 'one@example.org' && m.role === 'editor'));
  assert.ok(!f.writes.slice(start).some(w => w.endpoint.includes('outside')));
});
test('partly applied move can be explicitly resumed without repeating already confirmed removals', async t => {
  const f = fixture(t), r = await f.provision(await f.draft()), from = r.classroom.groups[0], to = r.classroom.groups[1];
  const p = await f.manager.movePreview(r.classroom.id, 'one@example.org', to.id); f.fail('/workspaces/' + to.workspaceKey + '/members');
  const failed = await f.manager.move(p.previewId, true); assert.equal(failed.status, 'incomplete'); assert.ok(f.manager.get(r.classroom.id).pendingMove);
  const removes = f.writes.filter(w => w.request.method === 'DELETE').length;
  const retry = await f.manager.movePreview(r.classroom.id, 'one@example.org', to.id); const result = await f.manager.move(retry.previewId, true); assert.equal(result.status, 'completed', result.error);
  assert.equal(f.writes.filter(w => w.request.method === 'DELETE').length, removes);
});
test('pending invitation is recorded and never sent twice while membership is not yet visible', async t => {
  const f = fixture(t, { missingStudent: 'one@example.org' }), r = await f.provision(await f.draft()); assert.equal(r.status, 'completed', r.error); assert.equal(r.classroom.status, 'pending');
  assert.equal(f.writes.filter(w => w.endpoint === '/members/one%40example.org').length, 1);
  const next = await f.manager.provisionPreview(r.classroom.id); assert.equal(next.invitations.length, 0); const again = await f.manager.provision(next.previewId, true); assert.equal(again.status, 'completed', again.error);
  assert.equal(f.writes.filter(w => w.endpoint === '/members/one%40example.org').length, 1);
});

test('workspace and known runtime account can be prepared before organization invitation acceptance', async t => {
  const f = fixture(t); f.state.members.find(m => m.email === 'one@example.org').invitePending = true;
  const r = await f.provision(await f.draft()), g = r.classroom.groups[0];
  assert.equal(r.status, 'completed', r.error); assert.equal(r.classroom.status, 'pending');
  assert.ok(f.state.wm[g.workspaceKey].some(m => m.email === 'one@example.org' && m.role === 'editor'));
  assert.ok(f.state.gu[g.runtimeGroupId].includes('one@example.org'));
  assert.equal(r.classroom.autoAccess.enabled, true);
  f.state.members.find(m => m.email === 'one@example.org').invitePending = false;
  const before = f.writes.length; await f.manager.access.tick();
  assert.equal(f.manager.get(r.classroom.id).status, 'ready'); assert.equal(f.writes.length, before);
});

test('persistent automatic completion only assigns approved users to existing targets, without new organization invitations', async t => {
  const f = fixture(t, { missingStudent: 'one@example.org' }), r = await f.provision(await f.draft());
  const start = f.writes.length; await f.manager.access.tick();
  assert.equal(f.writes.length, start); assert.equal(f.manager.get(r.classroom.id).status, 'pending');
  f.state.members.push({ email: 'one@example.org', roles: ['modeler'] }); f.advance();
  // Simulate process restart: no in-memory preview or queue needs to survive.
  const { ClassAccess } = require('../lib/class-access'); f.manager.access = new ClassAccess(f.manager);
  await f.manager.access.tick();
  const after = f.manager.get(r.classroom.id), g = after.groups[0];
  assert.equal(after.status, 'ready'); assert.equal(after.autoAccess.status, 'completed');
  assert.ok(f.state.wm[g.workspaceKey].some(m => m.email === 'one@example.org' && m.role === 'editor'));
  assert.ok(f.state.gu[g.runtimeGroupId].includes('one@example.org'));
  assert.ok(f.writes.slice(start).every(w => w.endpoint === '/workspaces/' + g.workspaceKey + '/members' || w.endpoint === '/v2/groups/' + g.id + '/users/one%40example.org'));
  assert.equal(f.writes.filter(w => w.endpoint === '/members/one%40example.org').length, 1);
  const count = f.writes.length; f.advance(); await f.manager.access.tick(); assert.equal(f.writes.length, count);
});

test('automatic completion stops on changed authorization scope or privileged users and respects cleanup locks', async t => {
  for (const kind of ['context', 'scope', 'privileged']) {
    const f = fixture(t, { missingStudent: 'one@example.org' }), r = await f.provision(await f.draft());
    f.state.members.push({ email: 'one@example.org', roles: [kind === 'privileged' ? 'admin' : 'modeler'] });
    if (kind === 'context') f.context.revision = 'ctx2';
    if (kind === 'scope') { const data = f.manager.load(); data.classes[0].groups[0].students[0].email = 'other@example.org'; f.manager.save(data); }
    const count = f.writes.length; await f.manager.access.tick();
    assert.equal(f.writes.length, count); assert.equal(f.manager.get(r.classroom.id).autoAccess.status, 'stopped');
  }
  const f = fixture(t, { missingStudent: 'one@example.org' }), r = await f.provision(await f.draft());
  f.state.members.push({ email: 'one@example.org', roles: ['modeler'] });
  const count = f.writes.length; f.manager.cleanup.busy.add('basel'); await f.manager.access.tick();
  assert.equal(f.writes.length, count); f.manager.cleanup.busy.delete('basel');
  fs.writeFileSync(path.join(f.root, 'cleanup-lock-basel.local.json'), 'other process');
  await f.manager.access.tick(); assert.equal(f.writes.length, count);
  assert.equal(fs.readFileSync(path.join(f.root, 'cleanup-lock-basel.local.json'), 'utf8'), 'other process');
});

test('workspace submission receipts prevent duplicate invitations when membership visibility is delayed', async t => {
  const f = fixture(t, { missingStudent: 'one@example.org' }), r = await f.provision(await f.draft());
  f.state.members.push({ email: 'one@example.org', roles: ['modeler'] });
  const original = f.context.organizationApi.hub;
  f.context.organizationApi.hub = async (endpoint, request = {}) => {
    if (request.method === 'POST' && endpoint.endsWith('/members')) { f.writes.push({ endpoint, request }); return null; }
    return original(endpoint, request);
  };
  await f.manager.access.tick(); const count = f.writes.length;
  f.advance(); await f.manager.access.tick(); assert.equal(f.writes.length, count);
  assert.equal(f.manager.get(r.classroom.id).status, 'pending');
  const g = f.manager.get(r.classroom.id).groups[0];
  f.state.wm[g.workspaceKey].push({ email: 'one@example.org', role: 'editor' }); f.advance(); await f.manager.access.tick();
  assert.equal(f.manager.get(r.classroom.id).status, 'ready'); assert.equal(f.writes.length, count);
});

test('unknown runtime users are completed automatically once available, without resending workspace access', async t => {
  const f = fixture(t), original = f.context.runtimeApi.runtime; let known = false;
  f.context.runtimeApi.runtime = async (base, endpoint, request = {}) => {
    if (!known && request.method === 'PUT' && endpoint.endsWith('/users/one%40example.org')) throw new ApiError('Unknown user', 404);
    return original(base, endpoint, request);
  };
  const r = await f.provision(await f.draft()); assert.equal(r.status, 'completed', r.error); assert.equal(r.classroom.status, 'pending');
  const workspacePosts = f.writes.filter(w => w.endpoint.endsWith('/members')).length;
  await f.manager.access.tick(); assert.equal(f.manager.get(r.classroom.id).status, 'pending');
  known = true; f.advance(); await f.manager.access.tick();
  assert.equal(f.manager.get(r.classroom.id).status, 'ready');
  assert.equal(f.writes.filter(w => w.endpoint.endsWith('/members')).length, workspacePosts);
});

test('rejected pending workspace invitations are deferred until acceptance and automatics can be paused', async t => {
  const f = fixture(t), member = f.state.members.find(m => m.email === 'one@example.org'); member.invitePending = true;
  const original = f.context.organizationApi.hub;
  f.context.organizationApi.hub = async (endpoint, request = {}) => {
    if (member.invitePending && request.method === 'POST' && request.body.email === member.email) throw new ApiError('Not ready', 400);
    return original(endpoint, request);
  };
  f.context.organizationApi.request = async () => { throw new ApiError('Pending user', 404); };
  const r = await f.provision(await f.draft()); assert.equal(r.status, 'completed', r.error);
  const key = r.classroom.groups[0].id + ':' + member.email;
  assert.equal(r.classroom.workspaceAccessAttempts[key].status, 'deferred');
  await f.manager.access.configure(r.classroom.id, false);
  member.invitePending = false; const before = f.writes.length;
  f.advance(); await f.manager.access.tick(); assert.equal(f.writes.length, before);
  await f.manager.access.configure(r.classroom.id, true); await f.manager.access.tick();
  assert.equal(f.manager.get(r.classroom.id).status, 'ready');
  assert.equal(f.manager.get(r.classroom.id).workspaceAccessAttempts[key].status, 'submitted');
});
test('privileged students, stale previews, foreign collisions and cross-site inputs never authorize class writes', async t => {
  const f = fixture(t), c = await f.draft(); f.state.members.find(m => m.email === 'one@example.org').roles = ['admin']; await assert.rejects(f.manager.provisionPreview(c.id), /privilegiert/); assert.equal(f.writes.length, 0);
  await assert.rejects(f.manager.importPreview({ ...f.input, lecturerEmail: 'unknown@example.org' }));
  const g = fixture(t), d = await g.draft(), plan = await g.manager.provisionPreview(d.id); g.state.workspaces.push({ workspaceKey: 'foreign', name: d.groups[0].workspaceName });
  const result = await g.manager.provision(plan.previewId, true); assert.equal(result.status, 'incomplete'); assert.equal(g.writes.length, 0);
});
