const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LecturerResources, targetFor } = require('../lib/lecturer-resources');
const { ApiError } = require('../lib/camunda-api');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-lecturer-'));
  t.after(() => { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); });
  const org = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', sites = { basel: true, brugg: false, olten: false };
  const config = { schemaVersion: 1, organizations: { basel: org, brugg: org, olten: org }, organizationRole: 'admin', removeOtherOrganizationRoles: true, unselectedSites: 'leave_unchanged', protectedOwners: [{ email: 'owner@example.org', name: 'Owner', sites: { ...sites, brugg: true, olten: true } }], lecturers: [{ email: 'teacher@example.org', name: 'Teacher Name', sites }] };
  fs.writeFileSync(path.join(root, 'admin-config.json'), JSON.stringify(config));
  const state = { members: [{ email: 'owner@example.org', roles: ['owner'] }, { email: 'teacher@example.org', roles: ['admin'] }], workspaces: [], workspaceMembers: [], projects: [], env: [], tenants: [{ tenantId: '<default>', name: 'Default' }], memberships: {}, grants: [{ ownerType: 'CLIENT', ownerId: 'client', resourceType: 'AUTHORIZATION', resourceId: '*', permissionTypes: ['READ', 'CREATE'] }, { ownerType: 'CLIENT', ownerId: 'client', resourceType: 'PROCESS_DEFINITION', resourceId: '*', permissionTypes: ['READ_PROCESS_INSTANCE', 'READ_USER_TASK'] }] };
  const writes = [], page = items => ({ items: structuredClone(items), page: { totalItems: items.length, hasMoreTotalItems: false } });
  const api = {
    async hub(endpoint, options = {}) {
      if (endpoint === '/info') return { authorizedOrganization: org };
      if (endpoint === '/workspaces/search') return page(state.workspaces);
      if (endpoint === '/members/search') return page(state.workspaceMembers);
      if (endpoint === '/projects/search') return page(state.projects);
      if (endpoint === '/workspaces' && options.method === 'POST') { writes.push({ endpoint, options }); const w = { workspaceKey: 'w1', name: options.body.name }; state.workspaces.push(w); return w; }
      if (endpoint === '/workspaces/w1/members' && options.method === 'POST') { writes.push({ endpoint, options }); state.workspaceMembers.push(options.body); return {}; }
      if (endpoint === '/workspaces/w1/environments') { if (options.method === 'PUT') { writes.push({ endpoint, options }); state.env = options.body.environmentIds.map(id => ({ id })); } return page(state.env); }
      if (endpoint === '/workspaces/w1' && options.method === 'DELETE') { writes.push({ endpoint, options }); state.workspaces = []; state.projects = []; return null; }
      throw Error('Unexpected Hub ' + endpoint);
    },
    async console(endpoint, options = {}) {
      if (endpoint === '/members') return structuredClone(state.members);
      if (options.method === 'DELETE') { writes.push({ endpoint, options }); state.members = state.members.filter(m => m.email !== decodeURIComponent(endpoint.slice('/members/'.length))); return null; }
      throw Error('Unexpected Console ' + endpoint);
    },
  };
  const runtimeApi = { async runtime(_base, endpoint, options = {}) {
    const p = endpoint.split('/').map(decodeURIComponent);
    if (endpoint === '/v2/topology') return { gatewayVersion: '8.9.19' };
    if (endpoint === '/v2/authentication/me') return { tenants: state.tenants };
    if (endpoint.endsWith('/search')) {
      if (endpoint === '/v2/tenants/search') return page(state.tenants);
      if (endpoint === '/v2/authorizations/search') return page(state.grants.filter(a => a.ownerType === options.body.filter.ownerType && a.ownerId === options.body.filter.ownerId));
      if (p[2] === 'tenants') return page(state.memberships[p[3]]?.[p[4]] || []);
      return page([]);
    }
    if (options.method) {
      writes.push({ endpoint, options });
      if (endpoint === '/v2/tenants' && options.method === 'POST') { state.tenants.push(options.body); state.memberships[options.body.tenantId] = { users: [], roles: [], groups: [], clients: [], 'mapping-rules': [] }; return {}; }
      if (endpoint === '/v2/authorizations') { state.grants.push(options.body); return {}; }
      if (p[2] === 'tenants' && options.method === 'PUT') { const field = { users: 'username', roles: 'roleId', clients: 'clientId' }[p[4]]; state.memberships[p[3]][p[4]].push({ [field]: p[5] }); return null; }
      if (p[2] === 'tenants' && options.method === 'DELETE') { state.tenants = state.tenants.filter(t => t.tenantId !== p[3]); return null; }
      throw Error('Unexpected Runtime mutation ' + endpoint);
    }
    if (p[2] === 'tenants') { const tenant = state.tenants.find(t => t.tenantId === p[3]); if (!tenant) throw new ApiError('Tenant', 404); return structuredClone(tenant); }
    if (p[2] === 'roles') return { roleId: p[3] };
    throw Error('Unexpected Runtime ' + endpoint);
  } };
  const context = { organizationApi: api, runtimeApi, runtimeBase: 'https://runtime.example.org', environmentId: 'environment', expectedOrganization: org, runtimeClientId: 'client', runtimeRole: 'studierende', protectedEmails: ['owner@example.org', 'teacher@example.org'], revision: 'ctx1' };
  const manager = new LecturerResources({ root, contextForSite: () => context, wait: async () => {} });
  return { root, config, manager, state, writes, context, async create() { const p = (await manager.preview('basel', 'teacher@example.org', 'create')).preview; return manager.apply(p.id, true); } };
}

test('private target is stable across name edits, and uses the requested workspace name', () => {
  const a = targetFor({ email: 'teacher@example.org', name: 'Teacher Name' }, 'org'), b = targetFor({ email: 'teacher@example.org', name: 'Edited' }, 'org');
  assert.equal(a.workspaceName, 'Teacher Name_Private_Workspace'); assert.equal(a.tenantId, b.tenantId); assert.ok(a.tenantId.length <= 31);
});
test('private preview is read-only, cannot remove owners, and creation is verified and repeatable', async t => {
  const f = fixture(t); const p = (await f.manager.preview('basel', 'teacher@example.org', 'create')).preview;
  assert.equal(f.writes.length, 0); await assert.rejects(f.manager.preview('basel', 'owner@example.org', 'remove'), /Owner/);
  const result = await f.manager.apply(p.id, true); assert.equal(result.status, 'completed', result.error);
  assert.equal((await f.manager.read('basel', 'teacher@example.org')).ready, true);
  assert.equal(f.state.workspaces[0].name, 'Teacher Name_Private_Workspace');
  assert.ok(f.state.grants.some(a => a.ownerType === 'USER' && a.ownerId === 'teacher@example.org' && a.resourceType === 'TENANT' && a.resourceId !== '*'));
  const count = f.writes.length; await assert.rejects(f.manager.preview('basel', 'teacher@example.org', 'create')); assert.equal(f.writes.length, count);
  await assert.rejects(f.manager.apply(p.id, true));
});

test('configured owner can create missing private resources without changing organization roles or owner settings', async t => {
  const f = fixture(t), configBefore = fs.readFileSync(path.join(f.root, 'admin-config.json'), 'utf8');
  const inventory = await f.manager.all(), ownerRows = inventory.rows.filter(r => r.email === 'owner@example.org');
  assert.equal(ownerRows.length, 3); assert.ok(ownerRows.every(r => r.protectedOwner && r.canCreate && !r.canRemove));
  const p = (await f.manager.preview('basel', 'owner@example.org', 'create')).preview;
  assert.equal(f.writes.length, 0); assert.equal(p.workspaceName, 'Owner_Private_Workspace');
  const result = await f.manager.apply(p.id, true); assert.equal(result.status, 'completed', result.error);
  assert.equal((await f.manager.read('basel', 'owner@example.org')).ready, true);
  assert.deepEqual(f.state.members[0].roles, ['owner']); assert.equal(fs.readFileSync(path.join(f.root, 'admin-config.json'), 'utf8'), configBefore);
  assert.ok(!f.writes.some(w => w.endpoint.startsWith('/members/') || w.options.method === 'DELETE'));
  assert.equal(f.manager.row(await f.manager.read('basel', 'owner@example.org'), 'basel').canRemove, false);
  const count = f.writes.length;
  await assert.rejects(f.manager.preview('basel', 'owner@example.org', 'create'));
  await assert.rejects(f.manager.preview('basel', 'owner@example.org', 'remove'), /Owner/);
  assert.equal(f.writes.length, count);
});

test('owner removal stays blocked when runtime is unavailable and an unexpected owner cannot be managed as lecturer', async t => {
  const f = fixture(t);
  f.state.members[1].roles = ['owner']; await assert.rejects(f.manager.preview('basel', 'teacher@example.org', 'create'), /Owner/);
  f.context.runtimeApi.runtime = async () => { throw new Error('Runtime unavailable'); };
  await assert.rejects(f.manager.preview('basel', 'owner@example.org', 'remove'), /Owner/);
  const inventory = await f.manager.all();
  assert.ok(inventory.rows.filter(r => r.email === 'owner@example.org').every(r => r.protectedOwner && !r.canRemove));
  assert.equal(f.writes.length, 0);
});
test('separate removal deletes only registered private resources and one site membership', async t => {
  const f = fixture(t); assert.equal((await f.create()).status, 'completed');
  f.state.projects.push({ projectKey: 'p1', name: 'Demo' });
  const preview = (await f.manager.preview('basel', 'teacher@example.org', 'remove')).preview;
  assert.equal(preview.runtimeCounts[0].processInstances, 0);
  const result = await f.manager.apply(preview.id, true); assert.equal(result.status, 'completed', result.error);
  assert.equal(f.state.workspaces.length, 0); assert.equal(f.state.tenants.length, 1); assert.equal(f.state.tenants[0].tenantId, '<default>');
  assert.deepEqual(f.state.members.map(m => m.email), ['owner@example.org']);
  const config = JSON.parse(fs.readFileSync(path.join(f.root, 'admin-config.json'))); assert.equal(config.lecturers[0].sites.basel, false);
});

test('workspace admin compatibility uses the documented project_admin role and verifies through v2', async t => {
  const f = fixture(t), hub = f.context.organizationApi.hub;
  f.context.organizationApi.hub = async (endpoint, options = {}) => {
    if (endpoint === '/workspaces/w1/members' && options.method === 'POST') throw new ApiError('Members', 400);
    return hub(endpoint, options);
  };
  const fallback = [];
  f.context.organizationApi.request = async (base, endpoint, options) => {
    assert.equal(base, 'https://hub.camunda.io'); assert.equal(endpoint, '/api/v1/collaborators');
    assert.equal(options.method, 'PUT'); assert.equal(options.body.role, 'project_admin');
    fallback.push(options.body); f.state.workspaceMembers.push({ email: options.body.email, role: 'workspace_admin' });
    return {};
  };
  const result = await f.create(); assert.equal(result.status, 'completed', result.error);
  assert.equal(fallback.length, 1); assert.equal((await f.manager.read('basel', 'teacher@example.org')).ready, true);
});
test('untracked collisions, shared private resources and changed snapshots block writes', async t => {
  const collision = fixture(t); collision.state.workspaces.push({ workspaceKey: 'foreign', name: 'Teacher Name_Private_Workspace' });
  await assert.rejects(collision.manager.preview('basel', 'teacher@example.org', 'create'), /ohne bestätigte Zuordnung/); assert.equal(collision.writes.length, 0);
  const shared = fixture(t); await shared.create(); shared.state.workspaceMembers.push({ email: 'student@example.org', role: 'editor' });
  await assert.rejects(shared.manager.preview('basel', 'teacher@example.org', 'remove'), /weitere Mitglieder/);
  const changed = fixture(t), plan = (await changed.manager.preview('basel', 'teacher@example.org', 'create')).preview;
  changed.state.members[1].roles = ['owner']; const result = await changed.manager.apply(plan.id, true);
  assert.equal(result.status, 'incomplete'); assert.equal(changed.writes.length, 0);
});
