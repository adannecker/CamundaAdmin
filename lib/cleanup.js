const dataStore = require('./state-store');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { analyzeCleanup } = require('./cleanup-analysis');
const { searchAll } = require('./onboarding');
const { runtimeSearch } = require('./tenancy');
const { ApiError } = require('./camunda-api');
const { SITE_IDS } = require('./admin-config');
const { inspectRuntime, requiredGrants, purgeTenant, dataSearch, has, absent, groupGrant, assertReadAccess, assertTenantsEmpty } = require('./cleanup-runtime');

class CleanupError extends Error { constructor(message, status = 409) { super(message); this.status = status; } }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => k !== 'checkedAt').map(k => [k, canonical(value[k])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a, b) => digest(a) === digest(b);
const SUPPORT_ROLES = ['admin', 'connectors', 'app-integrations'];
function candidates(inventory, context, capabilities) {
  const known = new Map(inventory.people.map(p => [p.email, p]));
  const supportUser = email => context.protectedEmails.includes(email) || known.get(email)?.organizationRoles.some(r => ['owner', 'admin'].includes(r));
  const students = inventory.people.map(p => ({ id: p.email, name: p.name || p.email, selectable: p.classification === 'student',
    reason: p.classification === 'student' ? 'Bestätigte Studierendenrolle.' : p.classification === 'protected' ? 'Geschütztes Konto / zusätzliche Rollen.' : 'Studierenden-Zuordnung noch nicht bestätigt.' }));
  const workspaces = inventory.workspaces.map(w => {
    let reason = '';
    if (!w.members || !w.projects) reason = 'Mitglieder oder Projekte nicht vollständig lesbar.';
    else if (w.otherMemberEmails.some(email => !supportUser(email))) reason = 'Weitere, nicht eindeutig zugeordnete Mitglieder.';
    else if (!w.studentEmails.length && !(context.managedWorkspaceNames || []).includes(w.name)) reason = 'Kein bestätigter Studierenden-Workspace.';
    return { id: w.id, name: w.name, selectable: !reason, reason: reason || `${w.projects.length} Projekte; Workspace und Inhalte werden nach „Zuletzt gelöscht“ verschoben.` };
  });
  const tenants = inventory.runtime.tenants.map(t => {
    let reason = '';
    const groups = t.groupIds.map(id => inventory.runtime.groups.find(g => g.id === id));
    if (t.system || t.id === '<default>') reason = 'System-Tenant bleibt erhalten.';
    else if (!t.groupIds.length || groups.some(g => !g || !inventory.runtime.studentGroups.includes(g.id))) reason = 'Kein eindeutig bestätigter Studierenden-Gruppentenant.';
    else if (t.mappingRuleCount || t.roleIds.some(id => !SUPPORT_ROLES.includes(id))) reason = 'Weitere Rollen oder Mapping-Regeln; gemeinsame Nutzung prüfen.';
    else if ([...t.users, ...groups.flatMap(g => g.users)].some(email => known.get(email)?.classification !== 'student')) reason = 'Weitere oder geschützte Benutzer greifen auf diesen Tenant zu.';
    else if (t.clientIds.some(id => id !== context.runtimeClientId)) reason = 'Weitere technische Clients greifen auf diesen Tenant zu.';
    else if (!capabilities.canPrepareTenantDelete && !capabilities.tenantDeleteIds.some(id => id === '*' || id === t.id)) reason = 'Runtime-Client benötigt TENANT DELETE oder AUTHORIZATION CREATE für eine gezielte Freigabe.';
    return { id: t.id, name: t.name, selectable: !reason, reason: reason || 'Instanzen, Aufgaben und zugehörige Runtime-Gruppen bereinigen, danach Tenant löschen. Anzahl in der Vorschau.' };
  });
  return { students, workspaces, tenants };
}
function validateSelection(input, options, inventory) {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'students,tenants,workspaces') throw new CleanupError('Ungültige Auswahl.', 400);
  const selected = {};
  for (const kind of ['students', 'workspaces', 'tenants']) {
    if (!Array.isArray(input[kind]) || input[kind].length > 1000 || input[kind].some(id => typeof id !== 'string') || new Set(input[kind]).size !== input[kind].length) throw new CleanupError('Ungültige oder doppelte Auswahl.', 400);
    selected[kind] = [...input[kind]].sort();
    for (const id of selected[kind]) if (!options[kind].some(item => item.id === id && item.selectable)) throw new CleanupError(`Auswahl ist nicht freigegeben: ${kind} / ${id}`);
  }
  if (!Object.values(selected).some(ids => ids.length)) throw new CleanupError('Bitte zuerst Einträge auswählen.', 400);
  for (const email of selected.students) {
    const p = inventory.people.find(p => p.email === email);
    if (p.workspaceIds.some(id => !selected.workspaces.includes(id)) || p.tenantIds.some(id => id !== '<default>' && !selected.tenants.includes(id))) throw new CleanupError(`${email} wird noch in einem nicht ausgewählten Workspace oder Tenant gebraucht. Auswahl gemeinsam prüfen.`);
  }
  for (const id of selected.tenants) {
    const t = inventory.runtime.tenants.find(t => t.id === id);
    const users = [...t.users, ...inventory.runtime.groups.filter(g => t.groupIds.includes(g.id)).flatMap(g => g.users)];
    if (users.some(email => !selected.students.includes(email))) throw new CleanupError(`Tenant ${id} hat nicht ausgewählte Studierende. Diese Zuordnung gemeinsam prüfen.`);
  }
  return selected;
}

class Cleanup {
  constructor({ root, contextForSite, now = Date.now, wait = delay }) {
    this.root = root; this.contextForSite = contextForSite; this.now = now; this.wait = wait;
    this.analyses = new Map(); this.plans = new Map(); this.busy = new Set(); this.progress = new Map();
  }
  getProgress(site) { return this.progress.get(site) || { phase: 'idle', message: 'Kein Cleanup aktiv.', completed: 0, total: 0 }; }
  reportProgress(site, update) { this.progress.set(site, { ...this.getProgress(site), ...update, updatedAt: new Date(this.now()).toISOString() }); }
  async read(site) {
    if (!SITE_IDS.includes(site)) throw new CleanupError('Unbekannter Standort.', 400);
    const context = this.contextForSite(site);
    const inventory = await analyzeCleanup(context);
    const capabilities = { tenantDeleteIds: [], canPrepareTenantDelete: false }; let authorizations = [];
    if (inventory.runtime.available) {
      try {
        const rows = await runtimeSearch(context.runtimeApi, context.runtimeBase, '/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: context.runtimeClientId });
        if (rows.some(r => r.ownerType !== 'CLIENT' || r.ownerId !== context.runtimeClientId || !Array.isArray(r.permissionTypes))) throw new Error('Unerwarteter Authorization-Filter.');
        capabilities.tenantDeleteIds = rows.filter(r => r.resourceType === 'TENANT' && r.permissionTypes.includes('DELETE')).map(r => r.resourceId);
        capabilities.canPrepareTenantDelete = rows.some(r => r.resourceType === 'AUTHORIZATION' && r.resourceId === '*' && r.permissionTypes.includes('CREATE'));
        authorizations = rows;
      } catch { inventory.warnings.push('Tenant-Löschrechte konnten nicht vollständig gelesen werden.'); }
    }
    const options = candidates(inventory, context, capabilities);
    return { context, inventory, options, capabilities, authorizations, fingerprint: digest({ revision: context.revision, inventory, capabilities, options, authorizations }) };
  }
  async analyze(site) {
    if (this.busy.has(site)) throw new CleanupError('Für diesen Standort läuft ein Cleanup.');
    const state = await this.read(site), id = crypto.randomUUID();
    for (const [key, entry] of this.analyses) if (entry.expires <= this.now()) this.analyses.delete(key);
    if (this.analyses.size >= 30) this.analyses.delete(this.analyses.keys().next().value);
    this.analyses.set(id, { site, fingerprint: state.fingerprint, expires: this.now() + 30 * 60000 });
    return { ...state.inventory, analysisId: id, deletionEnabled: true, selection: state.options };
  }
  async preview(site, analysisId, input) {
    const analysis = this.analyses.get(analysisId);
    if (!analysis || analysis.site !== site || analysis.expires <= this.now()) throw new CleanupError('Analyse fehlt oder ist abgelaufen. Bitte Bestand neu analysieren.');
    if (this.busy.has(site)) throw new CleanupError('Für diesen Standort läuft ein Cleanup.');
    const state = await this.read(site);
    if (state.fingerprint !== analysis.fingerprint) throw new CleanupError('Bestand oder Konfiguration wurde seit der Analyse geändert. Bitte neu analysieren.');
    const selection = validateSelection(input, state.options, state.inventory);
    const runtimeSnapshot = await inspectRuntime(state.context, state.inventory, selection, state.authorizations);
    const permissionGrants = requiredGrants(state.context, selection, runtimeSnapshot, state.authorizations);
    const publicPlan = { id: crypto.randomUUID(), site, expiresAt: new Date(this.now() + 10 * 60000).toISOString(), selection,
      items: Object.fromEntries(Object.keys(selection).map(kind => [kind, state.options[kind].filter(item => selection[kind].includes(item.id))])), runtimeCounts: runtimeSnapshot.counts,
      permissionSummary: [...new Set(permissionGrants.map(g => g.resourceType))].map(resourceType => ({ resourceType, count: permissionGrants.filter(g => g.resourceType === resourceType).length })),
      effects: ['Studierende werden aus dieser Organisation entfernt. Ihre bestätigten Runtime-Gruppen-/Studierendenrollen-Zuweisungen werden entfernt.', 'Workspaces werden samt allen Projekten und Inhalten nach „Zuletzt gelöscht“ verschoben.', 'Laufende Instanzen der ausgewählten Tenants werden abgebrochen. Alle erfassten Instanzen und ihre Aufgaben werden endgültig gelöscht. Danach werden die ausschließlich zu diesen Tenants gehörenden Runtime-Gruppen und zuletzt die Tenants gelöscht. Prozessdefinitionen bleiben erhalten.', 'Erforderliche technische Abbruch-/Löschrechte werden nur auf die betroffenen Prozess-IDs, Gruppen und Tenants vergeben und bleiben gespeichert. Bei Änderungen oder nicht bestätigter Bereinigung bleibt der weitere Lauf gestoppt.'] };
    for (const [key, entry] of this.plans) if (entry.used || entry.expires <= this.now()) this.plans.delete(key);
    if (this.plans.size >= 30) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(publicPlan.id, { ...publicPlan, permissionGrants, runtimeSnapshot, expires: this.now() + 10 * 60000, fingerprint: state.fingerprint, revision: state.context.revision, used: false });
    return { preview: publicPlan, appliedToCamunda: false };
  }
  async verifyAbsent(read, { onWait = () => {}, timeoutMs = 60000 } = {}) {
    let elapsed = 0, interval = 250;
    while (true) {
      if (await read()) return true;
      if (elapsed >= timeoutMs) return false;
      const pause = Math.min(interval, timeoutMs - elapsed);
      onWait(elapsed, timeoutMs); await this.wait(pause); elapsed += pause; interval = Math.min(interval * 2, 5000);
    }
  }
  async apply(site, id, acknowledged) {
    const plan = this.plans.get(id);
    if (!plan || plan.site !== site || plan.used || plan.expires <= this.now()) throw new CleanupError('Löschvorschau fehlt, ist abgelaufen oder wurde bereits verwendet.');
    if (acknowledged !== true) throw new CleanupError('Bitte die angezeigten Löschfolgen ausdrücklich bestätigen.', 400);
    if (this.busy.has(site)) throw new CleanupError('Für diesen Standort läuft bereits ein Cleanup.');
    plan.used = true; this.busy.add(site);
    this.reportProgress(site, { runId: id, phase: 'running', message: 'Auswahl, Konfiguration und Bestand erneut prüfen …', completed: 0, total: 0 });
    const lock = path.join(this.root, `cleanup-lock-${site}.local.json`), file = path.join(this.root, `cleanup-${site}-${plan.id}.local.json`);
    let lockFd; const results = [], operations = [
      ...plan.selection.workspaces.map(id => ({ kind: 'workspaces', id })), ...plan.selection.tenants.map(id => ({ kind: 'runtime', id })), ...plan.selection.students.map(id => ({ kind: 'students', id })),
      ...plan.runtimeSnapshot.groups.map(g => ({ kind: 'groups', id: g.id })), ...plan.selection.tenants.map(id => ({ kind: 'tenants', id })),
    ];
    let inFlight, endStatus = 'stopped', currentMessage = 'Auswahl prüfen';
    const report = message => { currentMessage = message; this.reportProgress(site, { message }); };
    const verify = (read, timeoutMs = 60000) => this.verifyAbsent(read, { timeoutMs, onWait: (elapsed, limit) => this.reportProgress(site, { message: currentMessage + ' · Auf Bestätigung von Camunda warten (' + Math.round(elapsed / 1000) + ' / ' + Math.round(limit / 1000) + ' s) …' }) });
    const record = status => dataStore.writeJson(file, { site, planId: plan.id, status, checkedAt: new Date().toISOString(), selection: plan.selection, runtimeCounts: plan.runtimeCounts, permissionGrants: plan.permissionGrants, inFlight, results });
    try {
      try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new CleanupError('Ein Cleanup ist bereits reserviert.'); throw e; }
      const state = await this.read(site);
      if (state.fingerprint !== plan.fingerprint) throw new CleanupError('Bestand oder Konfiguration wurde seit der Löschvorschau geändert. Nichts gelöscht.');
      validateSelection(plan.selection, state.options, state.inventory);
      const freshSnapshot = await inspectRuntime(state.context, state.inventory, plan.selection, state.authorizations);
      if (!same(freshSnapshot, plan.runtimeSnapshot)) throw new CleanupError('Instanzen, Aufgaben oder Runtime-Gruppen wurden seit der Vorschau geändert. Bitte neu analysieren. Nichts gelöscht.');
      const c = state.context, runtime = (endpoint, options) => c.runtimeApi.runtime(c.runtimeBase, endpoint, options);
      const search = (endpoint, filter) => runtimeSearch(c.runtimeApi, c.runtimeBase, endpoint, filter);
      this.reportProgress(site, { total: operations.length });
      record('running');
      // Only the previously displayed exact resource grants are allowed; no write retries.
      try {
        for (const grant of plan.permissionGrants) {
          if (this.contextForSite(site).revision !== plan.revision) throw new Error('Konfiguration wurde geändert.');
          const rows = await search('/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: c.runtimeClientId });
          const missing = grant.permissionTypes.filter(p => !has(rows, grant.resourceType, grant.resourceId, p));
          if (!missing.length) continue;
          report('Gezielte technische Freigaben vorbereiten');
          inFlight = { phase: 'permission', resourceType: grant.resourceType, resourceId: grant.resourceId }; record('running');
          await runtime('/v2/authorizations', { method: 'POST', body: { ...grant, permissionTypes: missing } });
          if (!await verify(async () => {
            const actual = await search('/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: c.runtimeClientId });
            return missing.every(p => has(actual, grant.resourceType, grant.resourceId, p));
          })) throw new Error('Gezielte technische Freigabe noch nicht lesend bestätigt.');
        }
      } catch (error) { record('incomplete'); return { status: 'incomplete', results: [], notAttempted: operations.map(o => ({ kind: o.kind })), note: 'Technische Freigabe nicht vollständig bestätigt: ' + error.message + ' Keine automatische Wiederholung.' }; }
      for (const operation of operations) {
        let submitted = false;
        try {
          report(({ workspaces: 'Workspace und Projekte entfernen', runtime: 'Prozessinstanzen und Aufgaben bereinigen', students: 'Studierendenzugriffe und Mitgliedschaft entfernen', groups: 'Runtime-Gruppe entfernen', tenants: 'Leeren Tenant entfernen' })[operation.kind]);
          this.reportProgress(site, { completed: results.length, step: results.length + 1 });
          if (this.contextForSite(site).revision !== plan.revision) throw new Error('Konfiguration wurde geändert.');
          if ((await c.organizationApi.hub('/info')).authorizedOrganization !== c.expectedOrganization) throw new Error('Organisation stimmt nicht mehr überein.');
          if (['students', 'groups'].includes(operation.kind)) await assertTenantsEmpty(c, plan.selection.tenants);
          if (operation.kind === 'workspaces') {
            const old = state.inventory.workspaces.find(w => w.id === operation.id);
            const members = await searchAll(c.organizationApi, '/members/search', { workspaceKey: { $eq: operation.id } });
            const projects = await searchAll(c.organizationApi, '/projects/search', { workspaceKey: { $eq: operation.id } });
            if (!same(old.members, members.map(m => ({ email: String(m.email || m.username || '').trim().toLowerCase(), role: m.role }))) || !same(old.projects, projects.map(p => ({ id: p.projectKey, name: p.name })))) throw new Error('Workspace-Mitglieder oder Projekte wurden geändert.');
            submitted = true; record('running');
            await c.organizationApi.hub('/workspaces/' + encodeURIComponent(operation.id), { method: 'DELETE' });
            if (!await verify(async () => !(await searchAll(c.organizationApi, '/workspaces/search')).some(w => w.workspaceKey === operation.id))) throw new Error('Workspace-Löschung nach der Wartezeit noch nicht lesend bestätigt.');
          } else if (operation.kind === 'runtime') {
            const snapshot = plan.runtimeSnapshot.tenants.find(t => t.id === operation.id);
            // Recheck the snapshot immediately before the first cancellation/deletion.
            const current = await inspectRuntime(c, state.inventory, plan.selection, await search('/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: c.runtimeClientId }));
            if (!same(current.tenants.find(t => t.id === operation.id), snapshot)) throw new Error('Instanzen oder Aufgaben wurden seit der Vorschau geändert.');
            submitted = snapshot.processes.length > 0;
            await purgeTenant(c, snapshot, this.wait, target => { inFlight = target; report(target.phase === 'cancel' ? 'Laufende Prozessinstanz abbrechen' : target.phase === 'delete-instance' ? 'Beendete Prozessinstanz und Aufgaben löschen' : 'Auf Instanz- und Aufgabenbereinigung warten'); record('running'); });
          } else if (operation.kind === 'groups') {
            const old = plan.runtimeSnapshot.groups.find(g => g.id === operation.id), base = '/v2/groups/' + encodeURIComponent(operation.id);
            const current = await this.read(site);
            if (!same(current.inventory.runtime.tenants.filter(t => t.groupIds.includes(operation.id)).map(t => t.id), old.tenantIds)) throw new Error('Tenant-Zuordnungen der Gruppe wurden geändert.');
            const [users, clients, mappings, roles, grants] = await Promise.all([
              search(base + '/users/search'), search(base + '/clients/search'), search(base + '/mapping-rules/search'), search(base + '/roles/search'), search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: operation.id }),
            ]);
            if (users.length || clients.length || mappings.length || !same(roles.map(r => r.roleId), old.roles) || !same(grants.map(groupGrant), old.grants)) throw new Error('Gruppenzuordnungen wurden geändert oder sind noch nicht leer.');
            for (const tenantId of old.tenantIds) {
              report('Runtime-Gruppe zuerst vom Tenant lösen'); inFlight = { ...operation, phase: 'detach-tenant', tenantId }; submitted = true; record('running');
              await runtime('/v2/tenants/' + encodeURIComponent(tenantId) + '/groups/' + encodeURIComponent(operation.id), { method: 'DELETE' });
              if (!await verify(async () => !(await search('/v2/tenants/' + encodeURIComponent(tenantId) + '/groups/search')).some(g => g.groupId === operation.id))) throw new Error('Tenant-Gruppenzuordnung noch nicht entfernt.');
            }
            report('Runtime-Gruppe entfernen');
            inFlight = operation; submitted = true; record('running'); await runtime(base, { method: 'DELETE' });
            if (!await verify(() => absent(runtime, base))) throw new Error('Runtime-Gruppenlöschung nach der Wartezeit noch nicht bestätigt.');
          } else if (operation.kind === 'tenants') {
            const old = state.inventory.runtime.tenants.find(t => t.id === operation.id), base = '/v2/tenants/' + encodeURIComponent(operation.id);
            if (operation.id === '<default>' || old.system) throw new Error('System-Tenant bleibt geschützt.');
            report('Entfernte Gruppen- und Benutzerzuordnungen am Tenant nachprüfen');
            if (!await verify(async () => {
              const [groups, users, roles, clients, mappings] = await Promise.all(['groups', 'users', 'roles', 'clients', 'mapping-rules'].map(type => search(base + '/' + type + '/search')));
              if (groups.some(g => !old.groupIds.includes(g.groupId)) || users.some(u => !plan.selection.students.includes(String(u.username || u.email).toLowerCase())) || !same(old.roleIds, roles.map(r => r.roleId)) || !same(old.clientIds, clients.map(r => r.clientId)) || mappings.length !== old.mappingRuleCount) throw new Error('Tenant-Zuordnungen wurden unerwartet geändert.');
              return !groups.length && !users.length;
            })) throw new Error('Tenant-Zuordnungen sind nach der Wartezeit noch nicht bereinigt.');
            const [instances, tasks] = await Promise.all([dataSearch(c, '/v2/process-instances/search', { tenantId: operation.id }, 'processInstanceKey'), dataSearch(c, '/v2/user-tasks/search', { tenantId: operation.id }, 'userTaskKey')]);
            if (instances.length || tasks.length) throw new Error('Tenant enthält noch Instanzen oder Aufgaben und bleibt erhalten.');
            await assertReadAccess(c, operation.id);
            const grants = await search('/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: c.runtimeClientId });
            if (!grants.some(a => a.ownerType === 'CLIENT' && a.ownerId === c.runtimeClientId && a.resourceType === 'TENANT' && ['*', operation.id].includes(a.resourceId) && a.permissionTypes.includes('DELETE'))) {
              throw new Error('Tenant-Löschrecht wurde geändert.');
            }
            report('Leeren Tenant entfernen'); inFlight = operation; submitted = true; record('running'); await runtime(base, { method: 'DELETE' });
            if (!await verify(async () => { try { await runtime(base); return false; } catch (e) { if (e instanceof ApiError && e.status === 404) return true; throw e; } })) throw new Error('Tenant-Löschung nach der Wartezeit noch nicht bestätigt.');
          } else {
            const fresh = await this.read(site), p = fresh.inventory.people.find(p => p.email === operation.id);
            if (!p || p.classification !== 'student' || c.protectedEmails.includes(p.email)) throw new Error('Konto ist nicht mehr als löschbare/r Studierende/r bestätigt.');
            if (p.workspaceIds.some(id => !plan.selection.workspaces.includes(id)) || p.tenantIds.some(id => id !== '<default>' && !plan.selection.tenants.includes(id))) throw new Error('Konto hat zwischenzeitlich weitere Zuordnungen erhalten.');
            for (const groupId of p.groupIds) {
              report('Studierendenkonto aus Runtime-Gruppe entfernen'); inFlight = { ...operation, phase: 'remove-group', groupId };
              submitted = true; record('running'); await runtime(`/v2/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(p.email)}`, { method: 'DELETE' });
              if (!await verify(async () => !(await search(`/v2/groups/${encodeURIComponent(groupId)}/users/search`)).some(u => String(u.username || u.email).toLowerCase() === p.email))) throw new Error('Gruppenentfernung nach der Wartezeit noch nicht bestätigt.');
            }
            if (fresh.inventory.runtime.studentUsers.includes(p.email)) {
              report('Direkte Studierendenrolle entfernen'); inFlight = { ...operation, phase: 'remove-role' }; record('running');
              submitted = true; await runtime(`/v2/roles/${encodeURIComponent(c.runtimeRole)}/users/${encodeURIComponent(p.email)}`, { method: 'DELETE' });
              if (!await verify(async () => !(await search(`/v2/roles/${encodeURIComponent(c.runtimeRole)}/users/search`)).some(u => String(u.username || u.email).toLowerCase() === p.email))) throw new Error('Rollenentfernung nach der Wartezeit noch nicht bestätigt.');
            }
            for (const tenant of fresh.inventory.runtime.tenants.filter(t => t.users.includes(p.email))) {
              report('Direkte Tenant-Zuordnung entfernen'); inFlight = { ...operation, phase: 'remove-tenant', tenantId: tenant.id }; record('running');
              submitted = true; await runtime(`/v2/tenants/${encodeURIComponent(tenant.id)}/users/${encodeURIComponent(p.email)}`, { method: 'DELETE' });
              if (!await verify(async () => !(await search(`/v2/tenants/${encodeURIComponent(tenant.id)}/users/search`)).some(u => String(u.username || u.email).toLowerCase() === p.email))) throw new Error('Direkte Tenant-Zuordnung nach der Wartezeit noch nicht entfernt.');
            }
            report('Mitgliedschaft in dieser Organisation entfernen'); inFlight = { ...operation, phase: 'remove-membership' };
            submitted = true; record('running'); await c.organizationApi.console('/members/' + encodeURIComponent(p.email), { method: 'DELETE' });
            if (!await verify(async () => !(await c.organizationApi.console('/members')).some(m => m.email.toLowerCase() === p.email), 180000)) throw new Error('Organisationsentfernung nach der Wartezeit noch nicht bestätigt.');
          }
          inFlight = undefined; results.push({ ...operation, status: 'verified', message: 'Löschung/Entfernung lesend bestätigt.' }); this.reportProgress(site, { completed: results.length }); record('running');
        } catch (error) { results.push({ ...operation, status: submitted ? 'uncertain' : 'failed', message: error.message }); record('incomplete'); break; }
      }
      const status = results.length === operations.length && results.every(r => r.status === 'verified') ? 'completed' : 'incomplete';
      endStatus = status === 'completed' ? 'completed' : 'stopped';
      record(status);
      const publicResults = results.filter(r => r.kind !== 'groups');
      if (results.some(r => r.kind === 'groups')) publicResults.push({ kind: 'groups', count: results.filter(r => r.kind === 'groups' && r.status === 'verified').length, status: results.some(r => r.kind === 'groups' && r.status !== 'verified') ? 'uncertain' : 'verified', message: 'Runtime-Gruppen: nur Anzahl, Einzelziele im lokalen Nachweis.' });
      return { status, results: publicResults, runtimeCounts: plan.runtimeCounts, notAttempted: operations.slice(results.length).map(o => ({ kind: o.kind })), note: 'Keine automatische Wiederholung. Prozessdefinitionen bleiben erhalten. Instanz- und Aufgabenlöschung ist endgültig.' };
    } finally { if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); } this.busy.delete(site); this.reportProgress(site, { phase: endStatus, message: endStatus === 'completed' ? 'Cleanup abgeschlossen und bestätigt.' : 'Cleanup gestoppt. Ergebnisse prüfen; Änderungen werden nicht automatisch wiederholt.' }); }
  }
}
module.exports = { Cleanup, CleanupError, candidates, validateSelection };
