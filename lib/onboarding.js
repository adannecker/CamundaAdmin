const { ApiError } = require('./camunda-api');

function validateConfig(input) {
  const config = { ...input };
  for (const field of ['workspaceName', 'expectedOrganization', 'adminEmail', 'studentEmail', 'environmentId', 'runtimeBase']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`${field} fehlt.`);
    config[field] = config[field].trim();
  }
  for (const field of ['adminEmail', 'studentEmail']) {
    config[field] = config[field].toLowerCase();
    if (!/^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(config[field])) throw new Error(`${field} ist ungültig.`);
  }
  if (config.adminEmail === config.studentEmail) throw new Error('Admin und Testbenutzer müssen verschieden sein.');
  if (!Array.isArray(config.projects) || !config.projects.length || config.projects.length > 20) throw new Error('1 bis 20 Projektnamen erforderlich.');
  config.projects = config.projects.map(name => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255) throw new Error('Ungültiger Projektname.');
    return name.trim();
  });
  if (new Set(config.projects).size !== config.projects.length) throw new Error('Projektnamen müssen eindeutig sein.');
  if (config.workspaceName.length > 255) throw new Error('Workspace-Name ist zu lang.');
  config.runtimeRole = config.runtimeRole || 'studierende';
  if (!/^[a-zA-Z0-9_-]+$/.test(config.runtimeRole)) throw new Error('Ungültige Runtime-Rollen-ID.');
  const runtime = new URL(config.runtimeBase);
  if (runtime.protocol !== 'https:' || !runtime.hostname.endsWith('.api.camunda.io') || !/^\/[a-f0-9-]{36}$/.test(runtime.pathname) || runtime.search || runtime.hash || runtime.username || runtime.password) throw new Error('runtimeBase muss auf einen Camunda-SaaS-Cluster zeigen.');
  config.runtimeBase = runtime.origin + runtime.pathname;
  return config;
}

async function searchAll(api, endpoint, filter) {
  const items = [];
  for (let from = 0; from < 10000; from += 100) {
    const result = await api.hub(endpoint, { method: 'POST', body: { filter, page: { from, limit: 100 } } });
    if (!Array.isArray(result.items)) throw new Error(`${endpoint}: unerwartete Suchantwort.`);
    items.push(...result.items);
    if (result.items.length < 100 || (!result.page?.hasMoreTotalItems && items.length >= Number(result.page?.totalItems))) return items;
  }
  throw new Error(`${endpoint}: Suchlimit erreicht; keine Änderungen ausgeführt.`);
}

function uniqueMatch(items, description) {
  if (items.length > 1) throw new Error(`${description} ist mehrfach vorhanden. Keine automatische Auswahl.`);
  return items[0] || null;
}

class Onboarding {
  constructor(api, config, runtimeApi = null) {
    this.api = api;
    this.config = validateConfig(config);
    this.runtimeApi = runtimeApi;
  }

  async inspect() {
    const c = this.config;
    const info = await this.api.hub('/info');
    if (info.authorizedOrganization !== c.expectedOrganization) throw new Error('Die Credentials gehören nicht zur erwarteten Organisation.');
    const orgMembers = await this.api.console('/members');
    if (!Array.isArray(orgMembers)) throw new Error('Unerwartete Organisationsmitglieder-Antwort.');
    const admin = orgMembers.find(member => member.email?.toLowerCase() === c.adminEmail);
    if (!admin || !admin.roles?.some(role => ['admin', 'owner'].includes(role))) throw new Error('Der gewünschte Workspace-Admin ist kein bestehender Organisationsadmin.');
    const student = orgMembers.find(member => member.email?.toLowerCase() === c.studentEmail) || null;
    if (student?.roles?.some(role => !['member', 'modeler'].includes(role))) throw new Error('Der Testbenutzer hat weitere Organisationsrollen. Keine automatische Änderung dieser Rollen.');
    const environments = await this.api.hub('/environments');
    const environment = environments.items?.find(item => item.id === c.environmentId);
    if (!environment || !c.runtimeBase.endsWith('/' + environment.clusterId)) throw new Error('Environment und Runtime-Cluster passen nicht zusammen.');
    const workspace = uniqueMatch(await searchAll(this.api, '/workspaces/search', { name: { $eq: c.workspaceName } }), 'Workspace-Name');
    let projects = [], members = [], assignedEnvironments = [];
    if (workspace) {
      projects = await searchAll(this.api, '/projects/search', { workspaceKey: { $eq: workspace.workspaceKey } });
      members = await searchAll(this.api, '/members/search', { workspaceKey: { $eq: workspace.workspaceKey } });
      assignedEnvironments = (await this.api.hub(`/workspaces/${encodeURIComponent(workspace.workspaceKey)}/environments`)).items;
      for (const name of c.projects) uniqueMatch(projects.filter(project => project.name === name), `Projekt ${name}`);
    }
    return { workspace, projects, members, assignedEnvironments, student, environment };
  }

  async plan() {
    const state = await this.inspect();
    const c = this.config;
    const plan = {
      organization: c.expectedOrganization,
      workspace: { name: c.workspaceName, key: state.workspace?.workspaceKey || null, action: state.workspace ? 'reuse' : 'create' },
      projects: c.projects.map(name => ({ name, action: state.projects.some(project => project.name === name) ? 'reuse' : 'create' })),
      admin: { email: c.adminEmail, workspaceRole: 'workspace_admin' },
      student: { email: c.studentEmail, organizationRole: 'Member', apiOrganizationRole: 'modeler', invitePending: state.student?.invitePending || false, invitationNeeded: !state.student, workspaceRole: 'editor', runtimeRole: c.runtimeRole },
      environment: { id: state.environment.id, name: state.environment.name, state: state.environment.runtimeState },
      runtime: { ready: false, message: 'Runtime-Credentials fehlen.' },
    };
    if (this.runtimeApi) {
      try {
        await this.runtimeApi.runtime(c.runtimeBase, `/v2/roles/${encodeURIComponent(c.runtimeRole)}`);
        plan.runtime = { ready: true, message: 'Rolle lesend erreichbar; Schreibrecht wird beim Zuweisen verifiziert.' };
      } catch (error) { plan.runtime.message = error.message; }
    }
    return plan;
  }

  // Only structure and existing admin access. No student invitation or assignment.
  async ensureStructure() {
    const c = this.config;
    const state = await this.inspect();
    let workspace = state.workspace;
    if (!workspace) workspace = await this.api.hub('/workspaces', { method: 'POST', body: { name: c.workspaceName } });
    if (!workspace.workspaceKey) throw new Error('Workspace-Ergebnis enthält keinen Schlüssel.');
    const key = workspace.workspaceKey;
    const base = `/workspaces/${encodeURIComponent(key)}`;
    const results = [];
    for (const name of c.projects) {
      let project = uniqueMatch(await searchAll(this.api, '/projects/search', { workspaceKey: { $eq: key }, name: { $eq: name } }), `Projekt ${name}`);
      if (!project) project = await this.api.hub('/projects', { method: 'POST', body: { name, workspaceKey: key } });
      if (!project.projectKey || project.workspaceKey !== key) throw new Error('Unerwartetes Projekt-Ergebnis.');
      results.push({ name: project.name, key: project.projectKey });
    }
    const members = await searchAll(this.api, '/members/search', { workspaceKey: { $eq: key } });
    if (!members.some(member => member.email?.toLowerCase() === c.adminEmail && member.role === 'workspace_admin')) {
      await this.api.hub(`${base}/members`, { method: 'POST', body: { email: c.adminEmail, role: 'workspace_admin' } });
    }
    const currentEnvironments = await this.api.hub(`${base}/environments`);
    const ids = currentEnvironments.items.map(item => item.id);
    if (!ids.includes(c.environmentId)) await this.api.hub(`${base}/environments`, { method: 'PUT', body: { environmentIds: [...ids, c.environmentId] } });
    const verified = await this.inspect();
    if (!verified.members.some(member => member.email?.toLowerCase() === c.adminEmail && member.role === 'workspace_admin') || !verified.assignedEnvironments.some(item => item.id === c.environmentId)) throw new Error('Struktur wurde erstellt, konnte aber noch nicht vollständig nachgeprüft werden. Erneut prüfen, keine Duplikate anlegen.');
    return { workspace: { name: workspace.name, key }, projects: results, admin: c.adminEmail, environment: c.environmentId, url: `https://hub.camunda.io/workspaces/${key}/projects` };
  }

  async ensureHubAccess() {
    const c = this.config;
    const state = await this.inspect();
    if (!state.workspace || c.projects.some(name => !state.projects.some(project => project.name === name))) throw new Error('Zuerst die Workspace-/Projektstruktur anlegen.');
    let student = state.student;
    if (!student || !student.roles?.some(role => ['member', 'modeler'].includes(role))) {
      await this.api.console(`/members/${encodeURIComponent(c.studentEmail)}`, { method: 'POST', body: { orgRoles: ['modeler'] } });
      // A successful invitation response may precede its visibility in member reads.
      student = (await this.api.console('/members')).find(member => member.email?.toLowerCase() === c.studentEmail);
    }
    const existing = state.members.find(member => member.email?.toLowerCase() === c.studentEmail);
    if (existing && existing.role !== 'editor') throw new Error('Der Testbenutzer hat bereits eine andere Workspace-Rolle. Keine automatische Änderung.');
    if (!existing && (!student || student.invitePending)) {
      return { email: c.studentEmail, organizationRole: 'Member', workspaceRole: null, requestedWorkspaceRole: 'editor', status: student ? 'awaiting_invitation_acceptance' : 'invitation_submitted_awaiting_visibility' };
    }
    if (!existing) {
      try {
        await this.api.hub(`/workspaces/${encodeURIComponent(state.workspace.workspaceKey)}/members`, { method: 'POST', body: { email: c.studentEmail, role: 'editor' } });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 400) throw error;
        // SaaS v2 currently rejects this documented request with HTTP 400.
        // Reconcile before using the supported v1 compatibility API (removal: 8.12).
        const current = (await searchAll(this.api, '/members/search', { workspaceKey: { $eq: state.workspace.workspaceKey } })).find(member => member.email?.toLowerCase() === c.studentEmail);
        if (current && current.role !== 'editor') throw new Error('Workspace-Rolle wurde zwischenzeitlich geändert. Keine automatische Änderung.');
        if (!current) await this.api.request('https://hub.camunda.io', '/api/v1/collaborators', { method: 'PUT', body: { email: c.studentEmail, projectId: state.workspace.workspaceKey, role: 'editor' } });
      }
      const members = await searchAll(this.api, '/members/search', { workspaceKey: { $eq: state.workspace.workspaceKey } });
      if (!members.some(member => member.email?.toLowerCase() === c.studentEmail && member.role === 'editor')) throw new Error('Workspace-Zuweisung gesendet, aber noch nicht lesend bestätigt. Vor erneutem Schreiben den Ist-Zustand prüfen.');
    }
    return { email: c.studentEmail, organizationRole: 'Member', workspaceRole: 'editor', status: 'assigned' };
  }

  async ensureRuntimeAccess() {
    if (!this.runtimeApi) throw new Error('Runtime-Credentials fehlen.');
    const c = this.config;
    await this.inspect();
    const rolePath = `/v2/roles/${encodeURIComponent(c.runtimeRole)}`;
    await this.runtimeApi.runtime(c.runtimeBase, rolePath);
    try {
      await this.runtimeApi.runtime(c.runtimeBase, `${rolePath}/users/${encodeURIComponent(c.studentEmail)}`, { method: 'PUT' });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
    }
    // The assignment PUT is strongly consistent; do not require broad user-search rights.
    return { email: c.studentEmail, role: c.runtimeRole, status: 'assigned' };
  }
}

module.exports = { Onboarding, validateConfig, searchAll };
