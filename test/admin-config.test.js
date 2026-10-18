const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SITE_IDS, validateAdminConfig, loadAdminConfig, saveAdminConfig, readAdminInventory, adminRolePreview, allowLocalConfigWrite } = require('../lib/admin-config');

function fixture() {
  return { schemaVersion: 1, organizations: { basel: '11111111-1111-1111-1111-111111111111', brugg: '22222222-2222-2222-2222-222222222222', olten: '33333333-3333-3333-3333-333333333333' }, organizationRole: 'admin', removeOtherOrganizationRoles: true, unselectedSites: 'leave_unchanged', protectedOwners: [{ email: 'owner@example.org', name: 'Owner', sites: { basel: true, brugg: true, olten: true } }], lecturers: [{ email: 'teacher@example.org', name: 'Teacher', sites: { basel: true, brugg: false, olten: true } }] };
}
function inventory() {
  return { sites: {
    basel: { ok: true, members: [{ email: 'teacher@example.org', roles: ['modeler', 'analyst', 'admin'] }, { email: 'owner@example.org', roles: ['admin', 'owner'] }] },
    brugg: { ok: true, members: [{ email: 'teacher@example.org', roles: ['analyst'] }] },
    olten: { ok: true, members: [] },
  } };
}

test('lecturer settings normalize email, keep three checkbox values and enforce the sole admin target', () => {
  const c = fixture();c.lecturers[0].email = ' TEACHER@EXAMPLE.ORG ';
  assert.equal(validateAdminConfig(c).lecturers[0].email, 'teacher@example.org');
  c.organizationRole = 'owner';
  assert.throws(() => validateAdminConfig(c), /Rollenrichtlinie/);
});

test('owner, organization boundaries, duplicate emails, and unexpected secret fields cannot be changed through settings', () => {
  const current = validateAdminConfig(fixture());
  const changedOwner = fixture();changedOwner.protectedOwners[0].sites.basel = false;
  assert.throws(() => validateAdminConfig(changedOwner, current), /nicht bearbeitbar/);
  const changedOrg = fixture();changedOrg.organizations.basel = current.organizations.olten;
  assert.throws(() => validateAdminConfig(changedOrg, current), /nicht bearbeitbar/);
  const duplicate = fixture();duplicate.lecturers[0].email = duplicate.protectedOwners[0].email;
  assert.throws(() => validateAdminConfig(duplicate), /Doppelte E-Mail/);
  assert.throws(() => validateAdminConfig({ ...fixture(), apiKey: 'never-store-secrets' }), /Unerwartete Felder/);
});

test('local JSON saves persist site selection, reject stale revisions and preserve owners', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-admin-'));
  const filename = path.join(dir, 'admin-config.json');
  t.after(() => { fs.unlinkSync(filename);fs.rmdirSync(dir); });
  fs.writeFileSync(filename, JSON.stringify(fixture()));
  const before = loadAdminConfig(filename);
  const changed = structuredClone(before.config);changed.lecturers[0].sites.brugg = true;changed.lecturers[0].name = 'Local lecturer name';
  const after = saveAdminConfig(filename, changed, before.revision);
  assert.equal(after.config.lecturers[0].sites.brugg, true);
  assert.equal(after.config.lecturers[0].name, 'Local lecturer name');
  assert.deepEqual(after.config.protectedOwners, before.config.protectedOwners);
  assert.throws(() => saveAdminConfig(filename, before.config, before.revision), /zwischenzeitlich/);
  assert.deepEqual(loadAdminConfig(filename), after);
});

test('role preview removes redundant organization roles only at selected sites and never modifies owners', () => {
  const plan = adminRolePreview(validateAdminConfig(fixture()), inventory());
  const teacher = plan.filter(p => p.email === 'teacher@example.org');
  assert.deepEqual(teacher[0].targetRoles, ['admin']);
  assert.deepEqual(teacher[0].removeRoles, ['modeler', 'analyst']);
  assert.equal(teacher[1].action, 'unmanaged');
  assert.deepEqual(teacher[1].targetRoles, ['analyst']);
  assert.equal(teacher[2].action, 'invite');
  assert.ok(plan.filter(p => p.email === 'owner@example.org').every(p => p.action === 'protected' && p.removeRoles.length === 0));
});

test('additional organization roles can be retained and actual discovered owners are always protected', () => {
  const c = fixture();c.removeOtherOrganizationRoles = false;
  const source = inventory();
  let plan = adminRolePreview(c, source);
  assert.deepEqual(plan.find(p => p.email === 'teacher@example.org' && p.site === 'basel').removeRoles, []);
  source.sites.olten.members.push({ email: 'teacher@example.org', roles: ['owner'] });
  plan = adminRolePreview(c, source);
  assert.equal(plan.find(p => p.email === 'teacher@example.org' && p.site === 'olten').action, 'protected');
});

test('all-site inventory is read-only and a failed site remains unknown rather than planning invitations', async () => {
  const c = fixture(), calls = [];
  const source = await readAdminInventory(c, site => ({
    hub: async (endpoint, options) => { calls.push([site, endpoint]);assert.equal(options, undefined);return { authorizedOrganization: site === 'olten' ? c.organizations.basel : c.organizations[site] }; },
    console: async (endpoint, options) => { calls.push([site, endpoint]);assert.equal(endpoint, '/members');assert.equal(options, undefined);return [{ email: 'teacher@example.org', roles: ['analyst'] }]; },
  }));
  assert.equal(source.sites.olten.ok, false);
  assert.equal(source.sites.olten.members, null);
  assert.equal(calls.filter(([,endpoint]) => endpoint === '/members').length, 2);
  const failed = adminRolePreview(c, source).find(p => p.email === 'teacher@example.org' && p.site === 'olten');
  assert.equal(failed.action, 'unknown');
  assert.equal(failed.targetRoles, null);
});

test('local config writes require a loopback host, matching origin and JSON content type', () => {
  const headers = { host: '127.0.0.1:3300', origin: 'http://127.0.0.1:3300', 'content-type': 'application/json' };
  assert.equal(allowLocalConfigWrite({ headers }), true);
  for (const override of [{ origin: 'https://other.example.org' }, { host: 'attacker.example.org' }, { 'content-type': 'text/plain' }]) assert.equal(allowLocalConfigWrite({ headers: { ...headers, ...override } }), false);
  assert.deepEqual(Object.keys(fixture().organizations), SITE_IDS);
});
