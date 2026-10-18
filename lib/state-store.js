const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const stores = new Map();
const canonical = root => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const parse = raw => JSON.parse(raw.replace(/^\uFEFF/, ''));
const isStateName = name => ['admin-config.json', 'site-setup.json', 'definition-cleanup-state.json'].includes(name) || name.endsWith('.local.json') && !/(?:^|-)lock(?:-|\.)/.test(name);

class StateDatabase {
  constructor(root) {
    this.root = path.resolve(root); this.file = path.join(this.root, 'camundaadmin.sqlite');
    this.db = new DatabaseSync(this.file); fs.chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(name TEXT PRIMARY KEY, content TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migration_files(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations(site TEXT PRIMARY KEY, organization_id TEXT, cluster_id TEXT, environment_id TEXT, runtime_base TEXT, runtime_client_name TEXT, credential_file TEXT);
      CREATE TABLE IF NOT EXISTS lecturers(email TEXT PRIMARY KEY, name TEXT NOT NULL, protected INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lecturer_sites(email TEXT NOT NULL REFERENCES lecturers(email) ON DELETE CASCADE, site TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(email,site));
      CREATE TABLE IF NOT EXISTS class_runs(run_key TEXT PRIMARY KEY, class_id TEXT NOT NULL, archived INTEGER NOT NULL, site TEXT NOT NULL, lecturer_email TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, revision TEXT, created_at TEXT, auto_enabled INTEGER NOT NULL, auto_status TEXT);
      CREATE TABLE IF NOT EXISTS class_groups(run_key TEXT NOT NULL REFERENCES class_runs(run_key) ON DELETE CASCADE, group_id TEXT NOT NULL, name TEXT NOT NULL, workspace_key TEXT, tenant_id TEXT, runtime_group_id TEXT, PRIMARY KEY(run_key,group_id));
      CREATE TABLE IF NOT EXISTS class_students(run_key TEXT NOT NULL, group_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, removed INTEGER NOT NULL, pending_reason TEXT, PRIMARY KEY(run_key,group_id,email), FOREIGN KEY(run_key,group_id) REFERENCES class_groups(run_key,group_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS lecturer_resources(resource_key TEXT PRIMARY KEY, site TEXT NOT NULL, email TEXT NOT NULL, organization_id TEXT, workspace_key TEXT, tenant_id TEXT, runtime_base TEXT);
      CREATE TABLE IF NOT EXISTS receipts(name TEXT PRIMARY KEY REFERENCES documents(name) ON DELETE CASCADE, kind TEXT NOT NULL, site TEXT, class_id TEXT, status TEXT, checked_at TEXT, action TEXT);
      CREATE INDEX IF NOT EXISTS class_runs_scope ON class_runs(site,lecturer_email,day,archived);
      CREATE INDEX IF NOT EXISTS class_students_email ON class_students(email);
      CREATE INDEX IF NOT EXISTS receipts_scope ON receipts(site,kind,status);`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  read(name) { const row = this.db.prepare('SELECT content FROM documents WHERE name=?').get(name); if (!row) throw Object.assign(new Error('Gespeicherte Daten fehlen: ' + name), { code: 'ENOENT' }); return row.content; }
  exists(name) { return Boolean(this.db.prepare('SELECT 1 FROM documents WHERE name=?').get(name)); }
  names() { return this.db.prepare('SELECT name FROM documents ORDER BY name').all().map(row => row.name); }
  put(name, content, { expectedHash } = {}) {
    if (!isStateName(name) || path.basename(name) !== name) throw new Error('Unzulässiger Datenbank-Datensatz.');
    const data = parse(content);
    return this.transaction(() => {
      if (expectedHash && this.db.prepare('SELECT sha256 FROM documents WHERE name=?').get(name)?.sha256 !== expectedHash) throw new Error('Konfiguration wurde zwischenzeitlich geändert.');
      this.upsert(name, content); this.project(name, data);
    });
  }
  upsert(name, content) { this.db.prepare('INSERT INTO documents(name,content,sha256,updated_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET content=excluded.content,sha256=excluded.sha256,updated_at=excluded.updated_at').run(name, content, hash(content), new Date().toISOString()); }
  project(name, data) {
    if (['admin-config.json', 'site-setup.json'].includes(name)) {
      const config = this.exists('admin-config.json') ? parse(this.read('admin-config.json')) : {}, setup = this.exists('site-setup.json') ? parse(this.read('site-setup.json')) : {};
      this.db.exec('DELETE FROM organizations; DELETE FROM lecturer_sites; DELETE FROM lecturers;');
      const org = this.db.prepare('INSERT INTO organizations VALUES (?,?,?,?,?,?,?)');
      for (const site of new Set([...Object.keys(config.organizations || {}), ...Object.keys(setup.sites || {})])) { const c = setup.sites?.[site] || {}; org.run(site, config.organizations?.[site] || null, c.clusterId || null, c.environmentId || null, c.runtimeBase || null, c.runtimeClientName || null, c.runtimeCredentialsFile || null); }
      for (const [people, protectedAccount] of [[config.protectedOwners || [], 1], [config.lecturers || [], 0]]) for (const person of people) {
        this.db.prepare('INSERT INTO lecturers VALUES (?,?,?)').run(person.email, person.name || '', protectedAccount);
        for (const [site, enabled] of Object.entries(person.sites || {})) this.db.prepare('INSERT INTO lecturer_sites VALUES (?,?,?)').run(person.email, site, enabled ? 1 : 0);
      }
    }
    if (name === 'classes.local.json') {
      if (data.schemaVersion !== 1 || !Array.isArray(data.classes)) throw new Error('Klassenablage ist ungültig.');
      this.db.exec('DELETE FROM class_runs');
      for (const [classes, archived] of [[data.classes, 0], [data.archivedClasses || [], 1]]) classes.forEach((c, index) => {
        const key = (archived ? 'archive:' + index + ':' : 'active:') + c.id;
        this.db.prepare('INSERT INTO class_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(key, c.id, archived, c.site, c.lecturerEmail, c.day, c.status, c.revision || null, c.createdAt || null, c.autoAccess?.enabled ? 1 : 0, c.autoAccess?.status || null);
        for (const g of c.groups) {
          this.db.prepare('INSERT INTO class_groups VALUES (?,?,?,?,?,?)').run(key, g.id, g.name, g.workspaceKey || null, g.tenantId || null, g.runtimeGroupId || null);
          for (const s of g.students) this.db.prepare('INSERT INTO class_students VALUES (?,?,?,?,?,?)').run(key, g.id, s.email, s.name || '', c.cleanupState?.students?.includes(s.email) ? 1 : 0, (c.pendingStudents || []).find(p => p.email === s.email)?.reason || null);
        }
      });
    }
    if (name === 'lecturer-resources.local.json') {
      this.db.exec('DELETE FROM lecturer_resources');
      for (const [key, entry] of Object.entries(data.entries || {})) { const [site, email] = key.split('/'); this.db.prepare('INSERT INTO lecturer_resources VALUES (?,?,?,?,?,?,?)').run(key, site, email, entry.organizationId || null, entry.workspaceKey || null, entry.tenantId || null, entry.runtimeBase || null); }
    }
    const kind = /^(cleanup-(?:basel|brugg|olten)-[a-f0-9-]{36}|class-action-|lecturer-action-|site-action-|cluster-start-)/.test(name) ? name.startsWith('cleanup-') ? 'cleanup' : name.startsWith('class-action') ? 'class' : name.startsWith('lecturer-action') ? 'lecturer' : name.startsWith('site-action') ? 'site' : 'cluster' : null;
    if (kind) this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind,site=excluded.site,class_id=excluded.class_id,status=excluded.status,checked_at=excluded.checked_at,action=excluded.action').run(name, kind, data.site || name.match(/(?:basel|brugg|olten)/)?.[0] || null, data.classId || null, data.status || data.phase || null, data.checkedAt || data.verifiedAt || data.requestedAt || data.startedAt || null, data.action || data.type || null);
  }
  migrate() {
    if (this.db.prepare("SELECT value FROM state_metadata WHERE key='json-migrated'").get()) return;
    if (fs.readdirSync(this.root).some(name => /(?:^|-)lock(?:-|\.)/.test(name) || name.endsWith('.lock'))) throw new Error('Sperrdatei vorhanden; laufende oder unbestätigte Änderungen vor der Migration prüfen.');
    const files = fs.readdirSync(this.root).filter(isStateName).map(name => { const raw = fs.readFileSync(path.join(this.root, name)); const content = raw.toString('utf8'); parse(content); return { name, content, bytes: raw.length, sha256: hash(raw) }; });
    const old = path.join(this.root, 'operations.local.sqlite');
    if (fs.existsSync(old)) this.db.prepare('ATTACH DATABASE ? AS old_audit').run(old);
    try {
      this.transaction(() => {
        for (const row of files) this.upsert(row.name, row.content);
        for (const row of files) { if (hash(this.read(row.name)) !== row.sha256) throw new Error('Migration ist nicht verlustfrei.'); this.project(row.name, parse(row.content)); this.db.prepare('INSERT INTO migration_files VALUES (?,?,?)').run(row.name, row.sha256, row.bytes); }
        if (fs.existsSync(old)) {
          for (const table of ['events', 'metadata']) {
            const schema = this.db.prepare("SELECT sql FROM old_audit.sqlite_master WHERE type='table' AND name=?").get(table);
            if (schema) { this.db.exec(schema.sql); this.db.exec(`INSERT INTO main.${table} SELECT * FROM old_audit.${table}`); }
          }
          const count = this.db.prepare('SELECT count(*) AS n FROM old_audit.events').get().n;
          if (this.db.prepare('SELECT count(*) AS n FROM main.events').get().n !== count) throw new Error('Ereignisübernahme unvollständig.');
          this.db.prepare("INSERT INTO state_metadata VALUES ('audit-migrated-count',?)").run(String(count));
        }
        this.db.prepare("INSERT INTO state_metadata VALUES ('json-migrated',?)").run(new Date().toISOString());
        this.db.prepare("INSERT INTO state_metadata VALUES ('schema-version','1')").run();
      });
    } finally { if (fs.existsSync(old)) this.db.exec('DETACH DATABASE old_audit'); }
    if (this.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Datenbankprüfung fehlgeschlagen.');
  }
  verifyLegacy() {
    if (this.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Datenbankprüfung fehlgeschlagen.');
    for (const row of this.db.prepare('SELECT * FROM migration_files').all()) {
      const file = path.join(this.root, row.name);
      if (fs.existsSync(file) && (fs.statSync(file).size !== row.bytes || hash(fs.readFileSync(file)) !== row.sha256)) throw new Error('Quelldatei wurde nach der Migration geändert: ' + row.name);
    }
    return this.db.prepare('SELECT count(*) AS n FROM migration_files').get().n;
  }
  verifyAudit() {
    const file = path.join(this.root, 'operations.local.sqlite');
    if (!fs.existsSync(file)) return;
    this.db.prepare('ATTACH DATABASE ? AS verify_audit').run(file);
    try {
      const expected = Number(this.db.prepare("SELECT value FROM state_metadata WHERE key='audit-migrated-count'").get()?.value);
      if (!Number.isFinite(expected) || this.db.prepare('SELECT count(*) AS n FROM verify_audit.events').get().n !== expected) throw new Error('Altes Ereignisprotokoll wurde verändert.');
      if (this.db.prepare('SELECT count(*) AS n FROM (SELECT * FROM verify_audit.events EXCEPT SELECT * FROM main.events)').get().n) throw new Error('Ereignisse wurden nicht vollständig übernommen.');
    } finally { this.db.exec('DETACH DATABASE verify_audit'); }
  }
  pruneLegacy() {
    this.verifyLegacy(); this.verifyAudit();
    const allowed = new Set(this.db.prepare('SELECT name FROM migration_files').all().map(r => r.name));
    const actual = fs.readdirSync(this.root).filter(isStateName);
    if (actual.some(name => !allowed.has(name))) throw new Error('Nicht migrierte JSON-Datei gefunden; Bereinigung gestoppt.');
    const candidates = [...actual, ...['operations.local.sqlite', 'operations.local.sqlite-wal', 'operations.local.sqlite-shm'].filter(name => fs.existsSync(path.join(this.root, name)))];
    // Exact file unlink only, always inside this service's data directory.
    for (const name of candidates) { const file = path.resolve(this.root, name); if (path.dirname(file) !== this.root || !fs.lstatSync(file).isFile()) throw new Error('Unzulässiges Bereinigungsziel.'); }
    for (const name of candidates) fs.unlinkSync(path.join(this.root, name));
    this.db.prepare("INSERT INTO state_metadata VALUES ('legacy-pruned-at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
    return candidates.length;
  }
  close() { stores.delete(canonical(this.root)); this.db.close(); }
}

function initializeStore(root) {
  const key = canonical(root); if (stores.has(key)) return stores.get(key);
  const store = new StateDatabase(root);
  try { store.migrate(); stores.set(key, store); return store; } catch (error) { store.db.close(); throw error; }
}
const storeFor = file => stores.get(canonical(path.dirname(path.resolve(file))));
const getStore = root => stores.get(canonical(root));
function readText(file) { const store = storeFor(file); return store ? store.read(path.basename(file)) : fs.readFileSync(file, 'utf8'); }
function exists(file) { const store = storeFor(file); return store ? store.exists(path.basename(file)) : fs.existsSync(file); }
function list(root) { const store = getStore(root); return store ? store.names() : fs.readdirSync(root); }
function readJson(file) { return parse(readText(file)); }
function writeText(file, content, options = {}) {
  const store = storeFor(file); if (store) return store.put(path.basename(file), content, options);
  const temp = file + '.tmp';
  try { fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  catch (error) { if (error.code !== 'EEXIST') try { fs.unlinkSync(temp); } catch {} throw error; }
}
function writeJson(file, data) { return writeText(file, JSON.stringify(data, null, 2)); }
module.exports = { StateDatabase, initializeStore, getStore, readText, readJson, writeText, writeJson, exists, list, isStateName };
