const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadAdminConfig, saveAdminConfig, SITE_IDS } = require('./admin-config');
const { searchAll } = require('./onboarding');
const { runtimeSearch } = require('./tenancy');
const { Cleanup, CleanupError } = require('./cleanup');
const { analyzeCleanup } = require('./cleanup-analysis');
const { inspectRuntime, requiredGrants, purgeTenant, has, absent, assertTenantsEmpty } = require('./cleanup-runtime');

const canonical = value => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(k => k !== 'checkedAt').map(k => [k, canonical(value[k])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => hash(a) === hash(b);
const support = ['admin', 'connectors', 'app-integrations'];
const emailOf = m => String(m.email || m.username || '').toLowerCase();
function targetFor(person, organizationId) {
  const name = person.name.trim() || person.email.split('@')[0];
  return { workspaceName: name + '_Private_Workspace', tenantName: name + '_Private_Tenant', tenantId: 'dozent-' + hash(person.email).slice(0, 20), marker: 'CamundaCleanup private lecturer: ' + person.email + '; organization: ' + organizationId };
}

class LecturerResources {
  constructor({ root, contextForSite, cleanup, now = Date.now, wait }) {
    this.root = root; this.contextForSite = contextForSite; this.cleanup = cleanup || new Cleanup({ root, contextForSite, ...(wait ? { wait } : {}) }); this.now = now;
    this.registryFile = path.join(root, 'lecturer-resources.local.json'); this.configFile = path.join(root, 'admin-config.json'); this.plans = new Map(); this.busy = false;
  }
  registry() {
    if (!fs.existsSync(this.registryFile)) return { schemaVersion: 1, entries: {} };
    const data = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    if (data.schemaVersion !== 1 || !data.entries || typeof data.entries !== 'object') throw new CleanupError('Dozenten-Ressourcenzuordnung ist ungültig.');
    return data;
  }
  saveRegistry(data) { const tmp = this.registryFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, this.registryFile); }
  subject(site, email) {
    const loaded = loadAdminConfig(this.configFile);
    if (!SITE_IDS.includes(site) || typeof email !== 'string') throw new CleanupError('Unbekannter Standort oder Dozent.', 400);
    const owner = loaded.config.protectedOwners.find(p => p.email === email);
    const person = owner || loaded.config.lecturers.find(p => p.email === email);
    if (!person) throw new CleanupError('Dozent ist nicht konfiguriert.');
    return { ...loaded, person, protectedOwner: Boolean(owner) };
  }
  async read(site, email, context) {
    const loaded = this.subject(site, email), c = context || this.contextForSite(site), api = c.organizationApi;
    if ((await api.hub('/info')).authorizedOrganization !== loaded.config.organizations[site]) throw new CleanupError('Organisation stimmt nicht überein.');
    const member = (await api.console('/members')).find(m => emailOf(m) === email) || null;
    if (member?.roles?.includes('owner') && !loaded.protectedOwner) throw new CleanupError('Owner ist geschützt.');
    const target = targetFor(loaded.person, c.expectedOrganization), registry = this.registry(), saved = registry.entries[site + '/' + email] || null;
    if (saved && (saved.organizationId !== c.expectedOrganization || saved.runtimeBase !== c.runtimeBase || saved.tenantId !== target.tenantId)) throw new CleanupError('Gespeicherte Ressourcenzuordnung passt nicht zum Standort.');
    const workspaces = await searchAll(api, '/workspaces/search'), tenants = await runtimeSearch(c.runtimeApi, c.runtimeBase, '/v2/tenants/search');
    const workspace = saved?.workspaceKey ? workspaces.find(w => w.workspaceKey === saved.workspaceKey) || null : null;
    const tenant = tenants.find(t => t.tenantId === target.tenantId) || null;
    if (tenant && (!saved || tenant.description !== target.marker)) throw new CleanupError('Tenant ist nicht als eigene Dozentenressource bestätigt. Keine automatische Übernahme.');
    if (!saved?.workspaceKey && workspaces.some(w => w.name === target.workspaceName)) throw new CleanupError('Gleichnamiger Workspace ohne bestätigte Zuordnung; bitte manuell prüfen.');
    let workspaceMembers = [], projects = [], environments = [], tenantMembers = { groups: [], users: [], roles: [], clients: [], 'mapping-rules': [] };
    if (workspace) {
      [workspaceMembers, projects, environments] = await Promise.all([
        searchAll(api, '/members/search', { workspaceKey: { $eq: workspace.workspaceKey } }), searchAll(api, '/projects/search', { workspaceKey: { $eq: workspace.workspaceKey } }),
        api.hub('/workspaces/' + encodeURIComponent(workspace.workspaceKey) + '/environments').then(r => r.items),
      ]);
      if (!Array.isArray(environments)) throw new Error('Workspace-Environments sind nicht lesbar.');
    }
    if (tenant) for (const type of Object.keys(tenantMembers)) tenantMembers[type] = await runtimeSearch(c.runtimeApi, c.runtimeBase, '/v2/tenants/' + encodeURIComponent(tenant.tenantId) + '/' + type + '/search');
    const authorizations = await runtimeSearch(c.runtimeApi, c.runtimeBase, '/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: c.runtimeClientId });
    const userGrants = await runtimeSearch(c.runtimeApi, c.runtimeBase, '/v2/authorizations/search', { ownerType: 'USER', ownerId: email });
    if (authorizations.some(a => a.ownerType !== 'CLIENT' || a.ownerId !== c.runtimeClientId) || userGrants.some(a => a.ownerType !== 'USER' || a.ownerId !== email)) throw new Error('Unerwartete Freigabenantwort.');
    const ownerAccess = workspaceMembers.some(m => emailOf(m) === email && m.role === 'workspace_admin');
    const tenantAccess = tenantMembers.users.some(u => emailOf(u) === email) && support.every(id => tenantMembers.roles.some(r => r.roleId === id)) && tenantMembers.clients.some(a => a.clientId === c.runtimeClientId) && userGrants.some(a => !a.resourcePropertyName && a.resourceType === 'TENANT' && a.resourceId === target.tenantId && a.permissionTypes?.includes('READ'));
    const ready = Boolean(workspace && tenant && ownerAccess && tenantAccess && environments.some(e => e.id === c.environmentId));
    const snapshot = { revision: loaded.revision, contextRevision: c.revision, saved, target, member, workspace, workspaceMembers, projects, environments, tenant, tenantMembers, authorizations, userGrants };
    return { ...loaded, c, target, saved, member, workspace, tenant, workspaceMembers, projects, environments, tenantMembers, authorizations, userGrants, ownerAccess, tenantAccess, ready, fingerprint: hash(snapshot) };
  }
  row(state, site) {
    const activeAdmin = state.member?.roles?.some(role => role === 'admin' || role === 'owner') && !state.member.invitePending;
    const blocked = Boolean(state.saved?.uncertain);
    return { site, email: state.person.email, name: state.person.name, protectedOwner: state.protectedOwner, selected: state.person.sites[site], member: Boolean(state.member),
      state: blocked ? 'blocked' : state.ready ? 'ready' : state.workspace || state.tenant ? 'partial' : 'missing',
      workspace: state.workspace ? { id: state.workspace.workspaceKey, name: state.workspace.name, url: 'https://hub.camunda.io/workspaces/' + state.workspace.workspaceKey + '/projects' } : null,
      tenant: state.tenant ? { id: state.tenant.tenantId, name: state.tenant.name } : null, expectedName: state.target.workspaceName,
      canCreate: Boolean(activeAdmin && !state.ready && !blocked), canRemove: Boolean(!state.protectedOwner && (state.member || state.workspace || state.tenant) && !blocked),
      detail: blocked ? 'Vorheriger Schreibaufruf unbestätigt. Vor weiterem Anlegen oder Entfernen manuell prüfen.' : !activeAdmin ? 'Zuerst aktive Organisations-Admin-Mitgliedschaft über den Rollenabgleich herstellen.' : state.ready ? 'Workspace, Environment und eigener Tenant-Zugriff bestätigt.' : 'Private Ressourcen fehlen oder sind noch nicht vollständig zugewiesen.' };
  }
  async all() {
    const { config } = loadAdminConfig(this.configFile);
    const rows = [];
    // Limit concurrent requests: a site is read sequentially while three sites run independently.
    await Promise.all(SITE_IDS.map(async site => { let c; try { c = this.contextForSite(site); } catch {} for (const person of [...config.protectedOwners, ...config.lecturers]) {
      try { rows.push(this.row(await this.read(site, person.email, c), site)); }
      catch (error) { rows.push({ site, email: person.email, name: person.name, protectedOwner: config.protectedOwners.some(p => p.email === person.email), selected: person.sites[site], state: 'unknown', canCreate: false, canRemove: false, detail: error.message }); }
    } }));
    return { checkedAt: new Date().toISOString(), rows, note: 'Eigener Workspace/Tenant ist eine organisatorische Zuordnung. Organisationsadmins behalten Zugriff auf weitere Tenants.' };
  }
  async preview(site, email, action) {
    if (!['create', 'remove'].includes(action)) throw new CleanupError('Unbekannte Dozentenaktion.', 400);
    if (action === 'remove' && this.subject(site, email).protectedOwner) throw new CleanupError('Owner ist geschützt und kann nicht entfernt werden.');
    if (this.busy || this.cleanup.busy.has(site)) throw new CleanupError('An diesem Standort läuft bereits eine Verwaltung.');
    const s = await this.read(site, email), row = this.row(s, site);
    if (!(action === 'create' ? row.canCreate : row.canRemove)) throw new CleanupError(row.detail || 'Keine freigegebene Aktion.');
    let runtimeSnapshot = { tenants: [], groups: [], counts: [] }, grants = [];
    if (action === 'remove') {
      const classesFile = path.join(this.root, 'classes.local.json');
      if (fs.existsSync(classesFile) && JSON.parse(fs.readFileSync(classesFile, 'utf8')).classes.some(c => c.site === site && c.lecturerEmail === email && c.groups.some(g => g.workspaceKey))) throw new CleanupError('Dozent betreut an diesem Standort eingerichtete Klassen. Diese zuerst bereinigen oder einem anderen Dozenten zuordnen.');
      const allowed = new Set([email, ...s.config.protectedOwners.map(p => p.email)]);
      if (s.workspaceMembers.some(m => !allowed.has(emailOf(m)))) throw new CleanupError('Privater Workspace hat weitere Mitglieder; Entfernung gesperrt.');
      const tm = s.tenantMembers;
      if (tm.groups.length || tm['mapping-rules'].length || tm.users.some(u => emailOf(u) !== email) || tm.roles.some(r => !support.includes(r.roleId)) || tm.clients.some(a => a.clientId !== s.c.runtimeClientId)) throw new CleanupError('Privater Tenant wird zusätzlich verwendet; Entfernung gesperrt.');
      if (s.tenant) {
        const inventory = await analyzeCleanup(s.c);
        if (!inventory.runtime.available) throw new CleanupError('Tenant-Zugriffe sind nicht vollständig prüfbar.');
        runtimeSnapshot = await inspectRuntime(s.c, inventory, { tenants: [s.target.tenantId] }, s.authorizations);
        grants = requiredGrants(s.c, { tenants: [s.target.tenantId] }, runtimeSnapshot, s.authorizations);
      }
    }
    const preview = { id: crypto.randomUUID(), action, site, email, name: s.person.name, expiresAt: new Date(this.now() + 600000).toISOString(),
      workspaceName: s.workspace?.name || s.target.workspaceName, tenantName: s.tenant?.name || s.target.tenantName, runtimeCounts: runtimeSnapshot.counts,
      changes: action === 'create' ? ['Fehlenden privaten Workspace und Tenant anlegen; vorhandene bestätigte Teile wiederverwenden.', 'Dozent als Workspace-Admin und Tenant-Mitglied zuweisen; Environment und eigenes TENANT READ ergänzen.'] : ['Privaten Workspace samt Projekten nach „Zuletzt gelöscht“ verschieben.', 'Laufende private Instanzen abbrechen und Instanzen/Aufgaben endgültig löschen; privaten Tenant entfernen.', 'Organisationsmitgliedschaft des Dozenten an diesem Standort entfernen. Konfigurations-Häkchen anschließend abwählen; andere Standorte bleiben erhalten.'],
      permissionCount: grants.length };
    for (const [id, p] of this.plans) if (p.used || p.expires <= this.now()) this.plans.delete(id);
    if (this.plans.size >= 50) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(preview.id, { ...preview, fingerprint: s.fingerprint, runtimeSnapshot, grants, expires: this.now() + 600000, used: false });
    return { preview, appliedToCamunda: false };
  }
  async apply(id, acknowledged) {
    const p = this.plans.get(id);
    if (!p || p.used || p.expires <= this.now() || acknowledged !== true) throw new CleanupError('Vorschau fehlt, ist abgelaufen oder nicht bestätigt.');
    if (this.busy || this.cleanup.busy.has(p.site)) throw new CleanupError('Verwaltung läuft bereits.');
    p.used = true; this.busy = true;
    const lock = path.join(this.root, 'lecturer-resources-lock.local.json'), siteLock = path.join(this.root, 'cleanup-lock-' + p.site + '.local.json');
    let fd, siteFd, submitted = false, s, registry, entry, inFlight;
    const results = [], reportFile = path.join(this.root, 'lecturer-action-' + p.id + '.local.json');
    const report = status => fs.writeFileSync(reportFile, JSON.stringify({ site: p.site, email: p.email, action: p.action, status, inFlight, results, checkedAt: new Date().toISOString() }, null, 2));
    const stage = text => this.cleanup.reportProgress(p.site, { message: text, completed: results.length });
    const verify = read => this.cleanup.verifyAbsent(read, { onWait: elapsed => stage('Auf Bestätigung der Dozentenänderung von Camunda warten (' + Math.round(elapsed / 1000) + ' / 60 s) …') });
    const mutate = async (label, call) => { stage(label); inFlight = label; submitted = true; report('running'); const value = await call(); submitted = false; results.push(label); inFlight = undefined; report('running'); return value; };
    try {
      try { fd = fs.openSync(lock, 'wx', 0o600); siteFd = fs.openSync(siteLock, 'wx', 0o600); } catch (error) { throw new CleanupError('Eine Standort-/Dozentenverwaltung ist bereits reserviert.'); }
      this.cleanup.busy.add(p.site); this.cleanup.reportProgress(p.site, { runId: id, phase: 'running', message: 'Dozentenänderung erneut prüfen …', completed: 0, total: 0 });
      s = await this.read(p.site, p.email);
      if (p.action === 'remove' && s.protectedOwner) throw new CleanupError('Owner ist geschützt und kann nicht entfernt werden.');
      if (s.fingerprint !== p.fingerprint) throw new CleanupError('Konfiguration oder Camunda-Bestand wurde seit der Vorschau geändert. Nichts angewendet.');
      registry = this.registry(); entry = registry.entries[p.site + '/' + p.email] || { organizationId: s.c.expectedOrganization, runtimeBase: s.c.runtimeBase, tenantId: s.target.tenantId, workspaceKey: null };
      const save = () => { registry.entries[p.site + '/' + p.email] = entry; this.saveRegistry(registry); };
      const rt = (endpoint, options) => s.c.runtimeApi.runtime(s.c.runtimeBase, endpoint, options), search = (endpoint, filter) => runtimeSearch(s.c.runtimeApi, s.c.runtimeBase, endpoint, filter), api = s.c.organizationApi;
      if (p.action === 'create') {
        save();
        if (!s.workspace) {
          const w = await mutate('Privaten Workspace anlegen', () => api.hub('/workspaces', { method: 'POST', body: { name: s.target.workspaceName } }));
          if (!w?.workspaceKey) { submitted = true; throw new Error('Workspace-Anlage nicht eindeutig bestätigt.'); }
          entry.workspaceKey = w.workspaceKey; save();
        }
        const wb = '/workspaces/' + encodeURIComponent(entry.workspaceKey);
        if (!s.ownerAccess) await mutate('Dozent als Workspace-Admin zuweisen', async () => {
          try { await api.hub(wb + '/members', { method: 'POST', body: { email: p.email, role: 'workspace_admin' } }); }
          catch (error) {
            if (error.status !== 400) throw error;
            const members = await searchAll(api, '/members/search', { workspaceKey: { $eq: entry.workspaceKey } });
            if (members.some(m => emailOf(m) === p.email && m.role !== 'workspace_admin')) throw new Error('Workspace-Rolle wurde geändert.');
            if (!members.some(m => emailOf(m) === p.email)) await api.request('https://hub.camunda.io', '/api/v1/collaborators', { method: 'PUT', body: { email: p.email, projectId: entry.workspaceKey, role: 'project_admin' } });
          }
          if (!await verify(async () => (await searchAll(api, '/members/search', { workspaceKey: { $eq: entry.workspaceKey } })).some(m => emailOf(m) === p.email && m.role === 'workspace_admin'))) throw new Error('Workspace-Admin-Zuweisung nicht bestätigt.');
        });
        const environmentId = s.c.environmentId;
        if (!s.environments.some(e => e.id === environmentId)) await mutate('Workspace mit dem Standort-Environment verbinden', () => api.hub(wb + '/environments', { method: 'PUT', body: { environmentIds: [...new Set([...s.environments.map(e => e.id), environmentId])] } }));
        const tb = '/v2/tenants/' + encodeURIComponent(entry.tenantId);
        if (!s.tenant) await mutate('Privaten Tenant anlegen', () => rt('/v2/tenants', { method: 'POST', body: { tenantId: entry.tenantId, name: s.target.tenantName, description: s.target.marker } }));
        if (!s.tenantMembers.clients.some(x => x.clientId === s.c.runtimeClientId)) await mutate('Technischen Tenant-Zugriff sichern', () => rt(tb + '/clients/' + encodeURIComponent(s.c.runtimeClientId), { method: 'PUT' }));
        for (const role of support) if (!s.tenantMembers.roles.some(r => r.roleId === role)) await mutate('Admin-/Technikzugriff zuweisen', () => rt(tb + '/roles/' + role, { method: 'PUT' }));
        if (!s.tenantMembers.users.some(u => emailOf(u) === p.email)) await mutate('Dozent seinem Tenant zuweisen', () => rt(tb + '/users/' + encodeURIComponent(p.email), { method: 'PUT' }));
        if (!s.userGrants.some(g => g.resourceType === 'TENANT' && g.resourceId === entry.tenantId && g.permissionTypes?.includes('READ'))) await mutate('Eigenes Tenant-Leserecht zuweisen', () => rt('/v2/authorizations', { method: 'POST', body: { ownerType: 'USER', ownerId: p.email, resourceType: 'TENANT', resourceId: entry.tenantId, permissionTypes: ['READ'] } }));
        if (!await verify(async () => (await this.read(p.site, p.email)).ready)) throw new Error('Private Ressourcen noch nicht vollständig bestätigt.');
        entry.uncertain = false; save();
      } else {
        if (s.tenant) {
          const inventory = await analyzeCleanup(s.c), current = await inspectRuntime(s.c, inventory, { tenants: [s.target.tenantId] }, s.authorizations);
          if (!equal(current, p.runtimeSnapshot)) throw new CleanupError('Private Instanzen oder Aufgaben wurden geändert. Nichts gelöscht.');
          for (const grant of p.grants) await mutate('Gezielte private Tenant-/Instanz-Löschrechte ergänzen', async () => {
            await rt('/v2/authorizations', { method: 'POST', body: grant });
            if (!await verify(async () => { const a = await search('/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: s.c.runtimeClientId }); return grant.permissionTypes.every(perm => has(a, grant.resourceType, grant.resourceId, perm)); })) throw new Error('Löschfreigabe nicht bestätigt.');
          });
          await mutate('Private Instanzen und Aufgaben bereinigen', () => purgeTenant(s.c, p.runtimeSnapshot.tenants[0], this.cleanup.wait, target => stage(target.phase === 'cancel' ? 'Private Instanz abbrechen' : 'Private Instanz-/Aufgabenbereinigung prüfen')));
        }
        if (s.workspace) await mutate('Privaten Workspace samt Projekten entfernen', async () => {
          const [members, projects] = await Promise.all([searchAll(api, '/members/search', { workspaceKey: { $eq: s.workspace.workspaceKey } }), searchAll(api, '/projects/search', { workspaceKey: { $eq: s.workspace.workspaceKey } })]);
          if (!equal(members, s.workspaceMembers) || !equal(projects, s.projects)) throw new Error('Privater Workspace wurde seit der Vorschau geändert.');
          await api.hub('/workspaces/' + encodeURIComponent(s.workspace.workspaceKey), { method: 'DELETE' });
          if (!await verify(async () => !(await searchAll(api, '/workspaces/search')).some(w => w.workspaceKey === s.workspace.workspaceKey))) throw new Error('Workspace-Entfernung nicht bestätigt.');
        });
        if (s.tenant) await mutate('Privaten Tenant entfernen', async () => {
          const current = await this.read(p.site, p.email);
          if (!equal(current.tenantMembers, s.tenantMembers) || current.tenant?.description !== s.target.marker) throw new Error('Private Tenant-Zuordnungen wurden geändert.');
          await assertTenantsEmpty(s.c, [s.target.tenantId]);
          await rt('/v2/tenants/' + encodeURIComponent(s.target.tenantId), { method: 'DELETE' });
          if (!await verify(() => absent(rt, '/v2/tenants/' + encodeURIComponent(s.target.tenantId)))) throw new Error('Tenant-Entfernung nicht bestätigt.');
        });
        if (s.member) await mutate('Dozent aus dieser Organisation entfernen', async () => {
          const fresh = this.subject(p.site, p.email); if (fresh.revision !== s.revision) throw new Error('Konfiguration wurde geändert.');
          const current = (await api.console('/members')).find(m => emailOf(m) === p.email);
          if (current?.roles?.includes('owner') || (current && !equal(current.roles, s.member.roles))) throw new Error('Organisationsrollen wurden geändert. Owner bleibt geschützt.');
          if (current) await api.console('/members/' + encodeURIComponent(p.email), { method: 'DELETE' });
          if (!await this.cleanup.verifyAbsent(async () => !(await api.console('/members')).some(m => emailOf(m) === p.email), { timeoutMs: 180000, onWait: elapsed => stage('Mitgliedschaftsentfernung nachprüfen (' + Math.round(elapsed / 1000) + ' / 180 s) …') })) throw new Error('Mitgliedschaftsentfernung nicht bestätigt.');
        });
        const loaded = this.subject(p.site, p.email);
        if (loaded.revision !== s.revision) throw new Error('JSON wurde zwischenzeitlich geändert; Mitgliedschaft entfernt, Sollauswahl bitte prüfen.');
        loaded.person.sites[p.site] = false; saveAdminConfig(this.configFile, loaded.config, loaded.revision);
        delete registry.entries[p.site + '/' + p.email]; this.saveRegistry(registry);
      }
      report('completed'); this.cleanup.reportProgress(p.site, { phase: 'completed', message: 'Dozentenänderung bestätigt.', completed: results.length });
      return { status: 'completed', results, note: 'Änderungen lesend bestätigt. Andere Standorte und Owner bleiben erhalten.' };
    } catch (error) {
      if (submitted && entry && registry && p.action === 'create') { entry.uncertain = true; registry.entries[p.site + '/' + p.email] = entry; this.saveRegistry(registry); }
      report('incomplete'); this.cleanup.reportProgress(p.site, { phase: 'stopped', message: 'Dozentenänderung gestoppt. Ergebnis prüfen.' });
      return { status: 'incomplete', results, error: error.message, note: 'Teiländerungen möglich. Keine automatische Wiederholung; aktuellen Stand neu prüfen.' };
    } finally { if (siteFd !== undefined) { fs.closeSync(siteFd); fs.unlinkSync(siteLock); this.cleanup.busy.delete(p.site); } if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } this.busy = false; }
  }
}
module.exports = { LecturerResources, targetFor };
