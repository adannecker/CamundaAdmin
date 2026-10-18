const { runtimeSearch } = require('./tenancy');
const { ApiError } = require('./camunda-api');

const READ_PERMISSIONS = ['READ_PROCESS_INSTANCE', 'READ_USER_TASK'];
const key = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const has = (rows, type, id, permission) => rows.some(a => !a.resourcePropertyName && a.resourceType === type && ['*', id].includes(a.resourceId) && a.permissionTypes?.includes(permission));
const groupGrant = a => ({ ownerType: a.ownerType, ownerId: a.ownerId, resourceType: a.resourceType, resourceId: a.resourceId, permissionTypes: a.permissionTypes, resourcePropertyName: a.resourcePropertyName || null });

async function assertReadAccess(c, tenantId) {
  const rows = await runtimeSearch(c.runtimeApi, c.runtimeBase, '/v2/authorizations/search', { ownerType: 'CLIENT', ownerId: c.runtimeClientId });
  if (rows.some(a => a.ownerType !== 'CLIENT' || a.ownerId !== c.runtimeClientId) || READ_PERMISSIONS.some(p => !has(rows, 'PROCESS_DEFINITION', '*', p))) throw new Error('Laufzeit-Leserechte wurden geändert; ein leeres Ergebnis ist kein Löschbeleg.');
  const me = await c.runtimeApi.runtime(c.runtimeBase, '/v2/authentication/me');
  if (!me.tenants?.some(t => t.tenantId === tenantId)) throw new Error('Technischer Tenant-Zugriff wurde geändert.');
}

async function assertTenantsEmpty(c, tenantIds) {
  for (const id of tenantIds) {
    const [instances, tasks] = await Promise.all([
      dataSearch(c, '/v2/process-instances/search', { tenantId: id }, 'processInstanceKey'),
      dataSearch(c, '/v2/user-tasks/search', { tenantId: id }, 'userTaskKey'),
    ]);
    if (instances.length || tasks.length) throw new Error('Neue oder noch vorhandene Laufzeitdaten erkannt. Zugriffe und Tenant bleiben vorerst erhalten.');
    await assertReadAccess(c, id);
  }
}

// Fetch every page; never turn a filtered, truncated or malformed response into a count of zero.
async function dataSearch(c, endpoint, filter, idField) {
  const rows = [], seen = new Set(); let total;
  for (let from = 0; from < 10000; from += 100) {
    const response = await c.runtimeApi.runtime(c.runtimeBase, endpoint, { method: 'POST', body: { filter, page: { from, limit: 100 }, sort: [{ field: idField === 'userTaskKey' ? 'creationDate' : idField, order: 'ASC' }] } });
    if (!Array.isArray(response.items) || !Number.isSafeInteger(response.page?.totalItems) || response.page.totalItems < 0 || typeof response.page.hasMoreTotalItems !== 'boolean') throw new Error('Laufzeitbestand ist nicht vollständig zählbar.');
    if (total === undefined) total = response.page.totalItems;
    if (total !== response.page.totalItems || total > 10000) throw new Error('Laufzeitbestand wurde während der Zählung geändert oder überschreitet das Limit von 10.000 Einträgen.');
    for (const row of response.items) {
      if (!key(row[idField]) || seen.has(row[idField])) throw new Error('Ungültige oder doppelte Laufzeit-Schlüssel.');
      seen.add(row[idField]); rows.push(row);
    }
    if (!response.page.hasMoreTotalItems) { if (rows.length !== total) throw new Error('Laufzeitbestand ist unvollständig.'); return rows; }
    if (response.items.length !== 100) throw new Error('Laufzeitbestand ist abgeschnitten.');
  }
  throw new Error('Suchlimit für Laufzeitdaten erreicht.');
}

async function inspectRuntime(c, inventory, selection, authorizations) {
  if (!selection.tenants.length) return { tenants: [], groups: [], counts: [] };
  if (READ_PERMISSIONS.some(p => !has(authorizations, 'PROCESS_DEFINITION', '*', p))) throw new Error('Für verlässliche Anzahlen fehlen dem Onboarding-Client READ_PROCESS_INSTANCE und READ_USER_TASK auf PROCESS_DEFINITION (*). Unter Admin · Standorte die fehlenden Clientrechte ergänzen.');
  const topology = await c.runtimeApi.runtime(c.runtimeBase, '/v2/topology');
  if (!/^8\.(9|[1-9][0-9]+)\./.test(topology.gatewayVersion || '')) throw new Error('Dieser Cleanup benötigt den Instanz-Löschvertrag ab Camunda 8.9.');
  const me = await c.runtimeApi.runtime(c.runtimeBase, '/v2/authentication/me');
  const tenantIds = me.tenants?.map(t => t.tenantId);
  if (!tenantIds || inventory.runtime.tenants.some(t => !tenantIds.includes(t.id))) throw new Error('Der technische Client kann nicht alle Tenant-Zuordnungen und Laufzeitabhängigkeiten vollständig prüfen.');
  const tenants = [], groups = new Map();
  const search = (endpoint, filter) => runtimeSearch(c.runtimeApi, c.runtimeBase, endpoint, filter);
  for (const id of selection.tenants) {
    const tenant = inventory.runtime.tenants.find(t => t.id === id);
    if (!tenant || tenant.system || id === '<default>' || !tenant.clientIds.includes(c.runtimeClientId)) throw new Error('Tenant oder technischer Tenant-Zugriff ist nicht freigegeben.');
    const [instances, tasks] = await Promise.all([
      dataSearch(c, '/v2/process-instances/search', { tenantId: id }, 'processInstanceKey'),
      dataSearch(c, '/v2/user-tasks/search', { tenantId: id }, 'userTaskKey'),
    ]);
    if ([...instances, ...tasks].some(x => x.tenantId !== id)) throw new Error('Die Laufzeitsuche lieferte Daten eines anderen Tenants.');
    const processes = instances.map(p => {
      if (!['ACTIVE', 'COMPLETED', 'TERMINATED'].includes(p.state) || typeof p.processDefinitionId !== 'string' || !p.processDefinitionId || p.processDefinitionId === '*' || (p.parentProcessInstanceKey != null && !key(p.parentProcessInstanceKey))) throw new Error('Unbekannte Prozessinstanz oder Prozessdefinition.');
      return { key: p.processInstanceKey, tenantId: id, definitionId: p.processDefinitionId, parent: p.parentProcessInstanceKey || null, state: p.state };
    });
    const processKeys = new Set(processes.map(p => p.key));
    if (processes.some(p => p.parent && !processKeys.has(p.parent))) throw new Error('Eine aufgerufene Instanz hängt von einer Instanz außerhalb des ausgewählten Tenants ab.');
    for (const p of processes) {
      const children = await dataSearch(c, '/v2/process-instances/search', { parentProcessInstanceKey: p.key }, 'processInstanceKey');
      if (children.some(child => child.tenantId !== id || !processKeys.has(child.processInstanceKey))) throw new Error('Prozesshierarchie reicht über den ausgewählten Tenant hinaus oder wurde geändert.');
      const visited = new Set([p.key]); let parent = p.parent;
      while (parent) { if (visited.has(parent)) throw new Error('Ungültige Prozesshierarchie.'); visited.add(parent); parent = processes.find(x => x.key === parent)?.parent; }
    }
    if (tasks.some(t => !processKeys.has(t.processInstanceKey) || typeof t.state !== 'string')) throw new Error('Aufgaben können keiner ausgewählten Prozessinstanz sicher zugeordnet werden.');
    for (const groupId of tenant.groupIds) {
      if (inventory.runtime.tenants.some(t => t.groupIds.includes(groupId) && !selection.tenants.includes(t.id))) throw new Error('Eine Runtime-Gruppe wird auch in einem nicht ausgewählten Tenant verwendet.');
      if (groups.has(groupId)) continue;
      const base = '/v2/groups/' + encodeURIComponent(groupId);
      const [clients, mappings, roles, grants] = await Promise.all([
        search(base + '/clients/search'), search(base + '/mapping-rules/search'), search(base + '/roles/search'),
        search('/v2/authorizations/search', { ownerType: 'GROUP', ownerId: groupId }),
      ]);
      const tenantMemberships = inventory.runtime.tenants.filter(t => t.groupIds.includes(groupId)).map(t => t.id).sort();
      if (clients.length || mappings.length || roles.some(r => r.roleId !== c.runtimeRole) || grants.some(a => a.ownerType !== 'GROUP' || a.ownerId !== groupId || a.resourcePropertyName || a.resourceType !== 'TENANT' || !tenantMemberships.includes(a.resourceId) || !Array.isArray(a.permissionTypes) || a.permissionTypes.some(p => p !== 'READ'))) throw new Error('Runtime-Gruppe hat weitere technische Zugriffe, Rollen oder Freigaben und bleibt geschützt.');
      const group = inventory.runtime.groups.find(g => g.id === groupId);
      groups.set(groupId, { id: groupId, users: [...group.users].sort(), tenantIds: tenantMemberships, roles: roles.map(r => r.roleId).sort(), grants: grants.map(groupGrant) });
    }
    tenants.push({ id, processes, tasks: tasks.map(t => ({ key: t.userTaskKey, processKey: t.processInstanceKey, state: t.state })) });
  }
  return { tenants, groups: [...groups.values()], counts: tenants.map(t => ({ tenantId: t.id, processInstances: t.processes.length, activeProcessInstances: t.processes.filter(p => p.state === 'ACTIVE').length, tasks: t.tasks.length, runtimeGroups: inventory.runtime.tenants.find(x => x.id === t.id).groupIds.length })) };
}

function requiredGrants(c, selection, snapshot, actual) {
  const requests = [
    ...selection.tenants.map(id => ['TENANT', id, ['DELETE']]),
    ...snapshot.groups.map(g => ['GROUP', g.id, ['DELETE']]),
    ...snapshot.tenants.flatMap(t => [...new Set(t.processes.map(p => p.definitionId))].map(id => ['PROCESS_DEFINITION', id, ['CANCEL_PROCESS_INSTANCE', 'DELETE_PROCESS_INSTANCE']])),
  ];
  const unique = new Map();
  for (const [type, id, permissions] of requests) {
    const missing = permissions.filter(p => !has(actual, type, id, p));
    if (missing.length) unique.set(type + '/' + id, { ownerType: 'CLIENT', ownerId: c.runtimeClientId, resourceType: type, resourceId: id, permissionTypes: missing });
  }
  if (unique.size && !has(actual, 'AUTHORIZATION', '*', 'CREATE')) throw new Error('Für die angezeigten gezielten Löschrechte fehlt AUTHORIZATION CREATE.');
  return [...unique.values()];
}

async function purgeTenant(c, snapshot, wait, record) {
  const runtime = (endpoint, options) => c.runtimeApi.runtime(c.runtimeBase, endpoint, options);
  const processBase = p => '/v2/process-instances/' + encodeURIComponent(p.key);
  const checked = async p => {
    const current = await runtime(processBase(p));
    if (current.tenantId !== snapshot.id || current.processInstanceKey !== p.key || current.processDefinitionId !== p.definitionId || (current.parentProcessInstanceKey || null) !== p.parent) throw new Error('Prozessziel oder Tenant hat sich geändert.');
    return current;
  };
  // Cancellation affects descendants, so only cancel roots of the verified tenant hierarchy.
  for (const p of snapshot.processes.filter(p => !p.parent)) {
    const current = await checked(p);
    if (current.state === 'ACTIVE') { record({ phase: 'cancel', tenantId: snapshot.id, processKey: p.key }); await runtime(processBase(p) + '/cancellation', { method: 'POST', body: {} }); }
    else if (!['COMPLETED', 'TERMINATED'].includes(current.state)) throw new Error('Instanzzustand ist nicht für Cleanup freigegeben.');
  }
  for (const p of snapshot.processes) {
    let terminal = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      record({ phase: 'wait-cancellation', tenantId: snapshot.id, processKey: p.key });
      if (attempt) await wait(1000);
      const current = await checked(p);
      if (['COMPLETED', 'TERMINATED'].includes(current.state)) { terminal = true; break; }
    }
    if (!terminal) throw new Error('Abbruch der Prozessinstanz noch nicht bestätigt. Tenant bleibt erhalten.');
    record({ phase: 'delete-instance', tenantId: snapshot.id, processKey: p.key });
    await runtime(processBase(p) + '/deletion', { method: 'POST', body: {} });
  }
  // Deletion is asynchronous. Keep the tenant and its access until both indexes are empty.
  for (let attempt = 0; attempt < 60; attempt++) {
    record({ phase: 'wait-deletion', tenantId: snapshot.id });
    if (attempt) await wait(1000);
    const [processes, tasks] = await Promise.all([
      dataSearch(c, '/v2/process-instances/search', { tenantId: snapshot.id }, 'processInstanceKey'),
      dataSearch(c, '/v2/user-tasks/search', { tenantId: snapshot.id }, 'userTaskKey'),
    ]);
    if ([...processes, ...tasks].some(p => p.tenantId !== snapshot.id) || processes.some(p => !snapshot.processes.some(x => x.key === p.processInstanceKey)) || tasks.some(t => !snapshot.tasks.some(x => x.key === t.userTaskKey))) throw new Error('Neue oder fremde Laufzeitdaten erkannt. Tenant bleibt erhalten.');
    if (!processes.length && !tasks.length) { await assertReadAccess(c, snapshot.id); return; }
  }
  throw new Error('Instanzen/Aufgaben sind noch sichtbar. Keine erneuten Löschaufrufe; Tenant bleibt erhalten. Bestand neu prüfen.');
}

async function absent(runtime, base) { try { await runtime(base); return false; } catch (error) { if (error instanceof ApiError && error.status === 404) return true; throw error; } }
module.exports = { READ_PERMISSIONS, has, groupGrant, assertReadAccess, assertTenantsEmpty, dataSearch, inspectRuntime, requiredGrants, purgeTenant, absent };
