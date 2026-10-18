const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SiteSetup, SCOPES, missingGrants } = require('../lib/site-setup');
const { ApiError } = require('../lib/camunda-api');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-sites-'));
  t.after(() => { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); });
  fs.copyFileSync(path.join(__dirname, '..', 'admin-config.json'), path.join(root, 'admin-config.json'));
  fs.copyFileSync(path.join(__dirname, '..', 'site-setup.json'), path.join(root, 'site-setup.json'));
  const org = JSON.parse(fs.readFileSync(path.join(root, 'admin-config.json'))).organizations.basel;
  const config = JSON.parse(fs.readFileSync(path.join(root, 'site-setup.json'))).sites.basel;
  const members = [], mutations = [], auth = [];
  const roles = new Set(['admin', 'connectors', 'app-integrations']);
  if (!options.noRole) roles.add('studierende');
  const tenantRoles = new Set(['admin', 'connectors', 'app-integrations']);
  const tenantClients = new Set(['client-id']);
  if (options.unsafeTenant) tenantRoles.add('studierende');
  const client = { name: config.runtimeClientName, clientId: 'client-id' };
  if (!options.noClient) {
    members.push(client);
    fs.writeFileSync(path.join(root, config.runtimeCredentialsFile), 'CAMUNDA_CLIENT_ID=client-id\nCAMUNDA_CLIENT_SECRET=mock-secret\nCAMUNDA_CLUSTER_ID=' + config.clusterId + '\nCAMUNDA_REST_ADDRESS=' + config.runtimeBase + '\n');
  }
  const api = {
    async token() { return 'mock.' + Buffer.from(JSON.stringify({ scope: SCOPES.join(' ') })).toString('base64url') + '.mock'; },
    async hub(endpoint) {
      if (endpoint === '/info') return { authorizedOrganization: options.wrongOrg ? 'wrong' : org };
      if (endpoint === '/environments') return { items: [{ id: config.environmentId, clusterId: config.clusterId }] };
      throw new Error('Unexpected ' + endpoint);
    },
    async console(endpoint, request) {
      if (endpoint === '/clusters/' + config.clusterId) return { uuid: config.clusterId, ownerId: org, name: 'Teaching', status: { ready: options.paused ? 'Suspended' : 'Healthy' }, generation: { name: '8.9' } };
      assert.equal(endpoint, '/clusters/' + config.clusterId + '/clients');
      if (!request) return structuredClone(members);
      assert.equal(request.method, 'POST'); mutations.push({ endpoint, request });
      if (options.failClient) throw new Error('Connection lost');
      members.push(client); return { ...client, clientSecret: 'mock-secret' };
    },
  };
  const runtime = { async runtime(base, endpoint, request) {
    assert.equal(base, config.runtimeBase);
    if (endpoint === '/v2/authentication/me') return { roles: [], tenants: [] };
    if (endpoint.startsWith('/v2/roles/') && !endpoint.endsWith('/search')) {
      const id = endpoint.slice('/v2/roles/'.length);
      if (options.forbiddenRole && id === 'studierende') throw new ApiError('Role', 403);
      if (!roles.has(id)) throw new ApiError('Role', 404);
      return { roleId: id };
    }
    if (endpoint === '/v2/tenants/%3Cdefault%3E') return { tenantId: '<default>' };
    if (request?.method === 'POST' && endpoint.endsWith('/search')) {
      let items;
      if (endpoint === '/v2/authorizations/search') {
        if (options.forbiddenAuth) throw new ApiError('Authorization', 403);
        items = auth.filter(a => a.ownerType === request.body.filter.ownerType && a.ownerId === request.body.filter.ownerId);
      } else if (endpoint === '/v2/tenants/search') items = [{ tenantId: '<default>' }];
      else if (endpoint.endsWith('/roles/search')) items = [...tenantRoles].map(roleId => ({ roleId }));
      else if (endpoint.endsWith('/clients/search')) items = [...tenantClients].map(clientId => ({ clientId }));
      else throw new Error('Unexpected search ' + endpoint);
      return { items: structuredClone(items), page: { hasMoreTotalItems: false } };
    }
    mutations.push({ endpoint, request: structuredClone(request) });
    if (options.failGrant) throw new Error('Grant connection lost');
    if (endpoint === '/v2/authorizations') auth.push(structuredClone(request.body));
    else if (endpoint === '/v2/roles') roles.add(request.body.roleId);
    else throw new Error('Unexpected mutation ' + endpoint);
    return {};
  } };
  const setup = new SiteSetup({ root, organizationApiForSite: () => api, runtimeApiForSite: () => runtime, wait: async () => {} });
  return { root, setup, mutations, auth, config, roles, client };
}

test('readiness is read-only and distinguishes missing grants from unqueryable security switches', async t => {
  const f = fixture(t), { report } = await f.setup.inspect('basel');
  assert.equal(report.checks.find(c => c.id === 'runtime').state, 'ready');
  assert.equal(report.checks.find(c => c.id === 'student-grants').state, 'missing');
  assert.equal(report.checks.find(c => c.id === 'tenant-check').state, 'unknown');
  assert.ok(!report.actions.includes('create-client'));
  assert.equal(f.mutations.length, 0);
  assert.ok(!JSON.stringify(report).includes('mock-secret'));
});

test('wrong organization prevents all cluster, runtime and provisioning operations', async t => {
  const f = fixture(t, { wrongOrg: true }), { report } = await f.setup.inspect('basel');
  assert.equal(report.checks[0].state, 'blocked');
  assert.deepEqual(report.actions, []);
  await assert.rejects(f.setup.apply('basel', 'create-client'), /nicht erforderlich/);
  assert.equal(f.mutations.length, 0);
});

test('client creation stores its secret only in the local exclusive credential file and is not repeated', async t => {
  const f = fixture(t, { noClient: true });
  const result = await f.setup.apply('basel', 'create-client');
  assert.equal(result.verified, true);
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(f.mutations[0].request.body.permissions, ['Zeebe']);
  assert.ok(fs.readFileSync(path.join(f.root, f.config.runtimeCredentialsFile), 'utf8').includes('mock-secret'));
  assert.ok(!JSON.stringify(result).includes('mock-secret'));
  await assert.rejects(f.setup.apply('basel', 'create-client'), /nicht erforderlich/);
  assert.equal(f.mutations.length, 1);
});

test('an ambiguous client create keeps the reserved file and blocks automatic duplicate creation', async t => {
  const f = fixture(t, { noClient: true, failClient: true });
  await assert.rejects(f.setup.apply('basel', 'create-client'), /Connection lost/);
  assert.ok(fs.existsSync(path.join(f.root, f.config.runtimeCredentialsFile)));
  await assert.rejects(f.setup.apply('basel', 'create-client'), /nicht erforderlich/);
  assert.equal(f.mutations.length, 1);
});

test('student grants are additive, verified and idempotent across subsequent checks', async t => {
  const f = fixture(t);
  const result = await f.setup.apply('basel', 'student-grants');
  assert.equal(result.verified, true);
  assert.equal(f.mutations.length, 5);
  assert.ok(f.auth.every(a => a.ownerType === 'ROLE' && a.ownerId === 'studierende' && a.resourceType !== 'TENANT'));
  await assert.rejects(f.setup.apply('basel', 'student-grants'), /nicht erforderlich/);
  assert.equal(f.mutations.length, 5);
});

test('client grants use specific onboarding permissions and never grant admin or delete', async t => {
  const f = fixture(t), result = await f.setup.apply('basel', 'client-grants');
  assert.equal(result.verified, true);
  assert.ok(f.auth.every(a => a.ownerType === 'CLIENT' && a.ownerId === 'client-id' && !a.permissionTypes.includes('DELETE')));
  assert.ok(!f.mutations.some(c => c.endpoint.includes('/roles/admin/')));
});

test('404 permits role creation; 403 remains unknown and never authorizes a blind create', async t => {
  const f = fixture(t, { noRole: true });
  assert.equal((await f.setup.apply('basel', 'create-role')).verified, true);
  const denied = fixture(t, { forbiddenRole: true });
  const report = (await denied.setup.inspect('basel')).report;
  assert.equal(report.checks.find(c => c.id === 'role').state, 'unknown');
  assert.ok(!report.actions.includes('create-role'));
});

test('unreadable authorization inventory and a tenant-bound shared role cannot enable unsafe repairs', async t => {
  const denied = fixture(t, { forbiddenAuth: true });
  const report = (await denied.setup.inspect('basel')).report;
  assert.ok(!report.actions.includes('student-grants'));
  assert.ok(!report.actions.includes('client-grants'));
  const unsafe = fixture(t, { unsafeTenant: true });
  const other = (await unsafe.setup.inspect('basel')).report;
  assert.equal(other.checks.find(c => c.id === 'support-access').state, 'blocked');
  assert.ok(!other.actions.includes('support-access'));
  assert.ok(!other.actions.includes('student-grants'));
});

test('paused clusters are blocked and no runtime calls are assumed successful', async t => {
  const f = fixture(t, { paused: true }), { report } = await f.setup.inspect('basel');
  assert.equal(report.checks.find(c => c.id === 'cluster').state, 'blocked');
  assert.equal(report.checks.find(c => c.id === 'runtime').state, 'unknown');
  assert.deepEqual(report.actions, []);
});

test('only missing permissions are added, combining existing grants without overwriting them', () => {
  const target = { ownerType: 'ROLE', ownerId: 'studierende', resourceType: 'PROCESS_DEFINITION', resourceId: '*', permissionTypes: ['READ_PROCESS_INSTANCE', 'CREATE_PROCESS_INSTANCE'] };
  assert.deepEqual(missingGrants([{ ...target, permissionTypes: ['READ_PROCESS_INSTANCE'] }], [target]), [{ ...target, permissionTypes: ['CREATE_PROCESS_INSTANCE'] }]);
});

test('uncertain authorization writes persist a receipt and cannot be automatically repeated', async t => {
  const f = fixture(t, { failGrant: true });
  await assert.rejects(f.setup.apply('basel', 'student-grants'), /connection lost/);
  assert.equal(f.mutations.length, 1);
  const report = (await f.setup.inspect('basel')).report;
  assert.equal(report.checks.find(c => c.id === 'student-grants').state, 'blocked');
  await assert.rejects(f.setup.apply('basel', 'student-grants'), /nicht erforderlich/);
  assert.equal(f.mutations.length, 1);
});

test('a lock held by another process prevents any provisioning action', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'site-lock-basel.local.json'), '{}');
  await assert.rejects(f.setup.apply('basel', 'student-grants'), /reserviert/);
  assert.equal(f.mutations.length, 0);
});

test('fresh Hub observations expose enabled/disabled states with their source rather than pretending API support', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'site-flags.local.json'), JSON.stringify({ sites: { basel: { clusterId: f.config.clusterId, checkedAt: new Date().toISOString(), authorizations: true, multiTenancy: false } } }));
  const report = (await f.setup.inspect('basel')).report;
  assert.equal(report.checks.find(c => c.id === 'authorization-check').state, 'ready');
  assert.equal(report.checks.find(c => c.id === 'tenant-check').state, 'missing');
  assert.match(report.checks.find(c => c.id === 'tenant-check').detail, /lesend im Hub/);
  assert.equal(f.mutations.length, 0);
});

test('outdated or wrong-cluster Hub observations never mark security checks ready', async t => {
  const f = fixture(t);
  for (const observed of [
    { clusterId: f.config.clusterId, checkedAt: new Date(Date.now() - 16 * 60000).toISOString() },
    { clusterId: 'different', checkedAt: new Date().toISOString() },
  ]) {
    fs.writeFileSync(path.join(f.root, 'site-flags.local.json'), JSON.stringify({ sites: { basel: { ...observed, authorizations: true, multiTenancy: true } } }));
    const report = (await f.setup.inspect('basel')).report;
    assert.equal(report.checks.find(c => c.id === 'authorization-check').state, 'unknown');
    assert.equal(report.checks.find(c => c.id === 'tenant-check').state, 'unknown');
  }
});
