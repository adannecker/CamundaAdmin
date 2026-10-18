const { ApiError } = require('./camunda-api');

async function runtimeSearch(api, base, endpoint, filter) {
  const result = [];
  for (let from = 0; from < 10000; from += 100) {
    const page = await api.runtime(base, endpoint, { method: 'POST', body: { ...(filter ? { filter } : {}), page: { from, limit: 100 } } });
    if (!Array.isArray(page.items)) throw new Error(`${endpoint}: Unerwartete Suchantwort.`);
    result.push(...page.items);
    if (page.items.length < 100 || page.page?.hasMoreTotalItems === false) return result;
  }
  throw new Error(`${endpoint}: Suchlimit erreicht.`);
}

function validateTenancy(config) {
  const groups = config.tenantGroups;
  if (!Array.isArray(groups) || groups.length !== 2) throw new Error('Genau zwei tenantGroups erforderlich.');
  for (const group of groups) {
    for (const field of ['tenantId', 'groupId']) {
      if (typeof group[field] !== 'string' || !/^[a-zA-Z0-9_.-]{1,31}$/.test(group[field])) throw new Error(`Ungültige ${field}.`);
    }
    if (typeof group.name !== 'string' || !group.name.trim()) throw new Error('Gruppenname fehlt.');
  }
  if (new Set(groups.map(g => g.tenantId)).size !== 2 || new Set(groups.map(g => g.groupId)).size !== 2) throw new Error('Tenant- und Gruppen-IDs müssen eindeutig sein.');
  if (!groups.some(g => g.groupId === config.studentGroupId)) throw new Error('studentGroupId fehlt in tenantGroups.');
  if (!config.runtimeClientId) throw new Error('Runtime-Client-ID fehlt.');
}

class TenancySetup {
  constructor(onboarding, runtimeApi, runtimeClientId) {
    this.onboarding = onboarding;
    this.api = runtimeApi;
    this.config = { ...onboarding.config, runtimeClientId };
    validateTenancy(this.config);
  }

  request(endpoint, options) { return this.api.runtime(this.config.runtimeBase, endpoint, options); }
  search(endpoint, filter) { return runtimeSearch(this.api, this.config.runtimeBase, endpoint, filter); }

  tenantReadAuthorization(group) {
    return { ownerType: 'GROUP', ownerId: group.groupId, resourceType: 'TENANT', resourceId: group.tenantId, permissionTypes: ['READ'] };
  }

  hasTenantRead(authorizations, group) {
    return authorizations.some(a => a.ownerType === 'GROUP' && a.ownerId === group.groupId && a.resourceType === 'TENANT' && a.resourceId === group.tenantId && a.permissionTypes?.includes('READ'));
  }

  async memberships(tenantId) {
    const base = `/v2/tenants/${encodeURIComponent(tenantId)}`;
    const state = {};
    for (const type of ['roles', 'groups', 'users', 'clients', 'mapping-rules']) state[type] = await this.search(`${base}/${type}/search`);
    return state;
  }

  async inspect() {
    const config = this.config;
    const hub = await this.onboarding.inspect();
    if (!hub.student || hub.student.invitePending) throw new Error('Testbenutzer muss ein aktiver Organisations-Member sein.');
    const tenants = await this.search('/v2/tenants/search');
    const groups = await this.search('/v2/groups/search');
    // A filtered empty search does not prove sufficient access; verify the known default directly.
    await this.request('/v2/tenants/%3Cdefault%3E');
    const memberships = {};
    const groupMembers = {};
    const tenantAuthorizations = {};
    // Read before any writes: missing AUTHORIZATION READ must not look like a missing grant.
    for (const group of config.tenantGroups) {
      let authorizations;
      try { authorizations = await this.search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: group.groupId, resourceType: 'TENANT' }); }
      catch (error) {
        if (error instanceof ApiError && error.status === 403) throw new ApiError('Runtime-Client benötigt READ auf AUTHORIZATION (*) zur Prüfung der Tenant-Freigaben', 403);
        throw error;
      }
      if (authorizations.some(a => a.ownerType !== 'GROUP' || a.ownerId !== group.groupId || a.resourceType !== 'TENANT' || !Array.isArray(a.permissionTypes))) throw new Error('Unerwartete Tenant-Authorization-Suchantwort.');
      if (authorizations.some(a => a.permissionTypes.includes('READ') && a.resourceId !== group.tenantId)) throw new Error(`Gruppe ${group.groupId} hat TENANT READ auf einen fremden Tenant oder *. Keine automatische Änderung.`);
      if (authorizations.some(a => a.resourceId === group.tenantId) && !this.hasTenantRead(authorizations, group)) throw new Error(`Vorhandene Tenant-Freigabe für ${group.groupId} enthält kein READ. Bestehende Rechte vor einer Änderung manuell prüfen.`);
      tenantAuthorizations[group.groupId] = authorizations;
    }
    for (const tenant of tenants) memberships[tenant.tenantId] = await this.memberships(tenant.tenantId);
    for (const group of groups) groupMembers[group.groupId] = await this.search(`/v2/groups/${encodeURIComponent(group.groupId)}/users/search`);
    for (const desired of config.tenantGroups) {
      const tenant = tenants.find(t => t.tenantId === desired.tenantId);
      const group = groups.find(g => g.groupId === desired.groupId);
      if ((tenant && tenant.name !== desired.name) || (group && group.name !== desired.name)) throw new Error(`ID ${desired.groupId} ist bereits anders belegt.`);
    }
    const targetTenant = config.tenantGroups.find(g => g.groupId === config.studentGroupId).tenantId;
    const studentGroups = groups.filter(group => groupMembers[group.groupId].some(user => user.username === config.studentEmail)).map(group => group.groupId);
    if (studentGroups.some(id => id !== config.studentGroupId)) throw new Error('Testbenutzer gehört bereits zu einer weiteren Runtime-Gruppe. Keine automatische Entfernung.');
    for (const tenant of tenants) {
      const member = memberships[tenant.tenantId];
      if (member.roles.some(r => r.roleId === config.runtimeRole)) throw new Error('Die gemeinsame Studierendenrolle ist einem Tenant zugeordnet. Erst die dadurch vererbten Zugriffe prüfen.');
      if (tenant.tenantId !== targetTenant && (member.users.some(u => u.username === config.studentEmail) || member.groups.some(g => studentGroups.includes(g.groupId)))) throw new Error('Testbenutzer hat bereits Zugriff auf einen fremden Tenant. Keine automatische Entfernung.');
      if (member['mapping-rules'].length) throw new Error('Vorhandene Tenant-Mapping-Regeln erfordern eine zusätzliche Zugriffsprüfung.');
    }
    return { tenants, groups, memberships, groupMembers, tenantAuthorizations };
  }

  async plan() {
    const state = await this.inspect();
    return {
      groups: this.config.tenantGroups.map(g => ({ ...g, createTenant: !state.tenants.some(t => t.tenantId === g.tenantId), createGroup: !state.groups.some(t => t.groupId === g.groupId), tenantReadAuthorization: { ...this.tenantReadAuthorization(g), create: !this.hasTenantRead(state.tenantAuthorizations[g.groupId], g) } })),
      studentGroupId: this.config.studentGroupId,
      tenantRoles: ['admin', 'connectors', 'app-integrations'],
      activation: 'manual_only',
    };
  }

  async assign(endpoint) {
    try { await this.request(endpoint, { method: 'PUT' }); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 409) throw error; }
  }

  async prepare({ includeSupportAccess = false } = {}) {
    const config = this.config;
    const state = await this.inspect();
    const segment = encodeURIComponent;
    for (const group of config.tenantGroups) {
      if (!state.tenants.some(t => t.tenantId === group.tenantId)) await this.request('/v2/tenants', { method: 'POST', body: { tenantId: group.tenantId, name: group.name, description: 'Managed by CamundaCleanup tenant setup.' } });
      if (!state.groups.some(g => g.groupId === group.groupId)) await this.request('/v2/groups', { method: 'POST', body: { groupId: group.groupId, name: group.name, description: 'Managed by CamundaCleanup tenant setup.' } });
      if (!this.hasTenantRead(state.tenantAuthorizations[group.groupId], group)) {
        try { await this.request('/v2/authorizations', { method: 'POST', body: this.tenantReadAuthorization(group) }); }
        catch (error) {
          if (error instanceof ApiError && error.status === 403) throw new ApiError('Runtime-Client benötigt CREATE auf AUTHORIZATION (*) zum Anlegen der Tenant-Lesefreigabe', 403);
          throw error;
        }
      }
      const member = state.memberships[group.tenantId];
      if (!member?.groups.some(g => g.groupId === group.groupId)) await this.assign(`/v2/tenants/${segment(group.tenantId)}/groups/${segment(group.groupId)}`);
      // Grant the functional role to each group, never grant a tenant to the shared role.
      const roleGroups = await this.search(`/v2/roles/${segment(config.runtimeRole)}/groups/search`);
      if (!roleGroups.some(g => g.groupId === group.groupId)) await this.assign(`/v2/roles/${segment(config.runtimeRole)}/groups/${segment(group.groupId)}`);
    }
    if (!state.groupMembers[config.studentGroupId]?.some(u => u.username === config.studentEmail)) await this.assign(`/v2/groups/${segment(config.studentGroupId)}/users/${segment(config.studentEmail)}`);
    return includeSupportAccess ? this.prepareSupportAccess() : this.verify({ includeSupportAccess: false });
  }

  async prepareSupportAccess() {
    await this.requireSupportRoleRead();
    await this.verify({ includeSupportAccess: false });
    const config = this.config;
    const state = await this.inspect();
    const segment = encodeURIComponent;
    // Preserve access to old data and to the new tenants for admins and built-in runtimes.
    for (const tenantId of ['<default>', ...config.tenantGroups.map(g => g.tenantId)]) {
      const member = state.memberships[tenantId];
      for (const roleId of ['admin', 'connectors', 'app-integrations']) {
        if (!member?.roles.some(r => r.roleId === roleId)) await this.assign(`/v2/tenants/${segment(tenantId)}/roles/${segment(roleId)}`);
      }
      if (!member?.clients.some(c => c.clientId === config.runtimeClientId)) await this.assign(`/v2/tenants/${segment(tenantId)}/clients/${segment(config.runtimeClientId)}`);
    }
    return this.verify();
  }

  async requireSupportRoleRead() {
    // Tenant role searches silently filter roles the client cannot read.
    // Check exact objects so an empty result never triggers blind reassignment.
    for (const roleId of ['admin', 'connectors', 'app-integrations']) await this.request(`/v2/roles/${encodeURIComponent(roleId)}`);
  }

  async verify({ includeSupportAccess = true } = {}) {
    if (includeSupportAccess) await this.requireSupportRoleRead();
    const config = this.config;
    const state = await this.inspect();
    const roleGroups = await this.search(`/v2/roles/${encodeURIComponent(config.runtimeRole)}/groups/search`);
    for (const group of config.tenantGroups) {
      const member = state.memberships[group.tenantId];
      if (!state.groups.some(g => g.groupId === group.groupId) || !member?.groups.some(g => g.groupId === group.groupId) || !roleGroups.some(g => g.groupId === group.groupId)) throw new Error('Tenant-/Gruppenzuweisung noch nicht vollständig lesend bestätigt.');
      if (!this.hasTenantRead(state.tenantAuthorizations[group.groupId], group)) throw new Error('TENANT READ auf den eigenen Tenant noch nicht lesend bestätigt.');
    }
    if (!state.groupMembers[config.studentGroupId]?.some(user => user.username === config.studentEmail)) throw new Error('Testbenutzer-Mitgliedschaft noch nicht lesend bestätigt.');
    let supportVerified = true;
    for (const tenantId of ['<default>', ...config.tenantGroups.map(g => g.tenantId)]) {
      const member = state.memberships[tenantId];
      if (!member || !['admin', 'connectors', 'app-integrations'].every(id => member.roles.some(role => role.roleId === id)) || !member.clients.some(client => client.clientId === config.runtimeClientId)) supportVerified = false;
    }
    if (includeSupportAccess && !supportVerified) throw new Error('Admin-/Client-Zugriff noch nicht vollständig lesend bestätigt.');
    return { prepared: true, readyToActivate: supportVerified, activation: 'manual_only', effectiveIsolationTest: 'pending_after_activation', student: config.studentEmail, studentGroupId: config.studentGroupId, groups: config.tenantGroups, tenantReadAuthorizationsVerified: true, adminAndTechnicalAccessVerified: supportVerified };
  }
}

module.exports = { TenancySetup, runtimeSearch, validateTenancy };
