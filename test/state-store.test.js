const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { initializeStore, readJson, writeJson, readText, list } = require('../lib/state-store');
const { ActivityLog } = require('../lib/activity-log');
const { loadAdminConfig, saveAdminConfig } = require('../lib/admin-config');
const { loadSetup } = require('../lib/site-setup');
const { Classroom } = require('../lib/classroom');
const { ClusterStart } = require('../lib/cluster-start');
const { LecturerResources } = require('../lib/lecturer-resources');
const { OpenAssignments } = require('../lib/open-assignments');
const { reconcileClassCleanup } = require('../lib/class-cleanup-state');

function fixture(t) {
  const f = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-db-')), store: null };
  t.after(() => { f.store?.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  f.file = name => path.join(f.root, name);
  for (const file of ['admin-config.json', 'site-setup.json']) fs.copyFileSync(path.join(__dirname, '..', file), f.file(file));
  f.classroom = { id: 'class-1', site: 'basel', lecturerEmail: 'achim.dannecker@fhnw.ch', lecturerName: 'Teacher', day: 'mi', status: 'ready', revision: 'r1', createdAt: '2026-10-18T09:00:00Z', autoAccess: { enabled: true, status: 'completed' }, groups: [{ id: 'g1', name: 'Group 1', workspaceKey: 'w1', tenantId: 't1', runtimeGroupId: 'g1', students: [{ email: 'student@example.org', name: 'Student' }] }] };
  fs.writeFileSync(f.file('classes.local.json'), JSON.stringify({ schemaVersion: 1, classes: [f.classroom] }, null, 2));
  fs.writeFileSync(f.file('lecturer-resources.local.json'), JSON.stringify({ schemaVersion: 1, entries: { 'basel/achim.dannecker@fhnw.ch': { workspaceKey: 'private-w', tenantId: 'private-t' } } }));
  f.open = () => { f.store = initializeStore(f.root); return f.store; }; return f;
}

test('migration preserves exact revisions and audit events, normalizes relations and remains usable after all legacy files are removed', t => {
  const f = fixture(t), before = loadAdminConfig(f.file('admin-config.json')).revision;
  const log = new ActivityLog(f.root); log.record({ event: 'service.start', status: 'completed', actor: 'Owner' }); log.close();
  const store = f.open(); assert.equal(loadAdminConfig(f.file('admin-config.json')).revision, before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM class_students').get().n, 1);
  assert.equal(store.db.prepare('SELECT workspace_key FROM class_groups').get().workspace_key, 'w1');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM organizations').get().n, 3);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  const active = new ActivityLog(f.root); assert.equal(active.db, store.db); active.close();
  assert.ok(store.pruneLegacy() >= 5);
  assert.equal(fs.existsSync(f.file('classes.local.json')), false); assert.equal(fs.existsSync(f.file('operations.local.sqlite')), false);
  const manager = new Classroom({ root: f.root }); assert.equal(manager.load().classes.length, 1);
  const classes = manager.load(); classes.classes[0].groups[0].students[0].name = 'Updated'; manager.save(classes);
  assert.equal(fs.existsSync(f.file('classes.local.json')), false); assert.equal(store.db.prepare('SELECT name FROM class_students').get().name, 'Updated');
  const current = loadAdminConfig(f.file('admin-config.json')); const config = structuredClone(current.config); config.lecturers[0].name = 'Updated teacher';
  saveAdminConfig(f.file('admin-config.json'), config, current.revision); assert.equal(fs.existsSync(f.file('admin-config.json')), false);
  assert.equal(store.db.prepare('SELECT name FROM lecturers WHERE email=?').get(config.lecturers[0].email).name, 'Updated teacher');
  assert.throws(() => saveAdminConfig(f.file('admin-config.json'), config, current.revision), /zwischenzeitlich/);
  const setup = loadSetup(f.root, 'basel'); assert.ok(setup.clusterId);
  const start = new ClusterStart({ root: f.root }); start.save('basel', { clusterId: setup.clusterId, organizationId: setup.organizationId, phase: 'verified' }); assert.equal(start.receipt('basel', setup).phase, 'verified');
  const resources = new LecturerResources({ root: f.root }); assert.equal(resources.registry().entries['basel/achim.dannecker@fhnw.ch'].workspaceKey, 'private-w');
  resources.saveRegistry({ schemaVersion: 1, entries: {} }); assert.equal(store.db.prepare('SELECT count(*) AS n FROM lecturer_resources').get().n, 0);
  const pending = new OpenAssignments({ root: f.root, classroom: manager }); pending.save({ classes: {} }); assert.deepEqual(pending.load(), { classes: {} });
  writeJson(f.file('cleanup-basel-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.local.json'), { site: 'basel', status: 'incomplete', checkedAt: '2026-10-18T10:00:00Z', results: [{ kind: 'students', id: 'student@example.org', status: 'verified' }] });
  assert.equal(reconcileClassCleanup(f.root), 1); assert.equal(manager.load().classes[0].autoAccess.enabled, false);
  assert.equal(store.db.prepare('SELECT removed FROM class_students').get().removed, 1);
  assert.ok(list(f.root).includes('assignment-status.local.json')); assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.json')).length, 0);
  store.close(); f.open(); assert.equal(readJson(f.file('classes.local.json')).classes[0].status, 'attention');
});

test('a failed relational write rolls back both original document and projections', t => {
  const f = fixture(t), store = f.open(), before = readText(f.file('classes.local.json'));
  const bad = JSON.parse(before); bad.classes[0].groups.push(structuredClone(bad.classes[0].groups[0]));
  assert.throws(() => writeJson(f.file('classes.local.json'), bad));
  assert.equal(readText(f.file('classes.local.json')), before); assert.equal(store.db.prepare('SELECT count(*) AS n FROM class_groups').get().n, 1);
});

test('migration refuses operation locks but does not treat package-lock.json as an application lock', t => {
  const f = fixture(t); fs.writeFileSync(f.file('package-lock.json'), '{}'); fs.writeFileSync(f.file('classes-lock.local.json'), '');
  assert.throws(() => f.open(), /Sperrdatei/); fs.unlinkSync(f.file('classes-lock.local.json'));
  assert.ok(f.open()); assert.equal(f.store.names().includes('package-lock.json'), false);
});

test('invalid JSON aborts migration atomically; cleanup refuses changed or unimported files and retains credentials', t => {
  const f = fixture(t); fs.writeFileSync(f.file('bad.local.json'), '{invalid');
  assert.throws(() => f.open()); assert.equal(fs.existsSync(f.file('classes.local.json')), true);
  fs.unlinkSync(f.file('bad.local.json')); const store = f.open();
  const file = f.file('classes.local.json'), original = fs.readFileSync(file); fs.appendFileSync(file, ' ');
  assert.throws(() => store.pruneLegacy(), /geändert/); assert.equal(fs.existsSync(file), true); fs.writeFileSync(file, original);
  fs.writeFileSync(f.file('new.local.json'), '{}'); assert.throws(() => store.pruneLegacy(), /Nicht migrierte/); fs.unlinkSync(f.file('new.local.json'));
  fs.writeFileSync(f.file('credentials_basel.txt'), 'secret'); fs.writeFileSync(f.file('.env'), 'secret'); store.pruneLegacy();
  assert.equal(fs.existsSync(f.file('credentials_basel.txt')), true); assert.equal(fs.existsSync(f.file('.env')), true);
});
