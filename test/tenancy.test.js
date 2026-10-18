const test = require('node:test');
const assert = require('node:assert/strict');
const { TenancySetup, runtimeSearch } = require('../lib/tenancy');
const { ApiError } = require('../lib/camunda-api');

const config = {
  studentEmail: 'student@example.org', runtimeBase: 'https://runtime.example.org', runtimeRole: 'students',
  tenantGroups: [{ tenantId: 'group-1', groupId: 'group-1', name: 'Group 1' }, { tenantId: 'group-2', groupId: 'group-2', name: 'Group 2' }], studentGroupId: 'group-1',
};

function fixture() {
  const writes = [], tenants = new Map([['<default>', { tenantId: '<default>', name: 'Default' }]]), groups = new Map(), memberships = new Map(), users = new Map(), roleGroups = [], authorizations = [];
  const member = id => {
    if (!memberships.has(id)) memberships.set(id, { roles: [], groups: [], users: [], clients: [], 'mapping-rules': [] });
    return memberships.get(id);
  };
  const api = { runtime: async (_base, endpoint, options = {}) => {
    const p = endpoint.split('/').slice(2).map(decodeURIComponent);
    if (endpoint.endsWith('/search')) {
      let items;
      if (p[0] === 'authorizations') items = authorizations.filter(a => Object.entries(options.body.filter || {}).every(([key, value]) => a[key] === value));
      else if (p.length === 2) items = [...(p[0] === 'tenants' ? tenants : groups).values()];
      else if (p[0] === 'tenants') items = member(p[1])[p[2]];
      else if (p[0] === 'roles') items = roleGroups;
      else items = users.get(p[1]) || [];
      const from = options.body.page.from || 0;
      return { items: items.slice(from, from + 100), page: { hasMoreTotalItems: from + 100 < items.length } };
    }
    if (!options.method) {
      if (p[0] === 'roles') return { roleId: p[1] };
      if (!tenants.has(p[1])) throw new ApiError('get', 404);
      return tenants.get(p[1]);
    }
    writes.push({ endpoint, ...options });
    if (options.method === 'POST') {
      if (p[0] === 'authorizations') {
        authorizations.push({ authorizationKey: String(authorizations.length + 1), ...options.body });
        return { authorizationKey: String(authorizations.length) };
      }
      const type = p[0] === 'tenants' ? tenants : groups;
      const id = options.body.tenantId || options.body.groupId;
      type.set(id, options.body);
      return options.body;
    }
    assert.equal(options.method, 'PUT');
    if (p[0] === 'tenants') {
      const field = { groups: 'groupId', roles: 'roleId', users: 'username', clients: 'clientId' }[p[2]];
      member(p[1])[p[2]].push({ [field]: p[3] });
    } else if (p[0] === 'groups') {
      const current = users.get(p[1]) || [];
      current.push({ username: p[3] }); users.set(p[1], current);
    } else roleGroups.push({ groupId: p[3] });
    return null;
  } };
  const onboarding = { config, inspect: async () => ({ student: { invitePending: false } }) };
  return { runner: new TenancySetup(onboarding, api, 'onboarding-client'), api, writes, tenants, groups, users, member, authorizations };
}

test('tenant preview never creates groups, assigns users, or enables checks', async () => {
  const f = fixture();
  assert.equal((await f.runner.plan()).activation, 'manual_only');
  assert.deepEqual(f.writes, []);
});

test('two tenant groups are prepared with student only in group 1, shared role not tenant-bound, and admin/technical access retained', async () => {
  const f = fixture();
  const result = await f.runner.prepare({ includeSupportAccess: true });
  assert.equal(result.prepared, true);
  assert.equal(result.effectiveIsolationTest, 'pending_after_activation');
  assert.deepEqual(f.users.get('group-1'), [{ username: config.studentEmail }]);
  assert.deepEqual(f.users.get('group-2') || [], []);
  for (const id of ['<default>', 'group-1', 'group-2']) {
    assert.deepEqual(f.member(id).roles.map(r => r.roleId), ['admin', 'connectors', 'app-integrations']);
    assert.deepEqual(f.member(id).clients, [{ clientId: 'onboarding-client' }]);
    assert.equal(f.member(id).roles.some(r => r.roleId === 'students'), false);
  }
  assert.equal(f.writes.some(w => !/^\/v2\/(tenants|groups|roles|authorizations)(\/|$)/.test(w.endpoint)), false);
  const count = f.writes.length;
  await f.runner.prepare({ includeSupportAccess: true });
  assert.equal(f.writes.length, count);
});

test('group-only preparation makes no privileged role/client tenant assignments and does not claim readiness', async () => {
  const f = fixture();
  const result = await f.runner.prepare();
  assert.equal(result.readyToActivate, false);
  assert.equal(result.adminAndTechnicalAccessVerified, false);
  assert.equal(f.writes.some(w => /^\/v2\/tenants\/[^/]+\/(roles|clients)\//.test(w.endpoint)), false);
});

test('missing support role read access stops support assignment before any privileged writes', async () => {
  const f = fixture();
  await f.runner.prepare();
  f.writes.length = 0;
  const runtime = f.api.runtime;
  f.api.runtime = async (base, endpoint, options) => {
    if (endpoint === '/v2/roles/admin') throw new ApiError('role read', 403);
    return runtime(base, endpoint, options);
  };
  await assert.rejects(f.runner.prepareSupportAccess(), error => error.status === 403);
  assert.deepEqual(f.writes, []);
});

test('a test user with another group membership stops all writes', async () => {
  const f = fixture();
  f.groups.set('group-2', { ...config.tenantGroups[1] });
  f.users.set('group-2', [{ username: config.studentEmail }]);
  await assert.rejects(f.runner.prepare(), /weiteren Runtime-Gruppe/);
  assert.deepEqual(f.writes, []);
});

test('shared student role bound to a tenant is detected before writes', async () => {
  const f = fixture();
  f.member('<default>').roles.push({ roleId: 'students' });
  await assert.rejects(f.runner.prepare(), /gemeinsame Studierendenrolle/);
  assert.deepEqual(f.writes, []);
});

test('existing foreign direct tenant access stops all writes', async () => {
  const f = fixture();
  f.member('<default>').users.push({ username: config.studentEmail });
  await assert.rejects(f.runner.prepare(), /fremden Tenant/);
  assert.deepEqual(f.writes, []);
});

test('filtered empty searches do not hide missing tenant read permissions', async () => {
  const f = fixture();
  f.api.runtime = async (_base, endpoint) => {
    if (endpoint.endsWith('/search')) return { items: [], page: { hasMoreTotalItems: false } };
    throw new ApiError('get default', 403);
  };
  await assert.rejects(f.runner.prepare(), error => error.status === 403);
  assert.deepEqual(f.writes, []);
});

test('runtime search follows pages rather than skipping membership records', async () => {
  const offsets = [];
  const api = { runtime: async (_base, _endpoint, options) => {
    const from = options.body.page.from; offsets.push(from);
    return { items: Array.from({ length: from ? 1 : 100 }, (_, id) => ({ id: from + id })), page: { hasMoreTotalItems: !from } };
  } };
  assert.equal((await runtimeSearch(api, config.runtimeBase, '/v2/groups/search')).length, 101);
  assert.deepEqual(offsets, [0, 100]);
});

test('each group gets READ only on its mapped tenant, including different group and tenant IDs', async () => {
  const f = fixture();
  f.runner.config = { ...f.runner.config, tenantGroups: config.tenantGroups.map((g, i) => ({ ...g, tenantId: `tenant-${i + 1}` })) };
  const plan = await f.runner.plan();
  assert.deepEqual(plan.groups.map(g => g.tenantReadAuthorization), [1, 2].map(i => ({
    ownerType: 'GROUP', ownerId: `group-${i}`, resourceType: 'TENANT', resourceId: `tenant-${i}`, permissionTypes: ['READ'], create: true,
  })));
  assert.deepEqual(f.writes, []);
  const result = await f.runner.prepare();
  assert.equal(result.tenantReadAuthorizationsVerified, true);
  assert.deepEqual(f.writes.filter(w => w.endpoint === '/v2/authorizations').map(w => w.body), [1, 2].map(i => ({
    ownerType: 'GROUP', ownerId: `group-${i}`, resourceType: 'TENANT', resourceId: `tenant-${i}`, permissionTypes: ['READ'],
  })));
});

test('a manually saved own tenant READ is reused and subsequent runs create no duplicate authorizations', async () => {
  const f = fixture();
  f.authorizations.push({ authorizationKey: 'manual', ownerType: 'GROUP', ownerId: 'group-1', resourceType: 'TENANT', resourceId: 'group-1', permissionTypes: ['READ'] });
  assert.equal((await f.runner.plan()).groups[0].tenantReadAuthorization.create, false);
  await f.runner.prepare();
  assert.equal(f.writes.filter(w => w.endpoint === '/v2/authorizations').length, 1);
  const count = f.writes.length;
  await f.runner.prepare();
  assert.equal(f.writes.length, count);
  assert.equal(f.authorizations[0].authorizationKey, 'manual');
});

test('foreign or wildcard tenant READ is rejected before any write', async () => {
  for (const resourceId of ['group-2', '*']) {
    const f = fixture();
    f.authorizations.push({ ownerType: 'GROUP', ownerId: 'group-1', resourceType: 'TENANT', resourceId, permissionTypes: ['READ'] });
    await assert.rejects(f.runner.prepare(), /fremden Tenant oder/);
    assert.deepEqual(f.writes, []);
  }
});

test('existing own tenant permissions without READ are never overwritten', async () => {
  const f = fixture();
  f.authorizations.push({ ownerType: 'GROUP', ownerId: 'group-1', resourceType: 'TENANT', resourceId: 'group-1', permissionTypes: ['UPDATE'] });
  await assert.rejects(f.runner.prepare(), /enthält kein READ/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.authorizations[0].permissionTypes, ['UPDATE']);
});

test('missing authorization search access stops preparation before writes', async () => {
  const f = fixture();
  const runtime = f.api.runtime;
  f.api.runtime = async (base, endpoint, options) => {
    if (endpoint === '/v2/authorizations/search') throw new ApiError('authorization read', 403);
    return runtime(base, endpoint, options);
  };
  await assert.rejects(f.runner.prepare(), error => error.status === 403);
  assert.deepEqual(f.writes, []);
});

test('authorization create failures propagate and a later run resumes without duplicating completed grants', async () => {
  const f = fixture();
  const runtime = f.api.runtime;
  f.api.runtime = async (base, endpoint, options) => {
    if (endpoint === '/v2/authorizations' && options.body.ownerId === 'group-2') throw new ApiError('authorization create', 403);
    return runtime(base, endpoint, options);
  };
  await assert.rejects(f.runner.prepare(), error => error.status === 403);
  assert.equal(f.authorizations.length, 1);
  assert.equal(f.users.size, 0);
  f.api.runtime = runtime;
  await f.runner.prepare();
  assert.equal(f.authorizations.length, 2);
  assert.equal(f.writes.filter(w => w.endpoint === '/v2/authorizations' && w.body.ownerId === 'group-1').length, 1);
});

test('verification does not report readiness if the own tenant READ grant is missing', async () => {
  const f = fixture();
  await f.runner.prepare();
  f.authorizations.length = 0;
  const count = f.writes.length;
  await assert.rejects(f.runner.verify({ includeSupportAccess: false }), /TENANT READ/);
  assert.equal(f.writes.length, count);
});
