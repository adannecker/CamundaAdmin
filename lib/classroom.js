const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadAdminConfig, SITE_IDS } = require('./admin-config');
const { searchAll } = require('./onboarding');
const { runtimeSearch } = require('./tenancy');
const { readExcel, analyzeRoster } = require('./roster-import');
const { CleanupError } = require('./cleanup');
const { analyzeCleanup } = require('./cleanup-analysis');
const { ClassAccess } = require('./class-access');

const DAYS = { mo: 'Mo', di: 'Di', mi: 'Mi', do: 'Do', fr: 'Fr', sa: 'Sa', so: 'So' };
const emailOf = x => String(x.email || x.username || '').toLowerCase();
const canon = x => Array.isArray(x) ? x.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().filter(k => k !== 'checkedAt').map(k => [k, canon(x[k])])) : x;
const digest = x => crypto.createHash('sha256').update(JSON.stringify(canon(x))).digest('hex');
const same = (a, b) => digest(a) === digest(b);

class Classroom {
  constructor({ root, contextForSite, cleanup, parse = readExcel, analyze = analyzeRoster, now = Date.now }) {
    this.root = root; this.contextForSite = contextForSite; this.cleanup = cleanup; this.parse = parse; this.analyze = analyze; this.now = now;
    this.file = path.join(root, 'classes.local.json'); this.configFile = path.join(root, 'admin-config.json'); this.plans = new Map(); this.busy = false;
    this.access = new ClassAccess(this);
  }
  load() { const data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { schemaVersion: 1, classes: [] }; if (data.schemaVersion !== 1 || !Array.isArray(data.classes)) throw new Error('Klassenablage ist ungültig.'); return data; }
  save(data) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, this.file); }
  identity(site, lecturerEmail, day) {
    const loaded = loadAdminConfig(this.configFile);
    const lecturer = [...loaded.config.protectedOwners, ...loaded.config.lecturers].find(p => p.email === lecturerEmail && p.sites[site]);
    if (!SITE_IDS.includes(site) || !DAYS[day] || !lecturer) throw new CleanupError('Standort, dort konfigurierten Dozenten und Wochentag auswählen.', 400);
    return { ...loaded, lecturer, site, day, id: 'class-' + digest({ site, lecturerEmail, day }).slice(0, 24) };
  }
  metadata() { const { config } = loadAdminConfig(this.configFile); return { sites: SITE_IDS, lecturers: [...config.protectedOwners, ...config.lecturers], days: DAYS, classes: this.load().classes }; }
  remember(plan) { for (const [id, p] of this.plans) if (p.used || p.expires <= this.now()) this.plans.delete(id); if (this.plans.size >= 30) this.plans.delete(this.plans.keys().next().value); const id = crypto.randomUUID(); this.plans.set(id, { ...plan, id, expires: this.now() + 1800000, used: false }); return id; }
  async importPreview(input) {
    if (input.aiConsent !== 'full-workbook-v1') throw new CleanupError('Bitte die Seite neu laden und die Übertragung sämtlicher Tabelleninhalte an OpenAI ausdrücklich freigeben.', 400);
    const identity = this.identity(input.site, input.lecturerEmail, input.day);
    const existing = this.load().classes.find(c => c.id === identity.id);
    if (existing && existing.status !== 'draft') throw new CleanupError('Für diese Standort-/Dozenten-/Tag-Kombination besteht bereits eine Klasse. Gruppenwechsel dort bearbeiten.');
    const workbook = await this.parse(input.base64, input.filename), analysis = await this.analyze(workbook);
    const protectedAccounts = new Map([...identity.config.lecturers, ...identity.config.protectedOwners].map(p => [emailOf(p), p]));
    const excludedLecturers = analysis.students.filter(s => protectedAccounts.has(emailOf(s))).map(s => ({ ...s, email: emailOf(s), configuredName: protectedAccounts.get(emailOf(s)).name, reason: 'Konfiguriertes Dozenten-/Ownerkonto; wird nicht als Studierender übernommen.' }));
    const students = analysis.students.filter(s => !protectedAccounts.has(emailOf(s)));
    const warnings = [...analysis.warnings];
    if (excludedLecturers.length) warnings.push(excludedLecturers.length + ' erkannte Dozenten-/Ownerkonten werden separat aufgelistet und aus den Studierendengruppen ausgelassen. Ihre Rollen und Zugriffe bleiben unverändert.');
    if (!students.length) warnings.push('Keine Studierenden zur Übernahme erkannt. Die Analyse bleibt eine Vorschau; ein vorhandener Klassenentwurf bleibt erhalten.');
    const names = [...new Set(students.map(s => s.group))];
    if (names.length > 100) throw new CleanupError('Höchstens 100 Gruppen pro Klasse.');
    const groups = names.map(name => {
      const id = 'cls-' + digest({ classId: identity.id, name }).slice(0, 24), workspaceName = (identity.lecturer.name || identity.lecturer.email.split('@')[0]) + '_' + DAYS[input.day] + '_' + name;
      if (workspaceName.length > 255) throw new Error('Workspace-Name ist zu lang.');
      return { id, name, workspaceName, tenantId: id, runtimeGroupId: id, workspaceKey: null, students: students.filter(s => s.group === name).map(({ group, ...s }) => s) };
    });
    const classroom = { id: identity.id, site: input.site, lecturerEmail: input.lecturerEmail, lecturerName: identity.lecturer.name, day: input.day, groups, excludedLecturers, status: 'draft', createdAt: new Date().toISOString(), revision: crypto.randomUUID() };
    const previewId = students.length ? this.remember({ type: 'import', classroom, configRevision: identity.revision, previousRevision: existing?.revision || null }) : null;
    const structuredRoster = { groups: groups.map(g => ({ name: g.name, students: g.students })), excludedLecturers, warnings };
    return { previewId, classroom, warnings, excludedLecturers, model: analysis.model, transmittedRows: analysis.transmittedRows, transmittedSheets: analysis.transmittedSheets, structuredRoster, note: 'Nur lokale Vorschau. Noch keine Einladungen oder Camunda-Zuweisungen.' };
  }
  saveImport(id, acknowledged) {
    const p = this.plan(id, 'import', acknowledged), loaded = this.identity(p.classroom.site, p.classroom.lecturerEmail, p.classroom.day), data = this.load(), old = data.classes.find(c => c.id === p.classroom.id);
    if (this.busy || loaded.revision !== p.configRevision || (old?.revision || null) !== p.previousRevision) throw new CleanupError('Konfiguration oder Klasse wurde geändert.');
    const lock = path.join(this.root, 'classes-lock.local.json'); let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); const fresh = this.load(); if ((fresh.classes.find(c => c.id === p.classroom.id)?.revision || null) !== p.previousRevision) throw new Error('Klasse wurde geändert.'); p.used = true; fresh.classes = fresh.classes.filter(c => c.id !== p.classroom.id); fresh.classes.push(p.classroom); this.save(fresh); return { classroom: p.classroom, appliedToCamunda: false }; }
    finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
  }
  plan(id, type, acknowledged) { const p = this.plans.get(id); if (!p || p.used || p.expires <= this.now() || p.type !== type || acknowledged !== true) throw new CleanupError('Vorschau fehlt, wurde verwendet oder ist nicht bestätigt.'); return p; }
  get(id) { const c = this.load().classes.find(c => c.id === id); if (!c) throw new CleanupError('Klasse nicht gefunden.', 404); this.identity(c.site, c.lecturerEmail, c.day); return c; }
  addGroup(id, name) {
    const c = this.get(id); if (c.status !== 'draft' || this.busy || typeof name !== 'string' || !name.trim() || name.trim().length > 100 || c.groups.length >= 100 || c.groups.some(g => g.name === name.trim())) throw new CleanupError('Eindeutigen Gruppennamen im lokalen Entwurf angeben.', 400);
    const lock = path.join(this.root, 'classes-lock.local.json'); let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); const data = this.load(), fresh = data.classes.find(x => x.id === id); if (fresh.revision !== c.revision) throw new Error('Klasse wurde geändert.'); const gid = 'cls-' + digest({ classId: id, name: name.trim() }).slice(0, 24); const workspaceName = c.lecturerName + '_' + DAYS[c.day] + '_' + name.trim(); if (workspaceName.length > 255) throw new Error('Workspace-Name zu lang.'); fresh.groups.push({ id: gid, name: name.trim(), workspaceName, tenantId: gid, runtimeGroupId: gid, workspaceKey: null, students: [] }); fresh.revision = crypto.randomUUID(); this.save(data); return { classroom: fresh, appliedToCamunda: false }; }
    finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
  }
  marker(c, g) { return 'CamundaCleanup classroom ' + c.id + '; group ' + g.id; }
  async inspect(c) {
    const cxt = this.contextForSite(c.site), api = cxt.organizationApi;
    if ((await api.hub('/info')).authorizedOrganization !== cxt.expectedOrganization) throw new Error('Organisation stimmt nicht überein.');
    const members = await api.console('/members'), teacher = members.find(m => emailOf(m) === c.lecturerEmail);
    if (!teacher?.roles?.some(r => ['owner', 'admin'].includes(r)) || teacher.invitePending) throw new Error('Dozent muss zuerst aktiver Organisationsadmin am Standort sein.');
    const runtime = (p, o) => cxt.runtimeApi.runtime(cxt.runtimeBase, p, o), search = (p, filter) => runtimeSearch(cxt.runtimeApi, cxt.runtimeBase, p, filter);
    for (const role of ['studierende', 'admin', 'connectors', 'app-integrations']) await runtime('/v2/roles/' + role);
    const [workspaces, tenants, groups, roleGroups] = await Promise.all([searchAll(api, '/workspaces/search'), search('/v2/tenants/search'), search('/v2/groups/search'), search('/v2/roles/studierende/groups/search')]);
    for (const tenant of tenants) if ((await search('/v2/tenants/' + encodeURIComponent(tenant.tenantId) + '/roles/search')).some(r => r.roleId === 'studierende')) throw new Error('Gemeinsame Studierendenrolle ist einem Tenant zugeordnet. Gruppenisolation zuerst korrigieren.');
    const protectedUsers = new Set(cxt.protectedEmails);
    for (const student of c.groups.flatMap(g => g.students)) {
      const member = members.find(m => emailOf(m) === student.email);
      if (protectedUsers.has(student.email) || member?.roles?.some(r => !['member', 'modeler'].includes(r))) throw new Error('Studierendenliste enthält ein privilegiertes Konto. Keine Änderungen.');
    }
    const resources = [];
    for (const g of c.groups) {
      const workspace = g.workspaceKey ? workspaces.find(w => w.workspaceKey === g.workspaceKey) || null : null;
      if (!g.workspaceKey && workspaces.some(w => w.name === g.workspaceName)) throw new Error('Gleichnamiger Workspace ohne Klassenzuordnung. Keine automatische Übernahme.');
      const tenant = tenants.find(t => t.tenantId === g.tenantId) || null, group = groups.find(x => x.groupId === g.runtimeGroupId) || null;
      if ((tenant && tenant.description !== this.marker(c, g)) || (group && group.description !== this.marker(c, g))) throw new Error('Tenant-/Gruppen-ID ist anders belegt.');
      const wm = workspace ? await searchAll(api, '/members/search', { workspaceKey: { $eq: workspace.workspaceKey } }) : [];
      const environments = workspace ? (await api.hub('/workspaces/' + encodeURIComponent(workspace.workspaceKey) + '/environments')).items : [];
      if (!Array.isArray(environments)) throw new Error('Environment-Zuordnung unvollständig.');
      const tm = { users: [], groups: [], roles: [], clients: [], 'mapping-rules': [] };
      if (tenant) for (const type of Object.keys(tm)) tm[type] = await search('/v2/tenants/' + encodeURIComponent(g.tenantId) + '/' + type + '/search');
      const gu = group ? await search('/v2/groups/' + encodeURIComponent(g.runtimeGroupId) + '/users/search') : [];
      const gr = group ? await search('/v2/groups/' + encodeURIComponent(g.runtimeGroupId) + '/roles/search') : [];
      const grants = await search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: g.runtimeGroupId });
      if (gr.some(r => r.roleId !== 'studierende') || grants.some(a => a.ownerType !== 'GROUP' || a.ownerId !== g.runtimeGroupId || a.resourcePropertyName || a.resourceType !== 'TENANT' || a.resourceId !== g.tenantId || a.permissionTypes?.some(p => p !== 'READ')) || tm.groups.some(x => x.groupId !== g.runtimeGroupId) || tm.roles.some(r => !['admin', 'connectors', 'app-integrations'].includes(r.roleId)) || tm['mapping-rules'].length || tm.clients.some(x => x.clientId !== cxt.runtimeClientId) || tm.users.some(u => emailOf(u) !== c.lecturerEmail && !g.students.some(s => s.email === emailOf(u)))) throw new Error('Klassengruppe hat weitere Zugriffe. Bitte manuell prüfen.');
      if (gu.some(u => !g.students.some(s => s.email === emailOf(u)) && !(c.pendingMove && emailOf(u) === c.pendingMove.email && [c.pendingMove.from, c.pendingMove.to].includes(g.id)))) throw new Error('Runtime-Gruppe hat nicht zugeordnete Mitglieder.');
      resources.push({ groupId: g.id, workspace, tenant, group, wm, environments, tm, gu, gr, grants });
    }
    return { cxt, api, runtime, search, members, roleGroups, resources, fingerprint: digest({ contextRevision: cxt.revision, members, roleGroups, resources, revision: c.revision }) };
  }
  async provisionPreview(id) {
    const c = this.get(id); if (c.pendingMove || c.uncertainCreate) throw new CleanupError('Vorherige Klassenänderung muss zuerst geprüft bzw. fortgesetzt werden.');
    const s = await this.inspect(c);
    const invitations = c.groups.flatMap(g => g.students).filter(u => !c.invitationAttempts?.[u.email] && !s.members.some(m => emailOf(m) === u.email)).map(s => s.email);
    const previewId = this.remember({ type: 'provision', classId: id, revision: c.revision, fingerprint: s.fingerprint });
    return { previewId, groups: c.groups.map(g => ({ name: g.workspaceName, students: g.students.length, adminEmail: c.lecturerEmail })), invitations, changes: ['Pro Gruppe Workspace, Tenant und Runtime-Gruppe anlegen bzw. bestätigte Bestandteile wiederverwenden.', 'Dozent ' + c.lecturerEmail + ' als Workspace-Admin jeder Gruppe eintragen und diese Zuordnung nachprüfen.', 'Nur die eigene Gruppen-TENANT-READ-Freigabe und die gemeinsame funktionale Studierendenrolle zuweisen.', 'Fehlende Organisationsmitglieder einladen und Workspace-Zugriffe bereits vorbereiten. Verfügbare Runtime-Konten sofort zuweisen. Ausstehende Benutzerzuweisungen im laufenden Dienst automatisch vervollständigen; keine erneuten Organisationseinladungen.'], appliedToCamunda: false };
  }
  async movePreview(classId, email, targetId) {
    const c = this.get(classId), from = c.groups.find(g => g.students.some(s => s.email === email)), to = c.groups.find(g => g.id === targetId);
    if (c.uncertainCreate) throw new CleanupError('Unbestätigte Ressourcenanlage zuerst manuell prüfen.');
    if (!from || !to || from.id === to.id) throw new CleanupError('Gültige Ausgangs- und Zielgruppe auswählen.', 400);
    if (c.pendingMove && (c.pendingMove.email !== email || c.pendingMove.to !== targetId)) throw new CleanupError('Zuerst den offenen Gruppenwechsel fortsetzen.');
    let snapshot = null;
    if (c.status !== 'draft') {
      const s = await this.inspect(c); const a = s.resources.find(r => r.groupId === from.id), b = s.resources.find(r => r.groupId === to.id);
      if (!a.workspace || !b.workspace || !a.tenant || !b.tenant || !a.group || !b.group || !a.gr.some(r => r.roleId === 'studierende') || !b.gr.some(r => r.roleId === 'studierende')) throw new Error('Beide Gruppen zuerst vollständig einrichten.');
      const member = s.members.find(m => emailOf(m) === email);
      if (!member || member.invitePending) throw new Error('Einladung muss vor dem Rechtewechsel angenommen sein.');
      const access = await analyzeCleanup(s.cxt), person = access.people.find(p => p.email === email);
      if (!access.runtime.available || !person || person.classification === 'protected') throw new Error('Effektive Runtime-Rollen nicht vollständig prüfbar oder privilegiertes Konto.');
      for (const r of [a, b]) if (r.wm.some(m => emailOf(m) === email && m.role !== 'editor')) throw new Error('Unerwartete Workspace-Rolle; keine automatische Änderung.');
      const direct = await s.search('/v2/authorizations/search', { ownerType: 'USER', ownerId: email });
      if (direct.some(g => g.resourceType === 'TENANT' && ['*', from.tenantId].includes(g.resourceId))) throw new Error('Direkte zusätzliche Tenant-Freigaben müssen vor dem Gruppenwechsel manuell bereinigt werden.');
      const allTenants = await s.search('/v2/tenants/search');
      for (const t of allTenants) {
        const roles = await s.search('/v2/tenants/' + encodeURIComponent(t.tenantId) + '/roles/search');
        if (roles.some(r => r.roleId === 'studierende')) throw new Error('Gemeinsame Studierendenrolle ist einem Tenant zugeordnet; Gruppenisolation erst korrigieren.');
      }
      snapshot = s.fingerprint;
    }
    const previewId = this.remember({ type: 'move', classId, email, from: from.id, to: to.id, revision: c.revision, fingerprint: snapshot });
    return { previewId, email, from: from.name, to: to.name, localOnly: c.status === 'draft', changes: c.status === 'draft' ? ['Gruppenzuordnung nur im lokalen Entwurf ändern.'] : ['Bisherige Runtime-Gruppen-/Workspace-Zuweisung und direkte Zuordnung zum bisherigen Gruppen-Tenant entfernen.', 'Zugriff als Editor auf den Ziel-Workspace und Mitgliedschaft in der Ziel-Runtime-Gruppe zuweisen.', 'Die eigene Tenant-Lesefreigabe wird über die Zielgruppe geerbt. Zugehörigkeiten zu anderen Klassen bleiben erhalten.', 'Bestehende Instanzen und Aufgaben verbleiben im bisherigen Tenant; sie werden nicht verschoben.'], appliedToCamunda: false };
  }
  async withRun(plan, action) {
    if (this.busy || this.cleanup.busy.has(this.get(plan.classId).site)) throw new CleanupError('Klassen-/Standortverwaltung läuft bereits.');
    this.busy = true; let fd, siteFd; const lock = path.join(this.root, 'classes-lock.local.json'); let c = this.get(plan.classId), data;
    const contextRevision = this.contextForSite(c.site).revision;
    const siteLock = path.join(this.root, 'cleanup-lock-' + c.site + '.local.json'), results = [], reportFile = path.join(this.root, 'class-action-' + plan.id + '.local.json'); let inFlight;
    const progress = message => this.cleanup.reportProgress(c.site, { message, completed: results.length });
    const save = () => { c.revision = crypto.randomUUID(); data.classes = data.classes.map(x => x.id === c.id ? c : x); this.save(data); };
    const report = status => fs.writeFileSync(reportFile, JSON.stringify({ classId: c.id, status, type: plan.type, inFlight, results, checkedAt: new Date().toISOString() }, null, 2));
    const verify = read => this.cleanup.verifyAbsent(read, { onWait: (elapsed, limit) => progress('Auf Bestätigung der Klassenrechte warten (' + Math.round(elapsed / 1000) + ' / ' + limit / 1000 + ' s) …') });
    const write = async (label, call) => { if (this.contextForSite(c.site).revision !== contextRevision) throw new Error('Standortkonfiguration wurde während der Änderung bearbeitet.'); progress(label); inFlight = label; report('running'); const value = await call(); results.push(label); inFlight = undefined; report('running'); return value; };
    try {
      fd = fs.openSync(lock, 'wx', 0o600); siteFd = fs.openSync(siteLock, 'wx', 0o600); this.cleanup.busy.add(c.site);
      data = this.load(); c = data.classes.find(x => x.id === plan.classId);
      if (this.get(c.id).revision !== plan.revision) throw new Error('Klasse wurde seit der Vorschau geändert.');
      this.cleanup.reportProgress(c.site, { runId: plan.id, phase: 'running', message: 'Klassenänderung erneut prüfen …', completed: 0, total: 0 });
      await action({ c, save, report, progress, write, verify });
      inFlight = undefined; report('completed'); this.cleanup.reportProgress(c.site, { phase: 'completed', message: 'Klassenänderung bestätigt.', completed: results.length });
      return { status: 'completed', classroom: c, results };
    } catch (error) {
      if (inFlight && plan.type === 'provision') { c.status = 'attention'; if (/anlegen/.test(inFlight)) c.uncertainCreate = inFlight; save(); }
      report('incomplete'); this.cleanup.reportProgress(c.site, { phase: 'stopped', message: 'Klassenänderung gestoppt. Ergebnis prüfen.' });
      return { status: 'incomplete', error: error.message, results, classroom: c, note: 'Teiländerungen möglich. Keine automatische Schreibwiederholung.' };
    } finally { if (siteFd !== undefined) { fs.closeSync(siteFd); fs.unlinkSync(siteLock); this.cleanup.busy.delete(c.site); } if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } this.busy = false; }
  }
  async provision(id, acknowledged) {
    const p = this.plan(id, 'provision', acknowledged); p.used = true;
    return this.withRun(p, async ({ c, save, write, verify }) => {
      const s = await this.inspect(c); if (s.fingerprint !== p.fingerprint) throw new Error('Camunda-Bestand wurde seit der Vorschau geändert.');
      const segment = encodeURIComponent;
      const assign = async (label, endpoint, check) => { if (!await check()) await write(label, async () => { await s.runtime(endpoint, { method: 'PUT' }); if (!await verify(check)) throw new Error(label + ' noch nicht bestätigt.'); }); };
      const workspaceMember = async (g, email, role) => {
        const path = '/workspaces/' + segment(g.workspaceKey) + '/members';
        const exists = async () => (await searchAll(s.api, '/members/search', { workspaceKey: { $eq: g.workspaceKey } })).find(m => emailOf(m) === email);
        const current = await exists(); if (current) { if (current.role !== role) throw new Error('Workspace-Rolle weicht ab.'); return; }
        await write('Workspace-Zugriff zuweisen', async () => {
          try { await s.api.hub(path, { method: 'POST', body: { email, role } }); }
          catch (error) { if (error.status !== 400) throw error; if (!await exists()) await s.api.request('https://hub.camunda.io', '/api/v1/collaborators', { method: 'PUT', body: { email, projectId: g.workspaceKey, role: role === 'workspace_admin' ? 'project_admin' : 'editor' } }); }
          if (!await verify(async () => (await exists())?.role === role)) throw new Error('Workspace-Zuweisung nicht bestätigt.');
        });
      };
      for (const g of c.groups) {
        const old = s.resources.find(r => r.groupId === g.id);
        if (!old.workspace) {
          const w = await write('Gruppen-Workspace anlegen', () => s.api.hub('/workspaces', { method: 'POST', body: { name: g.workspaceName } }));
          if (!w?.workspaceKey) throw new Error('Workspace-Anlage nicht eindeutig bestätigt.'); g.workspaceKey = w.workspaceKey; save();
        }
        await workspaceMember(g, c.lecturerEmail, 'workspace_admin');
        if (!old.environments.some(e => e.id === s.cxt.environmentId)) await write('Gruppen-Environment verbinden', () => s.api.hub('/workspaces/' + segment(g.workspaceKey) + '/environments', { method: 'PUT', body: { environmentIds: [...new Set([...old.environments.map(e => e.id), s.cxt.environmentId])] } }));
        const tb = '/v2/tenants/' + segment(g.tenantId), gb = '/v2/groups/' + segment(g.runtimeGroupId);
        if (!old.tenant) await write('Gruppen-Tenant anlegen', () => s.runtime('/v2/tenants', { method: 'POST', body: { tenantId: g.tenantId, name: g.workspaceName, description: this.marker(c, g) } }));
        if (!old.group) await write('Runtime-Gruppe anlegen', () => s.runtime('/v2/groups', { method: 'POST', body: { groupId: g.runtimeGroupId, name: g.workspaceName, description: this.marker(c, g) } }));
        await assign('Technischen Tenant-Zugriff sichern', tb + '/clients/' + segment(s.cxt.runtimeClientId), async () => (await s.search(tb + '/clients/search')).some(x => x.clientId === s.cxt.runtimeClientId));
        for (const role of ['admin', 'connectors', 'app-integrations']) await assign('Admin-/Technikzugriff zuweisen', tb + '/roles/' + role, async () => (await s.search(tb + '/roles/search')).some(r => r.roleId === role));
        await assign('Runtime-Gruppe ihrem Tenant zuweisen', tb + '/groups/' + segment(g.runtimeGroupId), async () => (await s.search(tb + '/groups/search')).some(x => x.groupId === g.runtimeGroupId));
        await assign('Studierendenrolle der Gruppe zuweisen', '/v2/roles/studierende/groups/' + segment(g.runtimeGroupId), async () => (await s.search('/v2/roles/studierende/groups/search')).some(x => x.groupId === g.runtimeGroupId));
        const grants = await s.search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: g.runtimeGroupId });
        if (!grants.some(a => a.resourceType === 'TENANT' && a.resourceId === g.tenantId && a.permissionTypes?.includes('READ'))) await write('Eigenes Tenant-Leserecht für Gruppe zuweisen', async () => {
          await s.runtime('/v2/authorizations', { method: 'POST', body: { ownerType: 'GROUP', ownerId: g.runtimeGroupId, resourceType: 'TENANT', resourceId: g.tenantId, permissionTypes: ['READ'] } });
          if (!await verify(async () => (await s.search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: g.runtimeGroupId })).some(a => a.resourceType === 'TENANT' && a.resourceId === g.tenantId && a.permissionTypes.includes('READ')))) throw new Error('Tenant-Leserecht nicht bestätigt.');
        });
        for (const student of g.students) {
          let member = (await s.api.console('/members')).find(m => emailOf(m) === student.email);
          if (member?.roles?.some(r => !['member', 'modeler'].includes(r)) || s.cxt.protectedEmails.includes(student.email)) throw new Error('Studierendenkonto erhielt weitere Rechte. Zuweisung gestoppt.');
          if (!member && !c.invitationAttempts?.[student.email]) {
            c.invitationAttempts ||= {}; c.invitationAttempts[student.email] = { submittedAt: new Date().toISOString(), status: 'reserved' }; save();
            await write('Studierendenkonto einladen', () => s.api.console('/members/' + segment(student.email), { method: 'POST', body: { orgRoles: ['modeler'] } })); c.invitationAttempts[student.email].status = 'submitted'; save();
            member = (await s.api.console('/members')).find(m => emailOf(m) === student.email);
          }
        }
      }
      if (!await verify(async () => {
        const current = await this.inspect(c);
        return current.resources.every(r => r.workspace && r.tenant && r.group && r.wm.some(m => emailOf(m) === c.lecturerEmail && m.role === 'workspace_admin') && r.environments.some(e => e.id === s.cxt.environmentId) && r.tm.groups.some(g => g.groupId === r.group.groupId) && r.tm.clients.some(a => a.clientId === s.cxt.runtimeClientId) && ['admin', 'connectors', 'app-integrations'].every(id => r.tm.roles.some(role => role.roleId === id)) && r.gr.some(role => role.roleId === 'studierende'));
      })) throw new Error('Klassenstruktur noch nicht vollständig nachgeprüft.');
      const accessState = await this.inspect(c); this.access.assertStructure(c, accessState);
      c.pendingStudents = await this.access.sync(c, accessState, save, { initial: true, write });
      c.status = c.pendingStudents.length ? 'pending' : 'ready';
      c.autoAccess = this.access.authorize(c, accessState.cxt); save();
    });
  }
  async move(id, acknowledged) {
    const p = this.plan(id, 'move', acknowledged); p.used = true;
    return this.withRun(p, async ({ c, save, write, verify }) => {
      const from = c.groups.find(g => g.id === p.from), to = c.groups.find(g => g.id === p.to), student = from.students.find(u => u.email === p.email);
      if (!student) throw new Error('Ausgangszuordnung wurde geändert.');
      if (c.status !== 'draft') {
        const s = await this.inspect(c); if (s.fingerprint !== p.fingerprint) throw new Error('Camunda-Rechte wurden seit der Vorschau geändert.');
        c.pendingMove = { email: p.email, from: p.from, to: p.to }; save();
        const seg = encodeURIComponent, source = s.resources.find(r => r.groupId === from.id), target = s.resources.find(r => r.groupId === to.id);
        const gu = async g => (await s.search('/v2/groups/' + seg(g.runtimeGroupId) + '/users/search')).some(u => emailOf(u) === p.email);
        const wm = async g => (await searchAll(s.api, '/members/search', { workspaceKey: { $eq: g.workspaceKey } })).find(m => emailOf(m) === p.email);
        if (await gu(from)) await write('Bisherige Runtime-Gruppenrechte entziehen', async () => { await s.runtime('/v2/groups/' + seg(from.runtimeGroupId) + '/users/' + seg(p.email), { method: 'DELETE' }); if (!await verify(async () => !await gu(from))) throw new Error('Bisherige Runtime-Gruppenrechte noch sichtbar.'); });
        if (await wm(from)) await write('Bisherigen Workspace-Zugriff entfernen', async () => { await s.api.hub('/workspaces/' + seg(from.workspaceKey) + '/members/' + seg(p.email), { method: 'DELETE' }); if (!await verify(async () => !await wm(from))) throw new Error('Bisheriger Workspace-Zugriff noch sichtbar.'); });
        if (source.tm.users.some(u => emailOf(u) === p.email)) await write('Direkte alte Tenant-Zuordnung entfernen', async () => { const tb = '/v2/tenants/' + seg(from.tenantId) + '/users'; await s.runtime(tb + '/' + seg(p.email), { method: 'DELETE' }); if (!await verify(async () => !(await s.search(tb + '/search')).some(u => emailOf(u) === p.email))) throw new Error('Direkte alte Tenant-Zuordnung noch sichtbar.'); });
        if (!await wm(to)) await write('Ziel-Workspace als Editor freigeben', async () => {
          try { await s.api.hub('/workspaces/' + seg(to.workspaceKey) + '/members', { method: 'POST', body: { email: p.email, role: 'editor' } }); }
          catch (error) { if (error.status !== 400) throw error; if (!await wm(to)) await s.api.request('https://hub.camunda.io', '/api/v1/collaborators', { method: 'PUT', body: { email: p.email, projectId: to.workspaceKey, role: 'editor' } }); }
          if (!await verify(async () => (await wm(to))?.role === 'editor')) throw new Error('Ziel-Workspace-Zugriff nicht bestätigt.');
        });
        if (!await gu(to)) await write('Ziel-Runtime-Gruppe zuweisen', async () => { await s.runtime('/v2/groups/' + seg(to.runtimeGroupId) + '/users/' + seg(p.email), { method: 'PUT' }); if (!await verify(() => gu(to))) throw new Error('Ziel-Runtime-Gruppe nicht bestätigt.'); });
        if (await gu(from) || await wm(from) || !await gu(to) || (await wm(to))?.role !== 'editor') throw new Error('Abschlussprüfung des Gruppenwechsels fehlgeschlagen.');
      }
      from.students = from.students.filter(u => u.email !== p.email); to.students.push(student); delete c.pendingMove; c.pendingStudents = c.pendingStudents?.filter(u => u.email !== p.email);
      if (c.status !== 'draft') c.status = c.pendingStudents?.length ? 'pending' : 'ready';
      if (c.autoAccess?.enabled) c.autoAccess = this.access.authorize(c, this.contextForSite(c.site));
      save();
    });
  }
}
module.exports = { Classroom, DAYS };
