const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeCleanup } = require('../lib/cleanup-analysis');

function fixture({ runtimeFailure = false, workspaceFailure = false, organization = 'org-a' } = {}) {
  const calls = [];
  const members = [
    { email: 'student@example.org', name: 'Student', roles: ['modeler'] },
    { email: 'teacher@example.org', name: 'Teacher', roles: ['owner'] },
    { email: 'unknown@example.org', name: 'Member', roles: ['modeler'], invitePending: true },
  ];
  function record(endpoint, options = {}) {
    calls.push({ endpoint, ...options });
    assert.ok(!options.method || options.method === 'GET' || (options.method === 'POST' && endpoint.endsWith('/search')), 'Only reads are allowed');
  }
  const page = items => ({ items, page: { hasMoreTotalItems: false, totalItems: items.length } });
  const organizationApi = {
    console: async (endpoint, options) => { record(endpoint, options); assert.equal(endpoint, '/members'); return members; },
    hub: async (endpoint, options) => {
      record(endpoint, options);
      if (endpoint === '/info') return { authorizedOrganization: organization };
      if (endpoint === '/workspaces/search') return page([{ workspaceKey: 'workspace-a', name: 'Shared workspace' }]);
      if (endpoint === '/members/search') {
        if (workspaceFailure) throw new Error('Unavailable');
        return page(members.map(m => ({ email: m.email, role: 'editor' })));
      }
      if (endpoint === '/projects/search') return page([{ projectKey: 'project-a', name: 'Project' }]);
      throw new Error('Unexpected endpoint');
    },
  };
  const runtimeApi = { runtime: async (_base, endpoint, options) => {
    record(endpoint, options);
    if (runtimeFailure) throw new Error('Forbidden');
    if (endpoint === '/v2/roles/studierende') return { roleId: 'studierende' };
    if (endpoint === '/v2/tenants/%3Cdefault%3E') return { tenantId: '<default>' };
    if (endpoint === '/v2/groups/search') return page([{ groupId: 'group-a', name: 'Group A' }]);
    if (endpoint === '/v2/tenants/search') return page([{ tenantId: '<default>', name: 'Default' }, { tenantId: 'tenant-a', name: 'Tenant A' }]);
    if (endpoint === '/v2/roles/studierende/users/search') return page([{ username: 'teacher@example.org' }]);
    if (endpoint === '/v2/roles/studierende/groups/search') return page([{ groupId: 'group-a' }]);
    if (endpoint === '/v2/groups/group-a/users/search') return page([{ username: 'student@example.org' }]);
    if (endpoint === '/v2/tenants/tenant-a/groups/search') return page([{ groupId: 'group-a' }]);
    if (endpoint.endsWith('/search')) return page([]);
    throw new Error('Unexpected runtime endpoint');
  } };
  return { input: { organizationApi, runtimeApi, runtimeBase: 'https://runtime.example.org', expectedOrganization: 'org-a' }, calls, members };
}

test('analysis links students through their runtime group; organization Member alone is not student evidence', async () => {
  const f = fixture();
  const r = await analyzeCleanup(f.input);
  assert.equal(r.readOnly, true);
  assert.equal(r.deletionEnabled, false);
  assert.deepEqual(r.summary, { totalMembers: 3, students: 1, review: 1, protected: 1, pendingInvitations: 1, workspaces: 1 });
  const student = r.people.find(p => p.email === 'student@example.org');
  assert.deepEqual(student.groupIds, ['group-a']);
  assert.deepEqual(student.tenantIds, ['tenant-a']);
  assert.deepEqual(student.workspaceIds, ['workspace-a']);
  assert.equal(r.people.find(p => p.email === 'unknown@example.org').classification, 'review');
  assert.equal(r.runtime.tenants[0].system, true);
  assert.equal(r.runtime.tenants[1].runtimeData, 'not_checked');
});

test('privileged organization accounts stay protected even if they also hold the student role', async () => {
  const f = fixture();
  const r = await analyzeCleanup(f.input);
  assert.equal(r.people.find(p => p.email === 'teacher@example.org').classification, 'protected');
  assert.deepEqual(r.workspaces[0].studentEmails, ['student@example.org']);
  assert.deepEqual(r.workspaces[0].otherMemberEmails, ['teacher@example.org', 'unknown@example.org']);
});

test('configured lecturers stay protected even with an ordinary Member role and student runtime membership', async () => {
  const f = fixture();
  f.input.protectedEmails = ['student@example.org'];
  const r = await analyzeCleanup(f.input);
  assert.equal(r.people.find(p => p.email === 'student@example.org').classification, 'protected');
  assert.equal(r.summary.students, 0);
});

test('failed runtime reads are shown as unknown, never as a confirmed empty inventory', async () => {
  const f = fixture({ runtimeFailure: true });
  const r = await analyzeCleanup(f.input);
  assert.equal(r.runtime.available, false);
  assert.equal(r.summary.students, 0);
  assert.equal(r.summary.review, 2);
  assert.ok(r.warnings.some(w => w.includes('nicht vollständig')));
});

test('unreadable workspace membership is unknown while readable projects remain listed', async () => {
  const f = fixture({ workspaceFailure: true });
  const r = await analyzeCleanup(f.input);
  assert.equal(r.workspaces[0].members, null);
  assert.equal(r.workspaces[0].studentEmails, null);
  assert.equal(r.workspaces[0].projects.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('wrong organization stops before member and runtime reads', async () => {
  const f = fixture({ organization: 'other-org' });
  await assert.rejects(analyzeCleanup(f.input), /erwarteten Organisation/);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['/info']);
});

test('without runtime credentials ordinary members remain unclassified and no runtime call is attempted', async () => {
  const f = fixture();
  delete f.input.runtimeApi;
  const r = await analyzeCleanup(f.input);
  assert.equal(r.runtime.available, false);
  assert.equal(r.summary.students, 0);
  assert.equal(f.calls.some(c => c.endpoint.startsWith('/v2/')), false);
});
