const { searchAll } = require('./onboarding');
const { runtimeSearch } = require('./tenancy');

// This entry point can only read; POST is allowed solely for documented search endpoints.
function readOnly(api) {
  const wrap = method => (endpoint, options = {}) => {
    if (options.method && options.method !== 'GET' && !(options.method === 'POST' && endpoint.endsWith('/search'))) throw new Error('Cleanup-Analyse erlaubt nur Lesezugriffe.');
    return api[method](endpoint, options);
  };
  return { console: wrap('console'), hub: wrap('hub') };
}

const emailOf = member => String(member.email || member.username || '').trim().toLowerCase();

async function analyzeCleanup({ organizationApi, runtimeApi, runtimeBase, runtimeRole = 'studierende', expectedOrganization, protectedEmails = [] }) {
  const api = readOnly(organizationApi);
  const info = await api.hub('/info');
  if (expectedOrganization && info.authorizedOrganization !== expectedOrganization) throw new Error('Die Credentials gehören nicht zur erwarteten Organisation.');
  const members = await api.console('/members');
  if (!Array.isArray(members)) throw new Error('Unerwartete Organisationsmitglieder-Antwort.');
  const warnings = [];
  const workspaces = await searchAll(api, '/workspaces/search');
  const workspaceInventory = await Promise.all(workspaces.map(async workspace => {
    const result = { id: workspace.workspaceKey, name: workspace.name, members: null, projects: null };
    const parts = await Promise.allSettled([
      searchAll(api, '/members/search', { workspaceKey: { $eq: workspace.workspaceKey } }),
      searchAll(api, '/projects/search', { workspaceKey: { $eq: workspace.workspaceKey } }),
    ]);
    if (parts[0].status === 'fulfilled') result.members = parts[0].value.map(m => ({ email: emailOf(m), role: m.role }));
    else warnings.push(`Mitglieder von Workspace „${workspace.name}“ konnten nicht geprüft werden.`);
    if (parts[1].status === 'fulfilled') result.projects = parts[1].value.map(p => ({ id: p.projectKey, name: p.name }));
    else warnings.push(`Projekte von Workspace „${workspace.name}“ konnten nicht geprüft werden.`);
    return result;
  }));

  let runtime = { available: false, groups: [], tenants: [], studentUsers: [], studentGroups: [] };
  if (runtimeApi && runtimeBase) {
    try {
      const search = (endpoint) => runtimeSearch(runtimeApi, runtimeBase, endpoint);
      const [groups, tenants, studentUsers, studentGroups] = await Promise.all([
        search('/v2/groups/search'), search('/v2/tenants/search'),
        search(`/v2/roles/${encodeURIComponent(runtimeRole)}/users/search`),
        search(`/v2/roles/${encodeURIComponent(runtimeRole)}/groups/search`),
      ]);
      // Search results can be filtered by permissions. Check the configured role and default tenant directly.
      await runtimeApi.runtime(runtimeBase, `/v2/roles/${encodeURIComponent(runtimeRole)}`);
      await runtimeApi.runtime(runtimeBase, '/v2/tenants/%3Cdefault%3E');
      const groupInventory = await Promise.all(groups.map(async g => ({
        id: g.groupId, name: g.name,
        users: (await search(`/v2/groups/${encodeURIComponent(g.groupId)}/users/search`)).map(emailOf),
      })));
      const tenantInventory = await Promise.all(tenants.map(async t => {
        const base = `/v2/tenants/${encodeURIComponent(t.tenantId)}`;
        const [tenantGroups, users, roles, clients, mappings] = await Promise.all(['groups', 'users', 'roles', 'clients', 'mapping-rules'].map(type => search(`${base}/${type}/search`)));
        return { id: t.tenantId, name: t.name, system: t.tenantId === '<default>', groupIds: tenantGroups.map(g => g.groupId), users: users.map(emailOf), roleIds: roles.map(r => r.roleId), clientIds: clients.map(c => c.clientId), mappingRuleCount: mappings.length, runtimeData: 'not_checked' };
      }));
      const otherRoles = await search('/v2/roles/search');
      const extraRoles = await Promise.all(otherRoles.filter(r => r.roleId !== runtimeRole).map(async r => ({
        id: r.roleId,
        users: (await search(`/v2/roles/${encodeURIComponent(r.roleId)}/users/search`)).map(emailOf),
        groups: (await search(`/v2/roles/${encodeURIComponent(r.roleId)}/groups/search`)).map(g => g.groupId),
      })));
      runtime = { available: true, groups: groupInventory, tenants: tenantInventory, studentUsers: studentUsers.map(emailOf), studentGroups: studentGroups.map(g => g.groupId), extraRoles };
    } catch {
      warnings.push('Runtime-Zuordnungen konnten nicht vollständig gelesen werden. Studierenden-Zuordnungen bleiben ungeklärt; fehlende Ergebnisse gelten nicht als leere Gruppen oder Tenants.');
    }
  } else warnings.push('Für diesen Standort ist noch kein Runtime-Zugang für die Analyse konfiguriert.');

  const students = new Set(runtime.studentUsers);
  for (const group of runtime.groups) if (runtime.studentGroups.includes(group.id)) for (const email of group.users) students.add(email);
  const people = members.map(member => {
    const email = emailOf(member);
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const groupIds = runtime.groups.filter(g => g.users.includes(email)).map(g => g.id);
    const additionalRuntimeRoles = (runtime.extraRoles || []).filter(r => r.users.includes(email) || r.groups.some(g => groupIds.includes(g))).map(r => r.id);
    const protectedAccount = protectedEmails.some(e => e.toLowerCase() === email) || roles.some(role => !['member', 'modeler'].includes(role)) || additionalRuntimeRoles.length > 0;
    const tenantIds = runtime.tenants.filter(t => t.users.includes(email) || t.groupIds.some(id => groupIds.includes(id))).map(t => t.id);
    return { email, name: member.name || '', organizationRoles: roles, pending: Boolean(member.invitePending),
      classification: protectedAccount ? 'protected' : students.has(email) ? 'student' : 'review',
      evidence: students.has(email) ? `Runtime-Rolle ${runtimeRole}, direkt oder über Gruppe` : 'Keine bestätigte Studierenden-Zuordnung',
      groupIds, tenantIds, additionalRuntimeRoles, workspaceIds: workspaceInventory.filter(w => w.members?.some(m => m.email === email)).map(w => w.id),
    };
  });
  for (const workspace of workspaceInventory) {
    workspace.studentEmails = workspace.members?.filter(m => people.some(p => p.email === m.email && p.classification === 'student')).map(m => m.email) ?? null;
    workspace.otherMemberEmails = workspace.members?.filter(m => !workspace.studentEmails.includes(m.email)).map(m => m.email) ?? null;
  }
  return { checkedAt: new Date().toISOString(), organizationId: info.authorizedOrganization, readOnly: true, deletionEnabled: false,
    summary: { totalMembers: people.length, students: people.filter(p => p.classification === 'student').length, review: people.filter(p => p.classification === 'review').length, protected: people.filter(p => p.classification === 'protected').length, pendingInvitations: people.filter(p => p.pending).length, workspaces: workspaceInventory.length },
    people, workspaces: workspaceInventory, runtime, warnings,
    limitations: ['Studierenden-Zuordnung ist keine Löschfreigabe. Gemeinsam genutzte Inhalte müssen separat geprüft werden.', 'Instanzen, Aufgaben und Runtime-Gruppen werden für die ausgewählten Tenants in der Löschvorschau gezählt. Prozessdefinitionen bleiben erhalten.', 'Weitere über Rollen oder Mapping-Regeln geerbte Tenant-Zugriffe sind nicht vollständig ermittelt.', 'Workspace und Tenant haben keine hier nachgewiesene feste Eins-zu-eins-Zuordnung.'],
  };
}

module.exports = { analyzeCleanup };
