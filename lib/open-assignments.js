const dataStore = require('./state-store');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { searchAll } = require('./onboarding');
const { runtimeSearch } = require('./tenancy');
const { SITE_IDS } = require('./admin-config');
const emailOf = person => String(person.email || person.username || '').toLowerCase();
const fingerprint = c => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
const unknown = (label, error) => {
  const reasons = { 429: 'Camunda begrenzt derzeit die Anfragen (HTTP 429). Bitte später erneut live prüfen.', 503: 'Die Camunda-Runtime ist derzeit nicht verfügbar (HTTP 503); Clusterzustand prüfen.', 401: 'Die Authentifizierung des Dienstkontos wurde abgelehnt (HTTP 401).', 403: 'Dem Dienstkonto fehlt der Zugriff auf diese Abfrage (HTTP 403).' };
  return { state: 'unknown', detail: label + ' konnte nicht geprüft werden.' + (reasons[error?.status] ? ' ' + reasons[error.status] : error ? ' Verbindung oder API-Antwort nicht verfügbar; erneut live prüfen.' : '') };
};
const state = (value, detail = '') => ({ state: value, detail });

class OpenAssignments {
  constructor({ root, classroom, contextForSite, now = Date.now }) {
    this.file = path.join(root, 'assignment-status.local.json'); this.classroom = classroom; this.contextForSite = contextForSite; this.now = now; this.running = null;
  }
  load() { if (!dataStore.exists(this.file)) return { classes: {} }; const saved = dataStore.readJson(this.file); if (!saved.classes || typeof saved.classes !== 'object') throw new Error('Gespeicherter Zuweisungsstand ist ungültig.'); return saved; }
  save(saved) { dataStore.writeJson(this.file, saved); }
  select(filters = {}) {
    if (filters.site && !SITE_IDS.includes(filters.site)) throw new Error('Ungültiger Standort.');
    return this.classroom.load().classes.filter(c => (c.status !== 'cleaned' || filters.includeCleaned === '1') && (!filters.site || c.site === filters.site) && (!filters.lecturerEmail || c.lecturerEmail === filters.lecturerEmail) && (!filters.day || c.day === filters.day));
  }
  local(c) {
    return { id: c.id, site: c.site, lecturerEmail: c.lecturerEmail, lecturerName: c.lecturerName, day: c.day, classStatus: c.status,
      automatic: { enabled: Boolean(c.autoAccess?.enabled), status: c.autoAccess?.status || 'not_configured', workspaceCheckAt: c.autoAccess?.workspaceCheckAt || null, runtimePending: Boolean(c.autoAccess?.runtimePending), lastCheckAt: c.autoAccess?.lastCheckAt || null, lastError: c.autoAccess?.lastError || null, nextCheckAt: c.autoAccess?.nextCheckAt ? new Date(c.autoAccess.nextCheckAt).toISOString() : null },
      issues: [...(c.status === 'cleaned' ? ['Klasse im Cleanup vollständig bereinigt. Zum erneuten Einladen die Excel-Liste als neuen Entwurf importieren.'] : []), ...(c.cleanupState && c.status !== 'cleaned' ? ['Bestätigte Löschung erkannt. Die Automatik bleibt deaktiviert; verbleibende Klassenressourcen prüfen.'] : []), ...(c.status === 'draft' ? ['Klasse ist ein Entwurf; Einrichtung noch bestätigen.'] : []), ...(c.pendingMove ? ['Gruppenwechsel für ' + c.pendingMove.email + ' muss abgeschlossen werden.'] : []), ...(c.uncertainCreate ? ['Ressourcenanlage unbestätigt; Bestand manuell prüfen.'] : []), ...(c.autoAccess?.status === 'stopped' ? ['Automatische Zuweisung angehalten; Klassenrechte zuerst prüfen.'] : []), ...(c.status === 'pending' && !c.autoAccess?.enabled ? ['Automatische Zuweisung ist pausiert oder nicht eingerichtet.'] : []), ...(c.status === 'attention' ? ['Klassenänderung wurde nicht vollständig abgeschlossen.'] : [])],
      checkedAt: null, cleanupAt: c.cleanupState?.checkedAt || null, groups: c.groups.map(g => ({ id: g.id, name: g.name, workspaceName: g.workspaceName, students: g.students.map(s => ({ name: s.name, email: s.email,
        organization: unknown('Organisationseinladung'), workspace: unknown('Workspace-Zugriff'), runtime: unknown('Runtime-Zuordnung'), rights: unknown('Gruppenrechte'),
        removed: Boolean(c.cleanupState?.students.includes(s.email)), savedReason: (c.pendingStudents || []).find(p => p.email === s.email)?.reason || '', ready: false })) })) };
  }
  effective(result) {
    for (const row of result.groups.flatMap(g => g.students)) if (row.removed) for (const key of ['organization', 'workspace', 'runtime', 'rights']) row[key] = state('removed', 'Das Konto wurde laut bestätigtem Cleanup-Beleg entfernt; keine offene Einladung.');
    const active = result.groups.flatMap(g => g.students).filter(p => !p.removed);
    if (result.classStatus === 'cleaned') result.automatic.status = 'cleanup';
    else if (result.automatic.status === 'completed' && active.some(p => !p.ready)) {
      result.automatic.status = 'needs_review';
      result.issues.push(result.checkedAt ? 'Der aktuelle Bestand weicht vom früheren Einrichtungsabschluss ab. Fehlende Zugriffe werden nicht automatisch wiederhergestellt.' : 'Der frühere Einrichtungsabschluss ist noch nicht durch eine aktuelle Live-Prüfung bestätigt.');
    }
    return result;
  }
  async inspect(c, organization) {
    const result = this.local(c), seg = encodeURIComponent;
    result.checkedAt = new Date(this.now()).toISOString();
    if (c.status === 'cleaned') return result;
    if (!organization.ok) result.issues.push('Organisationszugang nicht prüfbar. Der Status bleibt unbekannt.');
    for (let index = 0; index < c.groups.length; index++) {
      const group = c.groups[index], rows = result.groups[index].students;
      for (const row of rows) if (organization.ok) {
        const member = organization.members.find(m => emailOf(m) === row.email);
        row.organization = !member ? state('missing', 'Keine sichtbare Organisationsmitgliedschaft; bei bereits versendeter Einladung den Beleg prüfen.') : member.roles?.some(r => !['member', 'modeler'].includes(r)) ? state('review', 'Konto hat zusätzliche Organisationsrollen; automatische Zuweisung prüfen.') : member.invitePending ? state('pending', 'Organisationseinladung noch nicht angenommen.') : state('ready', 'Organisationseinladung angenommen / aktives Mitglied.');
      }
      if (c.status === 'draft') {
        for (const row of rows) for (const kind of ['workspace', 'runtime', 'rights']) row[kind] = state('not_prepared', 'Klasse zuerst in Camunda einrichten.');
        continue;
      }
      let ctx; try { ctx = this.contextForSite(c.site); } catch { result.issues.push('Standortkonfiguration nicht lesbar.'); continue; }
      const search = (p, filter) => runtimeSearch(ctx.runtimeApi, ctx.runtimeBase, p, filter);
      const reads = await Promise.allSettled([
        group.workspaceKey && organization.ok ? searchAll(ctx.organizationApi, '/members/search', { workspaceKey: { $eq: group.workspaceKey } }) : Promise.reject(new Error()),
        search('/v2/groups/' + seg(group.runtimeGroupId) + '/users/search'),
        Promise.all([search('/v2/groups/' + seg(group.runtimeGroupId) + '/roles/search'), search('/v2/tenants/' + seg(group.tenantId) + '/groups/search'), search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: group.runtimeGroupId })]),
      ]);
      for (const row of rows) {
        if (!group.workspaceKey) row.workspace = state('missing', 'Klasse hat noch keinen bestätigten Workspace.');
        else if (reads[0].status === 'fulfilled') { const m = reads[0].value.find(p => emailOf(p) === row.email); row.workspace = !m ? state('missing', 'Workspace-Mitgliedschaft fehlt.') : m.role !== 'editor' ? state('review', 'Workspace-Rolle weicht von Editor ab; manuell prüfen.') : m.invitePending ? state('pending', 'Workspace-Einladung noch offen.') : state('ready'); }
        else row.workspace = unknown('Workspace-Zugriff', reads[0].reason);
        if (reads[1].status === 'fulfilled') row.runtime = state(reads[1].value.some(p => emailOf(p) === row.email) ? 'ready' : 'missing', 'Mitgliedschaft in der vorgesehenen Runtime-Gruppe.');
        else if (reads[1].reason?.status === 404) row.runtime = state('missing', 'Runtime-Gruppe nicht gefunden.');
        else row.runtime = unknown('Runtime-Zuordnung', reads[1].reason);
        if (reads[2].status === 'fulfilled') {
          const [roles, tenants, grants] = reads[2].value;
          const own = grants.some(a => a.ownerType === 'GROUP' && a.ownerId === group.runtimeGroupId && a.resourceType === 'TENANT' && a.resourceId === group.tenantId && a.permissionTypes?.includes('READ'));
          const foreign = roles.some(r => r.roleId !== 'studierende') || grants.some(a => a.ownerType !== 'GROUP' || a.ownerId !== group.runtimeGroupId || a.resourcePropertyName || a.resourceType !== 'TENANT' || a.resourceId !== group.tenantId || a.permissionTypes?.some(p => p !== 'READ'));
          row.rights = state(foreign ? 'review' : roles.some(r => r.roleId === 'studierende') && tenants.some(g => g.groupId === group.runtimeGroupId) && own ? 'ready' : 'missing', foreign ? 'Zusätzliche Tenant-Freigaben gefunden; manuell prüfen.' : 'Studierendenrolle, eigene Tenant-Mitgliedschaft und TENANT READ der Gruppe.');
        } else if (reads[2].reason?.status === 404) row.rights = state('missing', 'Gruppe oder Tenant nicht gefunden.');
        else row.rights = unknown('Gruppenrechte', reads[2].reason);
        row.ready = ['organization', 'workspace', 'runtime', 'rights'].every(key => row[key].state === 'ready');
      }
    }
    return result;
  }
  async get(filters = {}, refresh = false) {
    if (refresh && this.running) { await this.running; return this.get(filters, true); }
    if (!refresh) return this.snapshot(filters);
    this.running = this.refresh(filters);
    try { await this.running; return this.snapshot(filters); } finally { this.running = null; }
  }
  async refresh(filters) {
    const classes = this.select(filters), saved = this.load();
    const organizations = new Map();
    for (const site of [...new Set(classes.map(c => c.site))]) {
      try { const ctx = this.contextForSite(site); if ((await ctx.organizationApi.hub('/info')).authorizedOrganization !== ctx.expectedOrganization) throw new Error(); const members = await ctx.organizationApi.console('/members'); if (!Array.isArray(members)) throw new Error(); organizations.set(site, { ok: true, members }); }
      catch { organizations.set(site, { ok: false }); }
    }
    for (const c of classes) saved.classes[c.id] = { fingerprint: fingerprint(c), result: await this.inspect(c, organizations.get(c.site)) };
    // No membership writes, invitations or access-worker calls are allowed here.
    this.save(saved);
  }
  snapshot(filters) {
    const saved = this.load(), classes = this.select(filters).map(c => this.effective(saved.classes[c.id]?.fingerprint === fingerprint(c) ? saved.classes[c.id].result : this.local(c)));
    const people = classes.flatMap(c => c.groups.flatMap(g => g.students)).filter(p => !p.removed);
    return { classes, summary: { classes: classes.length, students: people.length, ready: people.filter(p => p.ready).length,
      invitations: people.filter(p => p.organization.state === 'pending' || p.workspace.state === 'pending').length,
      assignments: people.filter(p => ['organization', 'workspace', 'runtime', 'rights'].some(k => p[k].state === 'missing')).length,
      unknown: people.filter(p => ['organization', 'workspace', 'runtime', 'rights'].some(k => p[k].state === 'unknown')).length,
      issues: classes.reduce((n, c) => n + c.issues.length, 0), cleaned: this.select({ ...filters, includeCleaned: '1' }).filter(c => c.status === 'cleaned').length }, checkedAt: new Date(this.now()).toISOString(), readOnly: true };
  }
}
module.exports = { OpenAssignments };
