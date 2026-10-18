const dataStore = require('./state-store');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { CamundaApi, readCredentials, ApiError } = require('./camunda-api');
const { loadAdminConfig, SITE_IDS } = require('./admin-config');
const { runtimeSearch } = require('./tenancy');

const ROLE = 'studierende';
const STUDENT_GRANTS = [
  ['COMPONENT', 'operate', ['ACCESS']], ['COMPONENT', 'tasklist', ['ACCESS']],
  ['RESOURCE', '*', ['CREATE']],
  ['PROCESS_DEFINITION', '*', ['READ_PROCESS_DEFINITION', 'CREATE_PROCESS_INSTANCE', 'READ_PROCESS_INSTANCE']],
  ['PROCESS_DEFINITION', '*', ['READ_USER_TASK', 'CLAIM_USER_TASK', 'COMPLETE_USER_TASK', 'UPDATE_USER_TASK']],
];
const CLIENT_GRANTS = [
  ['ROLE', ROLE, ['READ', 'UPDATE']], ['ROLE', '*', ['READ']],
  ['GROUP', '*', ['READ', 'CREATE', 'UPDATE']], ['TENANT', '*', ['READ', 'CREATE', 'UPDATE']],
  ['AUTHORIZATION', '*', ['READ', 'CREATE']],
  ['PROCESS_DEFINITION', '*', ['READ_PROCESS_INSTANCE', 'READ_USER_TASK']],
];
const SCOPES = ['GetCluster', 'GetZeebeClient', 'CreateZeebeClient', 'GetModel', 'CreateModel', 'UpdateModel', 'GetMembers', 'UpdateMembers'];
const SUPPORT = ['admin', 'connectors', 'app-integrations'];
const LABELS = { 'create-client': 'Onboarding-Zugang anlegen', 'create-role': 'Studierendenrolle anlegen', 'student-grants': 'Fehlende Studierendenrechte anlegen', 'client-grants': 'Fehlende Clientrechte anlegen', 'support-access': 'Admin-/Technikzugriff ergänzen' };

function desired(ownerType, ownerId, tuples) { return tuples.map(([resourceType, resourceId, permissionTypes]) => ({ ownerType, ownerId, resourceType, resourceId, permissionTypes })); }
function missingGrants(actual, expected) {
  return expected.flatMap(grant => {
    const found = actual.filter(a => a.ownerType === grant.ownerType && a.ownerId === grant.ownerId && a.resourceType === grant.resourceType && a.resourceId === grant.resourceId && !a.resourcePropertyName);
    const permissionTypes = grant.permissionTypes.filter(p => !found.some(a => a.permissionTypes?.includes(p)));
    return permissionTypes.length ? [{ ...grant, permissionTypes }] : [];
  });
}
function loadSetup(root, site) {
  if (!SITE_IDS.includes(site)) throw new Error('Unbekannter Standort.');
  const all = dataStore.readJson(path.join(root, 'site-setup.json'));
  const c = all.sites?.[site];
  if (all.schemaVersion !== 1 || !c || !/^[a-f0-9-]{36}$/.test(c.clusterId) || !/^[a-f0-9-]{36}$/.test(c.environmentId)) throw new Error('Standort-Konfiguration ungültig.');
  const url = new URL(c.runtimeBase);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.api.camunda.io') || url.pathname !== '/' + c.clusterId || url.search || url.hash || url.username || url.password) throw new Error('Runtime-Adresse passt nicht zum Cluster.');
  if (c.runtimeCredentialsFile !== `credentials_${site}_runtime.txt` || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.runtimeClientName)) throw new Error('Credential-Datei oder Clientname ungültig.');
  return { ...c, organizationId: loadAdminConfig(path.join(root, 'admin-config.json')).config.organizations[site] };
}

class SiteSetup {
  constructor({ root, organizationApiForSite, runtimeApiForSite, credentials = readCredentials, wait = delay }) {
    this.root = root; this.organizationApiForSite = organizationApiForSite; this.credentials = credentials;
    this.runtimeApiForSite = runtimeApiForSite || ((site, c) => new CamundaApi(credentials(path.join(root, c.runtimeCredentialsFile)), { freshReads: true }));
    this.busy = new Set();
    this.wait = wait;
  }
  receiptFile(site, action) { return path.join(this.root, `site-action-${site}-${action}.local.json`); }
  async inspect(site) {
    const c = loadSetup(this.root, site), checks = [], actions = [];
    const add = (id, label, state, detail, action, planned = []) => {
      const row = { id, label, state, detail, planned };
      if (action) { row.action = { id: action, label: LABELS[action] }; actions.push(action); }
      checks.push(row); return row;
    };
    const manualUrl = `https://hub.camunda.io/org/${c.organizationId}/cluster/${c.clusterId}`;
    const report = () => {
      for (const row of checks.filter(x => x.action)) {
        const filename = this.receiptFile(site, row.action.id);
        if (dataStore.exists(filename) && dataStore.readJson(filename).status !== 'verified') {
          actions.splice(actions.indexOf(row.action.id), 1); delete row.action;
          row.state = 'blocked'; row.detail += ' Vorheriger Anlageversuch noch nicht bestätigt; vor Wiederholung manuell nachprüfen.';
        }
      }
      return { site, clusterId: c.clusterId, organizationId: c.organizationId, checkedAt: new Date().toISOString(),
      status: checks.some(x => ['missing', 'blocked'].includes(x.state)) ? 'missing' : checks.some(x => x.state === 'unknown') ? 'unknown' : 'ready',
      checks, actions, hubUrl: manualUrl, adminUrl: c.runtimeBase + '/admin/authorizations',
      limitation: 'API-Rechte und Konfiguration ersetzen keinen praktischen Deployment-/Isolationstest mit einem Studierendenkonto.' };
    };
    const securityChecks = () => {
      let evidence;
      try { evidence = dataStore.readJson(path.join(this.root, 'site-flags.local.json')).sites?.[site]; } catch {}
      const age = Date.now() - Date.parse(evidence?.checkedAt);
      const fresh = evidence?.clusterId === c.clusterId && age >= -60000 && age < 15 * 60 * 1000;
      for (const [id, label, field] of [['authorization-check', 'Berechtigungsprüfung aktiviert', 'authorizations'], ['tenant-check', 'Multi-Tenancy-Prüfung aktiviert', 'multiTenancy']]) {
        const known = fresh && typeof evidence[field] === 'boolean';
        add(id, label, known ? evidence[field] ? 'ready' : 'missing' : 'unknown',
          (known ? (evidence[field] ? 'Aktiviert' : 'Deaktiviert') + ' · lesend im Hub bestätigt am ' + evidence.checkedAt + '. ' : 'Kein aktueller Hub-Nachweis (höchstens 15 Minuten alt). ') +
          'Dieser Schalter ist über den öffentlichen SaaS-API-Vertrag nicht prüf-/änderbar. „Alle Standorte prüfen“ aktualisiert nur API-Daten. Im Hub unter Settings kontrollieren.');
      }
    };
    const deferredRuntime = detail => {
      for (const [id, label] of [['role', 'Rolle Studierende'], ['student-grants', 'Operate, Tasklist, Deployment, Prozesse und Aufgaben'], ['client-grants', 'Technische Verwaltungsrechte'], ['support-access', 'Admin-/Technikzugriff und Rollenisolation']]) add(id, label, 'unknown', detail);
    };
    const api = this.organizationApiForSite(site);
    try {
      const info = await api.hub('/info');
      if (info.authorizedOrganization !== c.organizationId) throw new Error('Credentials gehören zu einer anderen Organisation.');
      add('organization', 'Organisationszugang', 'ready', 'Organisation eindeutig bestätigt.');
    } catch (e) { add('organization', 'Organisationszugang', 'blocked', e.message); securityChecks(); return { report: report() }; }
    try {
      const token = await api.token();
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const scopes = new Set(String(claims.scope || '').split(' '));
      const missing = SCOPES.filter(s => !scopes.has(s));
      add('scopes', 'Organisations-API-Berechtigungen', missing.length ? 'missing' : 'ready', missing.length ? 'Im Administration-API-Client ergänzen: ' + missing.join(', ') : 'Benötigte Scopes für Clusterlesen, Clientanlage, Hub-Struktur und Mitglieder enthalten. Schreibfähigkeit wird erst beim jeweiligen Aufruf bestätigt.');
    } catch { add('scopes', 'Organisations-API-Berechtigungen', 'unknown', 'Token-Scopes konnten nicht geprüft werden.'); }
    let cluster, clients;
    try {
      cluster = await api.console(`/clusters/${c.clusterId}`);
      if (cluster.uuid !== c.clusterId || cluster.ownerId !== c.organizationId) throw new Error('Cluster und Organisation stimmen nicht überein.');
      add('cluster', 'Cluster verfügbar', cluster.status?.ready === 'Healthy' ? 'ready' : 'blocked', `${cluster.name}: ${cluster.status?.ready || 'Unbekannt'}. ${cluster.generation?.name || ''}`);
      const env = await api.hub('/environments');
      const environment = env.items?.find(e => e.id === c.environmentId);
      add('environment', 'Hub-Environment', environment?.clusterId === c.clusterId ? 'ready' : 'blocked', environment?.clusterId === c.clusterId ? 'Konfiguriertes Environment gehört zum richtigen Cluster.' : 'Environment fehlt oder zeigt auf einen anderen Cluster.');
      clients = await api.console(`/clusters/${c.clusterId}/clients`);
      if (!Array.isArray(clients)) throw new Error('Clientliste unvollständig.');
    } catch (e) { add('cluster-access', 'Cluster-/Client-Inventar', 'unknown', e.message); securityChecks(); return { report: report() }; }
    const matches = clients.filter(x => x.name === c.runtimeClientName), file = path.join(this.root, c.runtimeCredentialsFile);
    const exists = fs.existsSync(file);
    if (matches.length !== 1 || !exists) {
      const canCreate = !matches.length && !exists;
      add('runtime-client', 'Onboarding-Client und lokale Zugangsdaten', canCreate ? 'missing' : 'blocked', canCreate ? `Eigener Client ${c.runtimeClientName} fehlt. Secret wird bei Anlage ausschließlich in ${c.runtimeCredentialsFile} gespeichert.` : 'Client/Datei fehlt, ist mehrdeutig oder passt nicht zusammen. Keine Rotation, kein Duplikat und kein Überschreiben.', canCreate ? 'create-client' : null);
      add('runtime', 'Runtime-Rolle, Freigaben und Tenant-Zugriffe', 'unknown', 'Erst nach Einrichtung eines gültigen Runtime-Zugangs prüfbar.');
      deferredRuntime('Ein gültiger Runtime-Zugang ist Voraussetzung.');
      securityChecks(); return { report: report(), config: c };
    }
    let creds;
    try {
      creds = this.credentials(file);
      if (creds.CAMUNDA_CLIENT_ID !== matches[0].clientId || creds.CAMUNDA_CLUSTER_ID !== c.clusterId || creds.CAMUNDA_REST_ADDRESS !== c.runtimeBase || !creds.CAMUNDA_CLIENT_SECRET) throw new Error('Lokale Runtime-Zugangsdaten passen nicht zum ermittelten Onboarding-Client.');
      add('runtime-client', 'Onboarding-Client und lokale Zugangsdaten', 'ready', 'Client, lokale Datei, Runtime-Adresse und Cluster-ID stimmen überein.');
    } catch (e) { add('runtime-client', 'Onboarding-Client und lokale Zugangsdaten', 'blocked', e.message); securityChecks(); return { report: report() }; }
    if (cluster.status?.ready !== 'Healthy') { add('runtime', 'Runtime-Verbindung', 'unknown', 'Pausierten Cluster im Live-Bereich über Play starten; alternativ im Hub starten.'); deferredRuntime('Cluster pausiert oder nicht bereit; diese Voraussetzung ist noch nicht prüfbar.'); securityChecks(); return { report: report() }; }
    const runtime = this.runtimeApiForSite(site, c);
    const request = (endpoint, options) => runtime.runtime(c.runtimeBase, endpoint, options);
    const search = (endpoint, filter) => runtimeSearch(runtime, c.runtimeBase, endpoint, filter);
    try { await request('/v2/authentication/me'); add('runtime', 'Runtime-Verbindung', 'ready', 'OAuth und authentifizierter Runtime-Aufruf erfolgreich.'); }
    catch (e) { add('runtime', 'Runtime-Verbindung', 'blocked', e.message); securityChecks(); return { report: report() }; }
    let role;
    try { role = await request('/v2/roles/' + ROLE); add('role', 'Rolle Studierende', 'ready', 'Rollen-ID studierende vorhanden.'); }
    catch (e) {
      if (e instanceof ApiError && e.status === 404) add('role', 'Rolle Studierende', 'missing', 'Rolle studierende fehlt.', 'create-role');
      else add('role', 'Rolle Studierende', 'unknown', e.message + ' Fehlende Leserechte sind kein Nachweis einer fehlenden Rolle.');
    }
    let studentAuth, clientAuth;
    try {
      studentAuth = await search('/v2/authorizations/search', { ownerType: 'ROLE', ownerId: ROLE });
      clientAuth = await search('/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: creds.CAMUNDA_CLIENT_ID });
      for (const [rows, type, id] of [[studentAuth, 'ROLE', ROLE], [clientAuth, 'CLIENT', creds.CAMUNDA_CLIENT_ID]]) if (rows.some(a => a.ownerType !== type || a.ownerId !== id || !Array.isArray(a.permissionTypes))) throw new Error('Authorization-Suchfilter wurde nicht bestätigt.');
      const unsafe = studentAuth.filter(a => a.resourceType === 'TENANT' || ['ROLE', 'GROUP', 'AUTHORIZATION', 'USER', 'SYSTEM'].includes(a.resourceType) || (a.resourceType === 'COMPONENT' && !['operate', 'tasklist'].includes(a.resourceId)));
      add('role-boundary', 'Studierendenrolle ohne Verwaltungs-/Tenantrechte', unsafe.length ? 'blocked' : 'ready', unsafe.length ? 'Unerwartete privilegierte Freigaben vorhanden. Vor weiterer Automatik manuell prüfen; nichts wird entfernt.' : 'Keine Tenant-, Admin- oder Komponenten-Verwaltungsfreigaben gefunden.');
      const studentMissing = missingGrants(studentAuth, desired('ROLE', ROLE, STUDENT_GRANTS));
      add('student-grants', 'Operate, Tasklist, Deployment, Prozesse und Aufgaben', studentMissing.length ? 'missing' : 'ready', studentMissing.length ? 'Fehlende Einzelrechte werden ergänzt; vorhandene Freigaben bleiben erhalten.' : 'Alle vorgesehenen Studierendenrechte vorhanden.', role && !unsafe.length && studentMissing.length ? 'student-grants' : null, studentMissing);
      const clientMissing = missingGrants(clientAuth, desired('CLIENT', creds.CAMUNDA_CLIENT_ID, CLIENT_GRANTS));
      add('client-grants', 'Technische Verwaltungsrechte', clientMissing.length ? 'missing' : 'ready', clientMissing.length ? 'Benötigt ROLE READ/UPDATE, GROUP/TENANT READ/CREATE/UPDATE, AUTHORIZATION READ/CREATE sowie Prozessinstanz-/Aufgaben-Leserechte für die Cleanup-Zählung. Kein DELETE und keine globale Adminrolle.' : 'Vorgesehene technischen Freigaben vorhanden.', clientMissing.length ? 'client-grants' : null, clientMissing);
    } catch (e) { add('authorizations', 'Runtime-Freigaben vollständig lesen', 'unknown', e.message + ' Ohne vollständige Leserechte keine automatische Anlage.'); }
    let supportMissing = [], tenants;
    try {
      await request('/v2/tenants/%3Cdefault%3E');
      for (const id of SUPPORT) await request('/v2/roles/' + id);
      tenants = await search('/v2/tenants/search');
      if (!tenants.some(t => t.tenantId === '<default>')) throw new Error('Default-Tenant fehlt in der Suchantwort.');
      for (const tenant of tenants) {
        const base = '/v2/tenants/' + encodeURIComponent(tenant.tenantId);
        const [roles, tenantClients] = await Promise.all([search(base + '/roles/search'), search(base + '/clients/search')]);
        if (roles.some(r => r.roleId === ROLE)) throw new Error('Die gemeinsame Studierendenrolle ist tenantgebunden. Dadurch könnten Gruppen fremde Tenants erben.');
        for (const id of SUPPORT) if (!roles.some(r => r.roleId === id)) supportMissing.push({ tenantId: tenant.tenantId, type: 'roles', id });
        if (!tenantClients.some(x => x.clientId === creds.CAMUNDA_CLIENT_ID)) supportMissing.push({ tenantId: tenant.tenantId, type: 'clients', id: creds.CAMUNDA_CLIENT_ID });
      }
      add('support-access', 'Admin-/Technikzugriff in bestehenden Tenants', supportMissing.length ? 'missing' : 'ready', supportMissing.length ? `${supportMissing.length} Zuordnungen fehlen. Erhält Zugriff für admin, connectors, app-integrations und den Onboarding-Client.` : `In allen ${tenants.length} gelesenen Tenants bestätigt.`, supportMissing.length && clientAuth ? 'support-access' : null, supportMissing);
    } catch (e) {
      const unsafe = e.message.includes('gemeinsame Studierendenrolle');
      add('support-access', 'Admin-/Technikzugriff und Rollenisolation', unsafe ? 'blocked' : 'unknown', e.message);
      if (unsafe) {
        const student = checks.find(x => x.id === 'student-grants');
        if (student?.action) { actions.splice(actions.indexOf(student.action.id), 1); delete student.action; }
      }
    }
    const groupFile = path.join(this.root, `onboarding-${site}.local.json`);
    if (dataStore.exists(groupFile)) {
      try {
        const groups = dataStore.readJson(groupFile).tenantGroups || [];
        if (groups.some(g => !/^[a-zA-Z0-9_.-]{1,31}$/.test(g.groupId) || !/^[a-zA-Z0-9_.-]{1,31}$/.test(g.tenantId))) throw new Error('Ungültige Gruppen-/Tenant-Zuordnung in lokaler Gruppenkonfiguration.');
        const problems = [];
        const roleGroups = await search('/v2/roles/' + ROLE + '/groups/search');
        for (const g of groups) {
          const tenantGroups = await search('/v2/tenants/' + encodeURIComponent(g.tenantId) + '/groups/search');
          const auth = await search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: g.groupId, resourceType: 'TENANT' });
          if (!roleGroups.some(r => r.groupId === g.groupId) || !tenantGroups.some(r => r.groupId === g.groupId) || !auth.some(a => a.ownerType === 'GROUP' && a.ownerId === g.groupId && a.resourceType === 'TENANT' && a.resourceId === g.tenantId && a.permissionTypes?.includes('READ')) || auth.some(a => a.permissionTypes?.includes('READ') && a.resourceId !== g.tenantId)) problems.push(g.groupId);
        }
        add('group-access', 'Konfigurierte Gruppen: Rolle und eigenes TENANT READ', problems.length ? 'blocked' : 'ready', problems.length ? 'Abweichung bei ' + problems.join(', ') + '. Über den getrennten Gruppenlauf prüfen; keine fremden Rechte automatisch entfernen.' : groups.length + ' konfigurierte Gruppen mit funktionaler Rolle und eigener Tenant-Lesefreigabe bestätigt.');
      } catch (e) { add('group-access', 'Konfigurierte Gruppen: Rolle und eigenes TENANT READ', 'unknown', e.message); }
    }
    securityChecks();
    return { report: report(), config: c, runtime, creds, studentMissing: studentAuth && missingGrants(studentAuth, desired('ROLE', ROLE, STUDENT_GRANTS)), clientMissing: clientAuth && missingGrants(clientAuth, desired('CLIENT', creds.CAMUNDA_CLIENT_ID, CLIENT_GRANTS)), supportMissing };
  }
  async all() {
    return Promise.all(SITE_IDS.map(async site => { try { return (await this.inspect(site)).report; } catch (e) { return { site, status: 'unknown', checkedAt: new Date().toISOString(), checks: [{ id: 'config', label: 'Standort-Konfiguration', state: 'blocked', detail: e.message }], actions: [] }; } }));
  }
  async apply(site, action) {
    if (!LABELS[action] || !SITE_IDS.includes(site)) throw new Error('Unbekannte Einrichtungsaktion.');
    if (this.busy.has(site)) throw new Error('Für diesen Standort läuft bereits eine Einrichtung.');
    this.busy.add(site);
    const lock = path.join(this.root, `site-lock-${site}.local.json`);
    let lockFd;
    try {
      try { lockFd = fs.openSync(lock, 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') throw new Error('Für diesen Standort ist bereits ein Einrichtungslauf reserviert.'); throw e; }
      const state = await this.inspect(site);
      if (!state.report.actions.includes(action)) throw new Error('Aktion ist nach erneuter Prüfung nicht erforderlich oder nicht sicher ausführbar.');
      const c = state.config, api = this.organizationApiForSite(site);
      if ((await api.hub('/info')).authorizedOrganization !== c.organizationId) throw new Error('Organisation hat sich geändert.');
      const receipt = { site, action, status: 'pending', startedAt: new Date().toISOString() };
      dataStore.writeJson(this.receiptFile(site, action), receipt);
      let attempted = 0;
      if (action === 'create-client') {
        const file = path.join(this.root, c.runtimeCredentialsFile);
        const clients = await api.console(`/clusters/${c.clusterId}/clients`);
        if (clients.some(x => x.name === c.runtimeClientName)) throw new Error('Client existiert inzwischen. Keine doppelte Anlage.');
        const fd = fs.openSync(file, 'wx', 0o600);
        // Keep the reserved file on any ambiguous result; never repeat a potentially successful create.
        try {
          attempted++;
          const client = await api.console(`/clusters/${c.clusterId}/clients`, { method: 'POST', body: { clientName: c.runtimeClientName, permissions: ['Zeebe'] } });
          if (!client.clientId || !client.clientSecret) throw new Error('Client-Ergebnis enthält keine vollständigen Zugangsdaten; Anlage nicht wiederholen.');
          const entries = { CAMUNDA_CLIENT_ID: client.clientId, CAMUNDA_CLIENT_SECRET: client.clientSecret, CAMUNDA_CLUSTER_ID: c.clusterId, CAMUNDA_REST_ADDRESS: c.runtimeBase, CAMUNDA_OAUTH_URL: 'https://login.cloud.camunda.io/oauth/token', CAMUNDA_TOKEN_AUDIENCE: client.audience || 'zeebe.camunda.io' };
          if (Object.values(entries).some(v => /[\r\n]/.test(v))) throw new Error('Unerwartetes Credential-Format.');
          fs.writeFileSync(fd, Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
        } finally { fs.closeSync(fd); }
      } else {
        const call = (endpoint, options) => state.runtime.runtime(c.runtimeBase, endpoint, options);
        if (action === 'create-role') { attempted++; await call('/v2/roles', { method: 'POST', body: { roleId: ROLE, name: 'Studierende', description: 'Unterricht: Modell-Deployment, Prozesse und Aufgaben; Tenant-Zugriff ausschließlich über eigene Gruppe.' } }); }
        else if (['student-grants', 'client-grants'].includes(action)) {
          for (const body of action === 'student-grants' ? state.studentMissing : state.clientMissing) { attempted++; await call('/v2/authorizations', { method: 'POST', body }); }
        } else {
          for (const row of state.supportMissing) { attempted++; await call(`/v2/tenants/${encodeURIComponent(row.tenantId)}/${row.type}/${encodeURIComponent(row.id)}`, { method: 'PUT' }); }
        }
      }
      const target = action === 'create-client' ? 'runtime-client' : action === 'create-role' ? 'role' : action;
      let after, verified = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await this.wait(attempt === 1 ? 500 : 1500);
        after = (await this.inspect(site)).report;
        verified = after.checks.find(x => x.id === target)?.state === 'ready';
        if (verified) break;
      }
      if (verified) dataStore.writeJson(this.receiptFile(site, action), { ...receipt, status: 'verified', verifiedAt: new Date().toISOString() });
      return { site, action, attempted, verified, message: verified ? 'Änderung anschließend lesend bestätigt.' : 'Aufrufe angenommen; Ergebnis noch nicht vollständig lesend bestätigt. Nicht automatisch wiederholen.', report: after };
    } finally {
      if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
      this.busy.delete(site);
    }
  }
}
module.exports = { SiteSetup, loadSetup, missingGrants, STUDENT_GRANTS, CLIENT_GRANTS, SCOPES };
