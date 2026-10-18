const test = require('node:test');
const assert = require('node:assert/strict');
const { Onboarding, searchAll } = require('../lib/onboarding');
const { CamundaApi, ApiError } = require('../lib/camunda-api');

const config = {
  expectedOrganization: 'organization-a', workspaceName: 'Class A - Group 1',
  projects: ['Project 1', 'Project 2'], adminEmail: 'teacher@example.org', studentEmail: 'student@example.org',
  environmentId: 'environment-a', runtimeBase: 'https://bru-2.api.camunda.io/11111111-1111-1111-1111-111111111111', runtimeRole: 'students',
};

function fakeApi({ organization = config.expectedOrganization, workspaces = [], projects = [], members = [], student = null } = {}) {
  const writes = [];
  let assigned = [];
  const admin = { email: config.adminEmail, roles: ['admin'] };
  const api = {
    writes,
    console: async (endpoint, options = {}) => {
      if (options.method === 'POST') { writes.push({ endpoint, ...options }); student = { email: config.studentEmail, roles: ['modeler'], invitePending: true }; return null; }
      assert.equal(endpoint, '/members');
      return student ? [admin, student] : [admin];
    },
    hub: async (endpoint, options = {}) => {
      const { body, method = 'GET' } = options;
      if (endpoint === '/info') return { authorizedOrganization: organization };
      if (endpoint === '/environments') return { items: [{ id: config.environmentId, name: 'Teaching', clusterId: '11111111-1111-1111-1111-111111111111', runtimeState: 'HEALTHY' }] };
      if (endpoint.endsWith('/search')) {
        let items;
        if (endpoint === '/workspaces/search') items = workspaces.filter(item => item.name === body.filter.name.$eq);
        else if (endpoint === '/projects/search') items = projects.filter(item => item.workspaceKey === body.filter.workspaceKey.$eq && (!body.filter.name || item.name === body.filter.name.$eq));
        else if (endpoint === '/members/search') items = members;
        else throw new Error('Unexpected search');
        return { items, page: { totalItems: items.length, hasMoreTotalItems: false } };
      }
      if (endpoint.endsWith('/environments') && method === 'GET') return { items: assigned.map(id => ({ id })) };
      writes.push({ endpoint, ...options });
      if (endpoint === '/workspaces') { const workspace = { workspaceKey: 'workspace-a', ...body }; workspaces.push(workspace); return workspace; }
      if (endpoint === '/projects') { const project = { projectKey: `project-${projects.length}`, ...body }; projects.push(project); return project; }
      if (endpoint.endsWith('/members')) { const member = { workspaceKey: 'workspace-a', ...body }; members.push(member); return member; }
      if (endpoint.endsWith('/environments') && method === 'PUT') { assigned = [...body.environmentIds]; return { items: assigned.map(id => ({ id })) }; }
      throw new Error('Unexpected mutation');
    },
  };
  return api;
}

test('planning never creates resources, sends invitations, or assigns access', async () => {
  const api = fakeApi();
  const plan = await new Onboarding(api, config).plan();
  assert.equal(plan.workspace.action, 'create');
  assert.equal(plan.runtime.ready, false);
  assert.deepEqual(api.writes, []);
});

test('wrong organization stops before any writes', async () => {
  const api = fakeApi({ organization: 'another-organization' });
  await assert.rejects(new Onboarding(api, config).ensureStructure(), /nicht zur erwarteten Organisation/);
  assert.deepEqual(api.writes, []);
});

test('ambiguous workspace name stops without selecting or changing one', async () => {
  const api = fakeApi({ workspaces: [{ workspaceKey: 'one', name: config.workspaceName }, { workspaceKey: 'two', name: config.workspaceName }] });
  await assert.rejects(new Onboarding(api, config).ensureStructure(), /mehrfach/);
  assert.deepEqual(api.writes, []);
});

test('structure is repeatable and never invites the student', async () => {
  const api = fakeApi();
  const runner = new Onboarding(api, config);
  const first = await runner.ensureStructure();
  const count = api.writes.length;
  const second = await runner.ensureStructure();
  assert.deepEqual(second, first);
  assert.equal(api.writes.length, count);
  assert.equal(api.writes.filter(write => write.endpoint === '/projects').length, 2);
  assert.equal(api.writes.some(write => write.body?.email === config.studentEmail), false);
});

test('pending organization invitation and existing workspace membership are reused', async () => {
  const api = fakeApi({ workspaces: [{ workspaceKey: 'workspace-a', name: config.workspaceName }], projects: config.projects.map((name, index) => ({ name, projectKey: `p${index}`, workspaceKey: 'workspace-a' })), members: [{ email: config.studentEmail, role: 'editor' }], student: { email: config.studentEmail, roles: ['modeler'], invitePending: true } });
  await new Onboarding(api, config).ensureHubAccess();
  assert.deepEqual(api.writes, []);
});

test('existing elevated organization roles are never silently downgraded', async () => {
  const api = fakeApi({ student: { email: config.studentEmail, roles: ['admin'] } });
  await assert.rejects(new Onboarding(api, config).ensureHubAccess(), /weitere Organisationsrollen/);
  assert.deepEqual(api.writes, []);
});

test('new invitation waits for acceptance without attempting a workspace assignment or sending another invitation', async () => {
  const api = fakeApi();
  const runner = new Onboarding(api, config);
  await runner.ensureStructure();
  api.writes.length = 0;
  const first = await runner.ensureHubAccess();
  assert.equal(first.status, 'awaiting_invitation_acceptance');
  assert.equal(first.workspaceRole, null);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].endpoint, '/members/student%40example.org');
  await runner.ensureHubAccess();
  assert.equal(api.writes.length, 1);
});

test('accepted organization member receives editor access with a verified repeatable assignment', async () => {
  const api = fakeApi({ student: { email: config.studentEmail, roles: ['modeler'], invitePending: false } });
  const runner = new Onboarding(api, config);
  await runner.ensureStructure();
  api.writes.length = 0;
  const result = await runner.ensureHubAccess();
  assert.equal(result.status, 'assigned');
  assert.equal(result.workspaceRole, 'editor');
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].endpoint, '/workspaces/workspace-a/members');
  await runner.ensureHubAccess();
  assert.equal(api.writes.length, 1);
});

test('v2 member HTTP 400 uses the documented v1 compatibility endpoint and verifies membership through v2', async () => {
  const api = fakeApi({ student: { email: config.studentEmail, roles: ['modeler'], invitePending: false } });
  const runner = new Onboarding(api, config);
  await runner.ensureStructure();
  const hub = api.hub;
  api.hub = async (endpoint, options = {}) => {
    if (endpoint === '/workspaces/workspace-a/members' && options.method === 'POST') throw new ApiError('add member', 400);
    return hub(endpoint, options);
  };
  const calls = [];
  api.request = async (base, endpoint, options) => {
    calls.push({ base, endpoint, ...options });
    return hub('/workspaces/workspace-a/members', { method: 'POST', body: { email: options.body.email, role: options.body.role } });
  };
  assert.equal((await runner.ensureHubAccess()).status, 'assigned');
  assert.deepEqual(calls, [{ base: 'https://hub.camunda.io', endpoint: '/api/v1/collaborators', method: 'PUT', body: { email: config.studentEmail, projectId: 'workspace-a', role: 'editor' } }]);
  await runner.ensureHubAccess();
  assert.equal(calls.length, 1);
});

test('v2 member permission failures never trigger a compatibility write', async () => {
  const api = fakeApi({ student: { email: config.studentEmail, roles: ['modeler'], invitePending: false } });
  const runner = new Onboarding(api, config);
  await runner.ensureStructure();
  const hub = api.hub;
  api.hub = async (endpoint, options = {}) => {
    if (endpoint === '/workspaces/workspace-a/members' && options.method === 'POST') throw new ApiError('add member', 403);
    return hub(endpoint, options);
  };
  api.request = async () => assert.fail('No fallback for permission failures');
  await assert.rejects(runner.ensureHubAccess(), error => error.status === 403);
});

test('search traverses every page before deciding whether an object exists', async () => {
  const calls = [];
  const api = { hub: async (_, options) => { calls.push(options.body.page.from); return options.body.page.from === 0 ? { items: Array.from({ length: 100 }, (_, i) => ({ id: i })), page: { totalItems: 101 } } : { items: [{ id: 100 }], page: { totalItems: 101 } }; } };
  assert.equal((await searchAll(api, '/workspaces/search', {})).length, 101);
  assert.deepEqual(calls, [0, 100]);
});

test('transport errors and server error bodies cannot expose credential material', async () => {
  const api = new CamundaApi({ CAMUNDA_CONSOLE_CLIENT_ID: 'id', CAMUNDA_CONSOLE_CLIENT_SECRET: 'secret-that-must-not-leak' }, { fetchImpl: async () => { throw new Error('secret-that-must-not-leak'); } });
  await assert.rejects(api.hub('/info'), error => !error.message.includes('secret-that-must-not-leak'));
});

test('runtime assignment is never attempted without runtime credentials', async () => {
  const api = fakeApi();
  await assert.rejects(new Onboarding(api, config).ensureRuntimeAccess(), /Runtime-Credentials fehlen/);
  assert.deepEqual(api.writes, []);
});

test('runtime assignment targets only the configured role and exact email, and accepts already assigned', async () => {
  const calls = [];
  const runtime = { runtime: async (base, endpoint, options = {}) => {
    calls.push({ base, endpoint, method: options.method || 'GET' });
    if (options.method === 'PUT') throw new ApiError('assignment', 409);
    return { roleId: config.runtimeRole };
  } };
  const result = await new Onboarding(fakeApi(), config, runtime).ensureRuntimeAccess();
  assert.equal(result.status, 'assigned');
  assert.deepEqual(calls, [
    { base: config.runtimeBase, endpoint: '/v2/roles/students', method: 'GET' },
    { base: config.runtimeBase, endpoint: '/v2/roles/students/users/student%40example.org', method: 'PUT' },
  ]);
});

test('a forbidden role assignment is reported, never treated as success', async () => {
  const runtime = { runtime: async (_base, _endpoint, options = {}) => {
    if (options.method === 'PUT') throw new ApiError('assignment', 403);
    return {};
  } };
  await assert.rejects(new Onboarding(fakeApi(), config, runtime).ensureRuntimeAccess(), error => error.status === 403);
});
