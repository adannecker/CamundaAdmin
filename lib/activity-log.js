const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const dataStore = require('./state-store');
const context = new AsyncLocalStorage();
const fields = ['site', 'actor', 'lecturerEmail', 'classId', 'email', 'groupName', 'runId'];
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, 350) : '';
const pick = object => Object.fromEntries(fields.map(key => [key, text(object?.[key])]));
const eventLabels = {
  'excel.analyze': 'Excel mit KI analysieren', 'class.save': 'Klassenentwurf speichern', 'class.group': 'Gruppe ergänzen',
  'class.provision': 'Klasse in Camunda einrichten', 'class.projects': 'Gruppenprojekte ergänzen', 'class.move': 'Studierendenkonto verschieben', 'access.configure': 'Zuweisungsautomatik ändern',
  'access.sync': 'Automatische Benutzerzuweisung', 'cleanup.analyze': 'Bestand analysieren', 'cleanup.preview': 'Löschvorschau erstellen', 'cleanup.apply': 'Cleanup ausführen',
  'student.accepted': 'Studierende: Einladung angenommen erkannt', 'student.workspace': 'Studierende: Workspace-Zugriff bestätigt',
  'student.runtime': 'Studierende: Runtime-Zuordnung bestätigt', 'student.assigned': 'Studierende: vollständig zugewiesen',
  'lecturer.apply': 'Dozentenressourcen ändern', 'lecturer.preview': 'Dozentenänderung vorbereiten', 'roles.preview': 'Rollenabgleich vorbereiten', 'roles.apply': 'Dozentenrollen abgleichen',
  'config.save': 'Dozentenkonfiguration speichern', 'site.apply': 'Standort vorbereiten', 'cluster.start': 'Cluster starten',
  'class.preview': 'Klassenrechte prüfen', 'move.preview': 'Gruppenwechsel vorbereiten', 'access.check': 'Einladungen und Zuweisungen prüfen',
  'remote.write': 'Camunda-API ändern', 'service.start': 'Dienst gestartet', 'history.receipt': 'Vorhandener Ausführungsbeleg',
};
const statuses = new Set(['started', 'completed', 'accepted', 'waiting', 'incomplete', 'failed', 'stopped', 'paused', 'verified', 'uncertain']);

class ActivityLog {
  constructor(root, { now = Date.now } = {}) {
    this.root = root; this.now = now;
    const file = path.join(root, 'operations.local.sqlite');
    this.ownsDb = !dataStore.getStore(root);
    this.db = dataStore.getStore(root)?.db || new DatabaseSync(file);
    if (this.ownsDb) fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL,
        site TEXT NOT NULL, actor TEXT NOT NULL, lecturerEmail TEXT NOT NULL, classId TEXT NOT NULL, email TEXT NOT NULL, groupName TEXT NOT NULL,
        runId TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL, method TEXT NOT NULL, resource TEXT NOT NULL, count INTEGER);
      CREATE INDEX IF NOT EXISTS events_time ON events(at DESC,seq DESC);
      CREATE INDEX IF NOT EXISTS events_site ON events(site,at);
      CREATE INDEX IF NOT EXISTS events_class ON events(classId,at);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  run(values, fn) { return context.run({ ...context.getStore(), ...Object.fromEntries(fields.filter(key => values?.[key] !== undefined).map(key => [key, text(values[key])])), log: this }, fn); }
  enrich(values) { const current = context.getStore(); if (current?.log === this) for (const key of fields) if (values?.[key] !== undefined) current[key] = text(values[key]); }
  record(input) {
    const current = context.getStore() || {};
    const row = { ...pick(current), ...Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, text(input[key])])),
      id: input.id || crypto.randomUUID(), at: input.at || new Date(this.now()).toISOString(), event: eventLabels[input.event] ? input.event : 'history.receipt',
      status: statuses.has(input.status) ? input.status : 'uncertain', summary: text(input.summary || eventLabels[input.event]),
      source: input.source === 'history' ? 'history' : 'live', method: ['POST', 'PUT', 'DELETE', 'PATCH'].includes(input.method) ? input.method : '',
      resource: text(input.resource), count: Number.isSafeInteger(input.count) && input.count >= 0 ? input.count : null };
    if (!Number.isFinite(Date.parse(row.at))) throw new Error('Ungültiger Ereigniszeitpunkt.');
    const keys = Object.keys(row);
    this.db.prepare(`INSERT OR IGNORE INTO events (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
    return row.id;
  }
  async operation(event, values, fn) {
    return this.run({ ...context.getStore(), ...values, runId: context.getStore()?.runId || crypto.randomUUID() }, async () => {
      const scope = pick(context.getStore());
      this.record({ event, status: 'started' });
      try {
        const result = await fn();
        const status = result?.status === 'incomplete' ? 'incomplete' : result?.classroom?.pendingStudents?.length ? 'waiting' : 'completed';
        this.record({ ...scope, event, status, count: Array.isArray(result?.results) ? result.results.length : undefined });
        return result;
      } catch (error) { this.record({ ...scope, event, status: 'failed', summary: eventLabels[event] + ' fehlgeschlagen' + (error.status ? ` (HTTP ${Number(error.status) || 500})` : '') }); throw error; }
    });
  }
  wrap(target, method, event, describe = () => ({})) {
    const original = target[method].bind(target);
    target[method] = (...args) => this.operation(event, describe(...args), () => original(...args));
  }
  query(filters = {}) {
    const where = [], args = [];
    for (const key of ['site', 'event', 'status', 'lecturerEmail', 'classId', 'runId']) if (filters[key]) { where.push(`${key}=?`); args.push(String(filters[key]).slice(0, 350)); }
    for (const [key, sign] of [['since', '>='], ['until', '<=']]) if (filters[key]) { if (!Number.isFinite(Date.parse(filters[key]))) throw new Error('Ungültiger Zeitraum.'); where.push(`at${sign}?`); args.push(new Date(filters[key]).toISOString()); }
    if (filters.q) { where.push("(summary||' '||actor||' '||email||' '||groupName||' '||lecturerEmail) LIKE ? ESCAPE '\\'"); args.push('%' + String(filters.q).slice(0, 150).replace(/[\\%_]/g, '\\$&') + '%'); }
    if (filters.before) {
      let cursor; try { cursor = JSON.parse(Buffer.from(filters.before, 'base64url')); } catch { throw new Error('Ungültige Protokollseite.'); }
      if (typeof cursor.at !== 'string' || !Number.isSafeInteger(cursor.seq)) throw new Error('Ungültige Protokollseite.');
      where.push('(at < ? OR (at = ? AND seq < ?))'); args.push(cursor.at, cursor.at, cursor.seq);
    }
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 50));
    const rows = this.db.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC,seq DESC LIMIT ?`).all(...args, limit + 1);
    const more = rows.length > limit; if (more) rows.pop(); const last = rows.at(-1);
    return { events: rows, next: more ? Buffer.from(JSON.stringify({ at: last.at, seq: last.seq })).toString('base64url') : null, eventTypes: eventLabels };
  }
  importReceipts(classes) {
    if (this.db.prepare("SELECT value FROM metadata WHERE key='history-imported'").get()) return;
    const classById = new Map(classes.map(c => [c.id, c]));
    for (const file of dataStore.list(this.root)) {
      if (!/^(class-action-[a-f0-9-]{36}|lecturer-action-[a-f0-9-]{36}|cleanup-(basel|brugg|olten)-[a-f0-9-]{36}|site-action-(basel|brugg|olten)-[a-z-]+|cluster-start-(basel|brugg|olten))\.local\.json$/.test(file)) continue;
      let r; try { r = dataStore.readJson(path.join(this.root, file)); } catch { continue; }
      const c = classById.get(r.classId), at = r.verifiedAt || r.checkedAt || r.requestedAt || r.startedAt;
      if (!at || !Number.isFinite(Date.parse(at))) continue;
      const status = { accepted: 'accepted', verified: 'verified', completed: 'completed', incomplete: 'incomplete', rejected: 'failed', pending: 'uncertain', running: 'uncertain', submitting: 'uncertain', uncertain: 'uncertain' }[r.status || r.phase] || 'uncertain';
      const id = 'history-' + crypto.createHash('sha256').update(file + at + status).digest('hex');
      const event = file.startsWith('class-action') ? r.type === 'move' ? 'class.move' : 'class.provision' : file.startsWith('lecturer-action') ? 'lecturer.apply' : file.startsWith('cleanup-') ? 'cleanup.apply' : file.startsWith('cluster-start') ? 'cluster.start' : 'site.apply';
      this.record({ id, at: new Date(at).toISOString(), event, status, source: 'history', site: r.site || c?.site || file.match(/(?:basel|brugg|olten)/)?.[0],
        classId: c?.id, lecturerEmail: c?.lecturerEmail || (event === 'lecturer.apply' ? r.email : ''), email: r.email, actor: 'Historischer Beleg',
        runId: file.replace('.local.json', ''), summary: eventLabels[event] + (r.action ? ': ' + text(r.action) : '') + ' · Zeitpunkt des gespeicherten Belegs', count: r.results?.length });
    }
    this.db.prepare("INSERT INTO metadata(key,value) VALUES ('history-imported',?)").run(new Date(this.now()).toISOString());
  }
  close() { if (this.ownsDb) this.db.close(); }
}

async function remoteWrite(endpoint, options, fn) {
  const store = context.getStore();
  if (!store?.log || !['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method || '') || endpoint.split('?')[0].endsWith('/search')) return fn();
  // Never persist headers, raw URLs, request/response bodies, credentials or Excel cells.
  const parts = endpoint.split('?')[0].split('/').filter(Boolean), resources = new Set(['workspaces', 'members', 'groups', 'tenants', 'roles', 'authorizations', 'clients', 'wake', 'users', 'environments', 'process-instances', 'user-tasks', 'collaborators']);
  const resource = parts.filter(part => resources.has(part)).join(' / ') || 'Camunda-Ressource';
  const email = typeof options.body?.email === 'string' ? options.body.email : [...parts].reverse().map(p => { try { return decodeURIComponent(p); } catch { return ''; } }).find(p => /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(p));
  const data = { event: 'remote.write', method: options.method, resource, ...(email ? { email } : {}), summary: `${options.method} ${resource}` };
  store.log.record({ ...data, status: 'started' });
  try { const result = await fn(); store.log.record({ ...data, status: 'accepted', summary: data.summary + ' · API-Aufruf angenommen; fachlicher Abschluss im Laufprotokoll' }); return result; }
  catch (error) { store.log.record({ ...data, status: error.status >= 400 && error.status < 500 ? 'failed' : 'uncertain' }); throw error; }
}
module.exports = { ActivityLog, remoteWrite, eventLabels };
