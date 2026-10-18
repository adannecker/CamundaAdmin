const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Cleanup } = require('../lib/cleanup');
const { ApiError } = require('../lib/camunda-api');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-cleanup-'));
  t.after(() => { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); });
  const page = items => ({ items: structuredClone(items), page: { hasMoreTotalItems: false, totalItems: items.length } });
  const state = {
    members: [{ email: 'student@example.org', name: 'Student', roles: ['modeler'] }, { email: 'owner@example.org', name: 'Owner', roles: ['owner', 'admin'] }],
    workspaces: [{ workspaceKey: 'w1', name: 'Group 1' }], projects: [{ projectKey: 'p1', name: 'Project 1' }],
    workspaceMembers: [{ email: 'student@example.org', role: 'editor' }, { email: 'owner@example.org', role: 'admin' }],
    groups: [{ groupId: 'g1', name: 'Group 1' }, { groupId: 'g2', name: 'Group 2' }],
    groupUsers: { g1: ['student@example.org'], g2: [] }, directStudents: options.directStudent ? ['student@example.org'] : [],
    tenants: [{ tenantId: '<default>', name: 'Default' }, { tenantId: 't1', name: 'Group 1' }, { tenantId: 't2', name: 'Group 2' }],
    authorizations: options.noCreate ? [] : [{ ownerType: 'CLIENT', ownerId: 'client', resourceType: 'AUTHORIZATION', resourceId: '*', permissionTypes: ['READ', 'CREATE'] }],
    extraRoleUsers: options.runtimeAdmin ? ['student@example.org'] : [],
    tenantGroups: { t1: ['g1'], t2: ['g2'], '<default>': [] },
    processes: options.processes ? [
      { processInstanceKey: '101', processDefinitionId: 'p-group1', tenantId: 't1', parentProcessInstanceKey: null, state: 'ACTIVE' },
      { processInstanceKey: '102', processDefinitionId: 'child-group1', tenantId: 't1', parentProcessInstanceKey: '101', state: 'ACTIVE' },
      { processInstanceKey: '201', processDefinitionId: 'p-group2', tenantId: 't2', parentProcessInstanceKey: null, state: 'ACTIVE' },
    ] : [],
    tasks: options.processes ? [{ userTaskKey: '1001', processInstanceKey: '102', tenantId: 't1', state: 'CREATED' }, { userTaskKey: '2001', processInstanceKey: '201', tenantId: 't2', state: 'CREATED' }] : [],
  };
  if (!options.noRead) state.authorizations.push({ ownerType: 'CLIENT', ownerId: 'client', resourceType: 'PROCESS_DEFINITION', resourceId: '*', permissionTypes: ['READ_PROCESS_INSTANCE', 'READ_USER_TASK'] });
  const writes = [], reads = [], waits = [], staleUsers = new Map(); let staleTenantGroupReads = 0;
  const organizationApi = {
    async hub(endpoint, request) {
      if (request?.method === 'DELETE') { writes.push({ endpoint, request }); if (options.failDelete) throw new Error('Connection lost'); state.workspaces = []; state.projects = []; return null; }
      reads.push(endpoint);
      if (endpoint === '/info') return { authorizedOrganization: 'org-a' };
      if (endpoint === '/workspaces/search') return page(state.workspaces);
      if (endpoint === '/members/search') return page(state.workspaceMembers);
      if (endpoint === '/projects/search') return page(state.projects);
      throw new Error('Unexpected Hub ' + endpoint);
    },
    async console(endpoint, request) {
      if (!request?.method || request.method === 'GET') { assert.equal(endpoint, '/members'); return structuredClone(state.members); }
      assert.equal(request.method, 'DELETE'); writes.push({ endpoint, request });
      const email = decodeURIComponent(endpoint.slice('/members/'.length)); state.members = state.members.filter(m => m.email !== email); return null;
    },
  };
  const runtimeApi = { async runtime(_base, endpoint, request = {}) {
    const parts = endpoint.split('/').map(decodeURIComponent);
    if (endpoint.endsWith('/search')) {
      reads.push(endpoint);
      if (endpoint === '/v2/groups/search') return page(state.groups);
      if (endpoint === '/v2/tenants/search') return page(state.tenants);
      if (endpoint === '/v2/roles/search') return page([{ roleId: 'studierende' }, { roleId: 'admin' }]);
      if (endpoint === '/v2/authorizations/search') return page(state.authorizations.filter(a => a.ownerType === request.body.filter.ownerType && a.ownerId === request.body.filter.ownerId));
      if (endpoint === '/v2/process-instances/search' || endpoint === '/v2/user-tasks/search') {
        const filter = request.body.filter;
        assert.equal(request.body.sort[0].field, endpoint.includes('user-tasks') ? 'creationDate' : 'processInstanceKey');
        if (options.failDataRead) throw new Error('Data read failed');
        let rows = endpoint.includes('user-tasks') ? state.tasks : state.processes;
        if (filter.tenantId && !options.leakTenant) rows = rows.filter(p => p.tenantId === filter.tenantId);
        if (filter.parentProcessInstanceKey) rows = rows.filter(p => p.parentProcessInstanceKey === filter.parentProcessInstanceKey);
        const result = page(rows); if (options.truncated) result.page.totalItems++; return result;
      }
      if (parts[2] === 'roles' && parts[4] === 'users') return page((parts[3] === 'studierende' ? state.directStudents : state.extraRoleUsers).map(username => ({ username })));
      if (parts[2] === 'roles' && parts[4] === 'groups') return page(parts[3] === 'studierende' ? state.groups : []);
      if (parts[2] === 'groups' && parts[4] === 'users') {
        const old = staleUsers.get(parts[3]);
        if (old && old.left-- > 0) return page(old.users.map(username => ({ username })));
        return page(state.groupUsers[parts[3]].map(username => ({ username })));
      }
      if (parts[2] === 'groups' && parts[4] === 'roles') return page([{ roleId: 'studierende' }]);
      if (parts[2] === 'groups' && ['clients', 'mapping-rules'].includes(parts[4])) return page(options.sharedClient && parts[4] === 'clients' ? [{ clientId: 'other' }] : []);
      if (parts[2] === 'tenants') {
        if (parts[4] === 'groups') return page((state.tenantGroups[parts[3]] || []).filter(id => state.groups.some(g => g.groupId === id) || staleTenantGroupReads-- > 0).map(groupId => ({ groupId })));
        if (parts[4] === 'roles') return page(['admin', 'connectors', 'app-integrations'].map(roleId => ({ roleId })));
        if (parts[4] === 'clients') return page([{ clientId: 'client' }]);
        if (parts[4] === 'users' || parts[4] === 'mapping-rules') return page([]);
      }
      throw new Error('Unexpected search ' + endpoint);
    }
    if (request.method === 'DELETE') {
      writes.push({ endpoint, request });
      if (parts[2] === 'tenants' && parts.length === 4) state.tenants = state.tenants.filter(t => t.tenantId !== parts[3]);
      else if (parts[2] === 'tenants' && parts[4] === 'groups') state.tenantGroups[parts[3]] = state.tenantGroups[parts[3]].filter(id => id !== parts[5]);
      else if (parts[2] === 'groups' && parts.length === 4) { state.groups = state.groups.filter(g => g.groupId !== parts[3]); staleTenantGroupReads = options.tenantGroupDelayReads || 0; }
      else if (parts[2] === 'groups' && parts[4] === 'users') {
        staleUsers.set(parts[3], { left: options.groupDelayReads || 0, users: [...state.groupUsers[parts[3]]] });
        state.groupUsers[parts[3]] = state.groupUsers[parts[3]].filter(email => email !== parts[5]);
      }
      else if (parts[2] === 'roles' && parts[4] === 'users') state.directStudents = state.directStudents.filter(email => email !== parts[5]);
      else throw new Error('Unexpected delete ' + endpoint);
      return null;
    }
    if (endpoint === '/v2/authorizations' && request.method === 'POST') { writes.push({ endpoint, request }); state.authorizations.push(structuredClone(request.body)); return { authorizationKey: 'key' }; }
    if (endpoint === '/v2/topology') return { gatewayVersion: options.oldVersion ? '8.8.20' : '8.9.19' };
    if (endpoint === '/v2/authentication/me') return { tenants: state.tenants };
    if (parts[2] === 'process-instances') {
      const process = state.processes.find(p => p.processInstanceKey === parts[3]);
      if (!process) throw new ApiError('Process', 404);
      if (request.method === 'POST') {
        writes.push({ endpoint, request });
        if (options.failProcessWrite) throw new Error('Connection lost');
        if (parts[4] === 'cancellation') {
          for (const p of state.processes.filter(p => p.tenantId === process.tenantId)) if (!options.lingerActive) p.state = 'TERMINATED';
        } else if (parts[4] === 'deletion') {
          state.processes = state.processes.filter(p => p !== process);
          if (!options.lingerTasks) state.tasks = state.tasks.filter(t => t.processInstanceKey !== process.processInstanceKey);
          if (options.revokeRead) state.authorizations = state.authorizations.filter(a => a.resourceType !== 'PROCESS_DEFINITION' || a.resourceId !== '*');
        } else throw new Error('Unexpected process action');
        return null;
      }
      return structuredClone(process);
    }
    if (parts[2] === 'roles') return { roleId: parts[3] };
    if (parts[2] === 'groups') { const group = state.groups.find(g => g.groupId === parts[3]); if (!group) throw new ApiError('Group', 404); return group; }
    if (parts[2] === 'tenants') { const tenant = state.tenants.find(t => t.tenantId === parts[3]); if (!tenant) throw new ApiError('Tenant', 404); return tenant; }
    throw new Error('Unexpected Runtime ' + endpoint);
  } };
  const context = { organizationApi, runtimeApi, runtimeBase: 'https://runtime.example.org', runtimeRole: 'studierende', runtimeClientId: 'client', expectedOrganization: 'org-a', protectedEmails: ['owner@example.org'], managedWorkspaceNames: ['Group 1'], revision: 'rev-1' };
  let now = 1000;
  const cleanup = new Cleanup({ root, contextForSite: () => context, now: () => now, wait: async ms => { waits.push({ ms, progress: structuredClone(cleanup.getProgress('basel')) }); } });
  const selection = { students: ['student@example.org'], workspaces: ['w1'], tenants: ['t1'] };
  return { cleanup, state, context, writes, reads, waits, root, selection, advance: ms => { now += ms; }, async preview(input = selection) { const a = await cleanup.analyze('basel'); return (await cleanup.preview('basel', a.analysisId, input)).preview; } };
}

test('analysis and preview never mutate; default tenant and owner cannot be selected', async t => {
  const f = fixture(t), analysis = await f.cleanup.analyze('basel');
  assert.equal(analysis.selection.students.find(p => p.id === 'owner@example.org').selectable, false);
  assert.equal(analysis.selection.tenants.find(p => p.id === '<default>').selectable, false);
  await assert.rejects(f.cleanup.preview('basel', analysis.analysisId, { students: ['owner@example.org'], workspaces: [], tenants: [] }), /nicht freigegeben/);
  await assert.rejects(f.cleanup.preview('basel', analysis.analysisId, { students: [], workspaces: [], tenants: ['<default>'] }), /nicht freigegeben/);
  const plan = await f.preview();
  assert.deepEqual(plan.permissionSummary, [{ resourceType: 'TENANT', count: 1 }, { resourceType: 'GROUP', count: 1 }]);
  assert.equal(plan.runtimeSnapshot, undefined); assert.equal(plan.permissionGrants, undefined);
  assert.deepEqual(plan.runtimeCounts, [{ tenantId: 't1', processInstances: 0, activeProcessInstances: 0, tasks: 0, runtimeGroups: 1 }]);
  assert.equal(f.writes.length, 0);
});

test('confirmed cleanup clears access and runtime group before deleting the empty tenant', async t => {
  const f = fixture(t, { directStudent: true }), plan = await f.preview();
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'completed');
  assert.ok(result.results.every(r => r.status === 'verified'));
  assert.deepEqual(result.results.map(r => r.kind), ['workspaces', 'runtime', 'students', 'tenants', 'groups']);
  assert.equal(f.state.members.length, 1); assert.equal(f.state.members[0].email, 'owner@example.org');
  assert.deepEqual(f.state.groupUsers.g1, []); assert.deepEqual(f.state.directStudents, []);
  assert.deepEqual(f.state.tenants.map(t => t.tenantId), ['<default>', 't2']);
  assert.deepEqual(f.state.groups.map(g => g.groupId), ['g2']);
  assert.ok(f.writes.some(w => w.endpoint === '/workspaces/w1' && w.request.method === 'DELETE'));
  assert.ok(!f.writes.some(w => /permanent|process-instances|process-definitions|user-tasks/.test(w.endpoint)));
  assert.equal(f.writes.at(-1).endpoint, '/v2/tenants/t1');
  await assert.rejects(f.cleanup.apply('basel', plan.id, true), /bereits verwendet/);
});

test('new elevated roles or a changed configuration invalidate preview before any deletion', async t => {
  for (const change of [f => { f.state.members[0].roles = ['admin']; }, f => { f.context.revision = 'rev-2'; }, f => { f.state.extraRoleUsers.push('student@example.org'); }]) {
    const f = fixture(t), plan = await f.preview(); change(f);
    await assert.rejects(f.cleanup.apply('basel', plan.id, true), /seit der Löschvorschau geändert/);
    assert.equal(f.writes.length, 0);
  }
});

test('runtime privilege holders and workspaces with unknown members are protected', async t => {
  const elevated = fixture(t, { runtimeAdmin: true });
  const a = await elevated.cleanup.analyze('basel');
  assert.equal(a.people.find(p => p.email === 'student@example.org').classification, 'protected');
  assert.equal(a.selection.tenants.find(t => t.id === 't1').selectable, false);
  const shared = fixture(t); shared.state.workspaceMembers.push({ email: 'unknown@example.org', role: 'editor' });
  const b = await shared.cleanup.analyze('basel');
  assert.equal(b.selection.workspaces[0].selectable, false);
});

test('accounts still needed in unselected resources and tenants with unselected students block preview', async t => {
  const f = fixture(t), a = await f.cleanup.analyze('basel');
  await assert.rejects(f.cleanup.preview('basel', a.analysisId, { students: ['student@example.org'], workspaces: [], tenants: [] }), /noch in einem nicht ausgewählten/);
  await assert.rejects(f.cleanup.preview('basel', a.analysisId, { students: [], workspaces: [], tenants: ['t1'] }), /nicht ausgewählte Studierende/);
  assert.equal(f.writes.length, 0);
});

test('uncertain deletion stops remaining targets, records the outcome and is never retried', async t => {
  const f = fixture(t, { failDelete: true }), plan = await f.preview();
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'incomplete'); assert.equal(result.results[0].status, 'uncertain');
  assert.equal(result.notAttempted.length, 4); assert.equal(f.writes.filter(w => w.endpoint === '/workspaces/w1').length, 1);
  const receipt = fs.readdirSync(f.root).find(name => name.startsWith('cleanup-basel-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, receipt))).status, 'incomplete');
  await assert.rejects(f.cleanup.apply('basel', plan.id, true), /bereits verwendet/);
});

test('acknowledgment, matching site and valid expiry are mandatory', async t => {
  const f = fixture(t), plan = await f.preview();
  await assert.rejects(f.cleanup.apply('basel', plan.id, false), /ausdrücklich bestätigen/);
  await assert.rejects(f.cleanup.apply('olten', plan.id, true), /Löschvorschau fehlt/);
  f.advance(600001);
  await assert.rejects(f.cleanup.apply('basel', plan.id, true), /abgelaufen/);
  assert.equal(f.writes.length, 0);
});

test('existing exact tenant DELETE is reused and no wildcard or duplicate grant is created', async t => {
  const f = fixture(t); for (const [resourceType, resourceId] of [['TENANT', 't1'], ['GROUP', 'g1']]) f.state.authorizations.push({ ownerType: 'CLIENT', ownerId: 'client', resourceType, resourceId, permissionTypes: ['DELETE'] });
  const plan = await f.preview(); assert.equal(plan.permissionSummary.length, 0);
  await f.cleanup.apply('basel', plan.id, true);
  assert.ok(!f.writes.some(w => w.endpoint === '/v2/authorizations'));
});

test('missing tenant capabilities and a cross-process lock stop unsafe execution', async t => {
  const f = fixture(t, { noCreate: true }), analysis = await f.cleanup.analyze('basel');
  assert.equal(analysis.selection.tenants.find(t => t.id === 't1').selectable, false);
  const other = fixture(t), plan = await other.preview();
  fs.writeFileSync(path.join(other.root, 'cleanup-lock-basel.local.json'), '{}');
  await assert.rejects(other.cleanup.apply('basel', plan.id, true), /bereits reserviert/);
  assert.equal(other.writes.length, 0);
});

test('stale analyses and forged, duplicate or empty selections never arm deletion', async t => {
  const f = fixture(t), analysis = await f.cleanup.analyze('basel');
  for (const selection of [
    { students: [], workspaces: [], tenants: [] },
    { students: [], workspaces: ['forged'], tenants: [] },
    { students: [], workspaces: ['w1', 'w1'], tenants: [] },
  ]) await assert.rejects(f.cleanup.preview('basel', analysis.analysisId, selection));
  f.state.projects.push({ projectKey: 'new', name: 'New project' });
  await assert.rejects(f.cleanup.preview('basel', analysis.analysisId, f.selection), /seit der Analyse geändert/);
  assert.equal(f.writes.length, 0);
});

test('preview exposes only runtime counts; tenant-scoped purge cancels roots and deletes all instances and tasks', async t => {
  const f = fixture(t, { processes: true }), plan = await f.preview();
  assert.deepEqual(plan.runtimeCounts, [{ tenantId: 't1', processInstances: 2, activeProcessInstances: 2, tasks: 1, runtimeGroups: 1 }]);
  assert.ok(!JSON.stringify(plan).includes('1001'));
  assert.ok(!JSON.stringify(plan).includes('p-group1'));
  assert.ok(!JSON.stringify(plan).includes('"g1"'));
  assert.equal(f.writes.length, 0);
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.state.processes.map(p => p.processInstanceKey), ['201']);
  assert.deepEqual(f.state.tasks.map(t => t.userTaskKey), ['2001']);
  assert.deepEqual(f.writes.filter(w => w.endpoint.endsWith('/cancellation')).map(w => w.endpoint), ['/v2/process-instances/101/cancellation']);
  assert.equal(f.writes.filter(w => w.endpoint.endsWith('/deletion')).length, 2);
  assert.ok(!f.writes.some(w => w.endpoint.includes('/201/') || w.endpoint === '/v2/groups/g2' || w.endpoint.includes('/resources/')));
  const grants = f.writes.filter(w => w.endpoint === '/v2/authorizations').map(w => w.request.body);
  assert.ok(grants.every(g => g.resourceId !== '*'));
  assert.deepEqual(grants.filter(g => g.resourceType === 'PROCESS_DEFINITION').map(g => g.resourceId).sort(), ['child-group1', 'p-group1']);
  assert.ok(f.writes.findIndex(w => w.endpoint.endsWith('/102/deletion')) < f.writes.findIndex(w => w.endpoint === '/v2/groups/g1'));
  assert.ok(f.writes.findIndex(w => w.endpoint === '/v2/groups/g1') < f.writes.findIndex(w => w.endpoint === '/v2/tenants/t1'));
});

test('missing read rights, failed reads and incomplete or foreign results never produce a deletion preview', async t => {
  for (const options of [{ noRead: true }, { failDataRead: true }, { truncated: true }, { leakTenant: true }, { oldVersion: true }]) {
    const f = fixture(t, { processes: true, ...options });
    await assert.rejects(f.preview()); assert.equal(f.writes.length, 0);
  }
});

test('runtime groups used outside selected tenants or by technical clients remain protected', async t => {
  const f = fixture(t); f.state.tenantGroups['<default>'] = ['g1'];
  await assert.rejects(f.preview(), /nicht ausgewählten Tenant/); assert.equal(f.writes.length, 0);
  const other = fixture(t, { sharedClient: true });
  await assert.rejects(other.preview(), /bleibt geschützt/); assert.equal(other.writes.length, 0);
});

test('process or task drift with unchanged counts invalidates apply before any write', async t => {
  for (const change of [
    f => { f.state.processes[0].processInstanceKey = '999'; },
    f => { f.state.tasks[0].userTaskKey = '999'; },
    f => { f.state.tasks[0].state = 'COMPLETED'; },
    f => { f.state.processes[0].state = 'COMPLETED'; },
  ]) {
    const f = fixture(t, { processes: true }), plan = await f.preview(); change(f);
    await assert.rejects(f.cleanup.apply('basel', plan.id, true)); assert.equal(f.writes.length, 0);
  }
});

test('cross-tenant process hierarchies and orphan tasks block preview', async t => {
  const f = fixture(t, { processes: true }); f.state.processes[2].parentProcessInstanceKey = '101';
  await assert.rejects(f.preview(), /Prozesshierarchie/); assert.equal(f.writes.length, 0);
  const g = fixture(t, { processes: true }); g.state.tasks[0].processInstanceKey = '999';
  await assert.rejects(g.preview(), /Aufgaben/); assert.equal(g.writes.length, 0);
});

test('uncertain process cancellation is never retried and keeps groups, tenant and members', async t => {
  const f = fixture(t, { processes: true, failProcessWrite: true }), plan = await f.preview();
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'incomplete');
  assert.equal(f.writes.filter(w => w.endpoint.endsWith('/cancellation')).length, 1);
  assert.ok(!f.writes.some(w => w.endpoint.endsWith('/deletion') || w.endpoint === '/v2/groups/g1' || w.endpoint === '/v2/tenants/t1'));
  assert.equal(f.state.members.length, 2);
});

test('pending cancellation or task index deletion never permits group and tenant removal', async t => {
  for (const options of [{ lingerActive: true }, { lingerTasks: true }]) {
    const f = fixture(t, { processes: true, ...options }), plan = await f.preview();
    const result = await f.cleanup.apply('basel', plan.id, true);
    assert.equal(result.status, 'incomplete');
    assert.ok(!f.writes.some(w => w.endpoint === '/v2/groups/g1' || w.endpoint === '/v2/tenants/t1'));
    assert.equal(f.writes.filter(w => w.endpoint.endsWith('/cancellation')).length, 1);
    assert.equal(f.state.members.length, 2);
  }
});

test('revoked read access cannot turn an empty index into permission to delete the tenant', async t => {
  const f = fixture(t, { processes: true, revokeRead: true }), plan = await f.preview();
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'incomplete');
  assert.ok(!f.writes.some(w => w.endpoint === '/v2/groups/g1' || w.endpoint === '/v2/tenants/t1'));
});

test('runtime pagination counts every unique row and rejects duplicate or missing pages', async () => {
  const { dataSearch } = require('../lib/cleanup-runtime');
  const all = Array.from({ length: 101 }, (_, i) => ({ processInstanceKey: String(i + 1) }));
  let calls = 0;
  const context = { runtimeBase: 'https://runtime.example.org', runtimeApi: { runtime: async (_base, _endpoint, request) => {
    calls++; const from = request.body.page.from;
    return { items: all.slice(from, from + 100), page: { totalItems: 101, hasMoreTotalItems: from === 0 } };
  } } };
  assert.equal((await dataSearch(context, '/v2/process-instances/search', { tenantId: 't1' }, 'processInstanceKey')).length, 101);
  assert.equal(calls, 2);
  all[100] = all[0];
  await assert.rejects(dataSearch(context, '/v2/process-instances/search', { tenantId: 't1' }, 'processInstanceKey'), /doppelte/);
});

test('delayed group removal waits past the old window and finishes without repeating DELETE', async t => {
  const f = fixture(t, { groupDelayReads: 6, tenantGroupDelayReads: 5 }), plan = await f.preview();
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'completed');
  assert.equal(f.writes.filter(w => w.endpoint === '/v2/groups/g1/users/student%40example.org').length, 1);
  assert.ok(f.waits.reduce((total, w) => total + w.ms, 0) > 1500);
  assert.ok(f.waits.some(w => w.progress.message.includes('Auf Bestätigung von Camunda warten')));
  const progress = f.cleanup.getProgress('basel');
  assert.equal(progress.phase, 'completed'); assert.equal(progress.completed, progress.total);
  assert.ok(!JSON.stringify(progress).includes('student@example.org'));
});

test('unconfirmed membership times out after bounded read waits and stops downstream deletes', async t => {
  const f = fixture(t, { groupDelayReads: 1000 }), plan = await f.preview();
  const result = await f.cleanup.apply('basel', plan.id, true);
  assert.equal(result.status, 'incomplete');
  assert.equal(f.waits.reduce((total, w) => total + w.ms, 0), 60000);
  assert.equal(f.writes.filter(w => w.endpoint === '/v2/groups/g1/users/student%40example.org').length, 1);
  assert.ok(!f.writes.some(w => w.endpoint === '/v2/groups/g1' || w.endpoint === '/v2/tenants/t1'));
  assert.equal(f.cleanup.getProgress('basel').phase, 'stopped');
  const receipt = fs.readdirSync(f.root).find(name => name.startsWith('cleanup-basel-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, receipt))).inFlight.phase, 'remove-group');
});
