const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3300);
const ROOT = __dirname;
const DEFINITION_STATE_FILE = path.join(ROOT, 'definition-cleanup-state.json');
const RUNTIME_CLEANUP_ENABLED = false;

const clusters = {
  basel: { name: 'Basel', credentials: 'credentials_basel.txt' },
  brugg: { name: 'Brugg', credentials: 'credentials_brugg.txt' },
  olten: { name: 'Olten', credentials: 'credentials_olten.txt' },
};

const resources = {
  members: { label: 'Member', kind: 'console', method: 'GET', path: 'members' },
  projects: { label: 'Projekte', kind: 'projects' },
  connectors: { label: 'Connectors', kind: 'connector-secrets' },
  clusters: { label: 'Cluster', kind: 'console', method: 'GET', path: 'clusters' },
  activities: { label: 'Aktivitäten', kind: 'activities' },
};
const activityUserNameOverrides = {
  basel: {
    'auth0|63208ae74ab2b191de852ec9': 'Achim Dannecker',
  },
};
const tokenCache = new Map();
const cleanupJobs = new Map();
const definitionCleanupJobs = new Map();
const projectDeletionJobs = new Map();
const deletedDefinitionKeys = (() => {
  try {
    const stored = JSON.parse(fs.readFileSync(DEFINITION_STATE_FILE, 'utf8'));
    return new Map(Object.entries(stored).map(([clusterId, keys]) => [clusterId, new Set(Array.isArray(keys) ? keys.map(String) : [])]));
  } catch {
    return new Map();
  }
})();

function rememberDeletedDefinitions(clusterId, keys) {
  const stored = deletedDefinitionKeys.get(clusterId) || new Set();
  for (const key of keys) stored.add(String(key));
  deletedDefinitionKeys.set(clusterId, stored);
  fs.writeFileSync(DEFINITION_STATE_FILE, JSON.stringify(Object.fromEntries(
    [...deletedDefinitionKeys].map(([id, values]) => [id, [...values]]),
  ), null, 2));
}

function quotedValue(text) {
  const match = String(text || '').match(/["“]([^"”]+)["”]/);
  return match?.[1] || null;
}

function activityUserNames(clusterId, events) {
  const names = new Map();
  for (const event of events) {
    if (String(event.entity || '').toLowerCase() !== 'member' || !event.entityId) continue;
    const name = quotedValue(event.audit);
    if (name && !name.includes('@')) names.set(event.entityId, name);
  }
  for (const [userId, name] of Object.entries(activityUserNameOverrides[clusterId] || {})) names.set(userId, name);
  return names;
}

function activityUserName(userId, names) {
  if (!userId) return null;
  if (names.has(userId)) return names.get(userId);
  if (userId === 'Camunda') return 'Camunda';
  if (userId === 'console') return 'Camunda Console';
  if (userId.startsWith('samlp|')) return userId.split('|').at(-1) || null;
  return null;
}

function normalizedMemberName(name) {
  return String(name || '').trim().toLocaleLowerCase('de');
}

function memberJoinDates(members, events) {
  const memberNameCounts = new Map();
  for (const member of members) {
    const name = normalizedMemberName(member.name);
    if (name) memberNameCounts.set(name, (memberNameCounts.get(name) || 0) + 1);
  }

  const joinDates = new Map();
  for (const event of events) {
    if (String(event.entity || '').toLowerCase() !== 'member') continue;
    if (!String(event.audit || '').toLowerCase().includes('joined organization')) continue;
    const name = normalizedMemberName(quotedValue(event.audit));
    const timestamp = Number(event.timestamp);
    if (!name || memberNameCounts.get(name) !== 1 || !Number.isFinite(timestamp)) continue;
    if (!joinDates.has(name) || timestamp > joinDates.get(name)) joinDates.set(name, timestamp);
  }
  return joinDates;
}

function readCredentials(filename) {
  const source = fs.readFileSync(path.join(ROOT, filename), 'utf8');
  const credentials = {};
  for (let line of source.split(/\r?\n/)) {
    line = line.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    credentials[key] = value;
  }
  return credentials;
}

function connectorSecretsFromEnv() {
  try {
    return Object.entries(readCredentials('.env'))
      .filter(([name]) => /^[A-Z][A-Z0-9_]*$/.test(name))
      .map(([name, secretValue]) => ({ name, secretValue }));
  } catch {
    return [];
  }
}

async function getAccessToken(credentials) {
  const cacheKey = credentials.CAMUNDA_CONSOLE_CLIENT_ID;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetch(credentials.CAMUNDA_OAUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.CAMUNDA_CONSOLE_CLIENT_ID,
      client_secret: credentials.CAMUNDA_CONSOLE_CLIENT_SECRET,
      audience: credentials.CAMUNDA_CONSOLE_OAUTH_AUDIENCE,
    }),
  });
  if (!response.ok) throw new Error(`OAuth-Anmeldung fehlgeschlagen (HTTP ${response.status}).`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error('OAuth-Antwort enthält kein Zugriffstoken.');
  tokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(payload.expires_in) || 300) - 60) * 1000,
  });
  return payload.access_token;
}

async function getClusterAccessToken(credentials, audience) {
  const clientId = credentials.CAMUNDA_CLIENT_ID || credentials.ZEEBE_CLIENT_ID || credentials['camunda.client.auth.client-id'];
  const clientSecret = credentials.CAMUNDA_CLIENT_SECRET || credentials.ZEEBE_CLIENT_SECRET || credentials['camunda.client.auth.client-secret'];
  const cacheKey = `${audience}:${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetch(credentials.CAMUNDA_OAUTH_URL || credentials.ZEEBE_AUTHORIZATION_SERVER_URL || 'https://login.cloud.camunda.io/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
    }),
  });
  if (!response.ok) throw new Error(`Cluster-OAuth-Anmeldung fehlgeschlagen (HTTP ${response.status}).`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error('Cluster-OAuth-Antwort enthält kein Zugriffstoken.');
  tokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(payload.expires_in) || 300) - 60) * 1000,
  });
  return payload.access_token;
}

function consoleApiUrl(credentials, resourcePath) {
  const baseUrl = (credentials.CAMUNDA_CONSOLE_BASE_URL || 'https://api.cloud.camunda.io').replace(/\/$/, '');
  return `${baseUrl}/${resourcePath}`;
}

async function requestJson(url, options, label) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${label} konnten nicht geladen werden (HTTP ${response.status}).`);
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} lieferten keine JSON-Antwort.`);
  }
}

async function requestAdminAction(url, options, label) {
  const response = await fetch(url, options);
  if (response.ok) {
    const body = await response.text();
    if (!body) return {};
    try { return JSON.parse(body); } catch { return {}; }
  }
  const body = await response.text();
  let detail = body;
  try {
    const payload = JSON.parse(body);
    detail = payload.detail || payload.message || payload.error || body;
  } catch {}
  detail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  throw new Error(`${label} fehlgeschlagen (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
}

async function consoleConnection(clusterId) {
  const cluster = clusters[clusterId];
  if (!cluster) throw new Error('Unbekannter Standort.');
  const credentials = readCredentials(cluster.credentials);
  const token = await getAccessToken(credentials);
  return {
    cluster,
    credentials,
    token,
    baseUrl: (credentials.CAMUNDA_CONSOLE_BASE_URL || 'https://api.cloud.camunda.io').replace(/\/$/, ''),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  };
}

function processConnection(clusterId) {
  const cluster = clusters[clusterId];
  if (!cluster) throw new Error('Unbekannter Standort.');
  const credentials = readCredentials(cluster.credentials);
  const clientId = credentials.CAMUNDA_CLIENT_ID || credentials.ZEEBE_CLIENT_ID || credentials['camunda.client.auth.client-id'];
  const clientSecret = credentials.CAMUNDA_CLIENT_SECRET || credentials.ZEEBE_CLIENT_SECRET || credentials['camunda.client.auth.client-secret'];
  const camundaClusterId = credentials.CAMUNDA_CLUSTER_ID || credentials['camunda.client.cloud.cluster-id'];
  const region = credentials.CAMUNDA_CLUSTER_REGION || credentials['camunda.client.cloud.region'];
  if (!clientId || !clientSecret || !camundaClusterId || !region) throw new Error(`Unvollständige Cluster-Zugangsdaten für ${cluster.name}.`);
  const operateBaseUrl = (credentials.CAMUNDA_OPERATE_BASE_URL || `https://${region}.operate.camunda.io/${camundaClusterId}`).replace(/\/$/, '');
  const zeebeRestAddress = (credentials.ZEEBE_REST_ADDRESS || `https://${region}.zeebe.camunda.io/${camundaClusterId}`).replace(/\/$/, '');
  return { clusterId, cluster, credentials, operateBaseUrl, zeebeRestAddress };
}

async function searchProcessInstances(connection, limit = 1000) {
  const token = await getClusterAccessToken(connection.credentials, 'operate.camunda.io');
  const url = `${connection.operateBaseUrl}/v1/process-instances/search`;
  const instances = [];
  let total = 0;
  let searchAfter;
  while (instances.length < limit) {
    const size = Math.min(100, limit - instances.length);
    const body = { filter: {}, size, sort: [{ field: 'startDate', order: 'DESC' }] };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = await requestJson(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'Prozessinstanzen');
    const items = page.items || [];
    total = Number(page.total) || items.length;
    instances.push(...items);
    if (!items.length || instances.length >= total || !page.sortValues) break;
    searchAfter = page.sortValues;
  }
  return { instances, total };
}

async function searchOperateResources(connection, endpoint, sortField, limit = 10_000) {
  const token = await getClusterAccessToken(connection.credentials, 'operate.camunda.io');
  const url = `${connection.operateBaseUrl}/v1/${endpoint}/search`;
  const items = [];
  let total = 0;
  let searchAfter;
  while (items.length < limit) {
    const size = Math.min(100, limit - items.length);
    const body = { filter: {}, size, sort: [{ field: sortField, order: 'ASC' }] };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = await requestJson(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'Definitionen');
    const pageItems = page.items || [];
    total = Number(page.total) || pageItems.length;
    items.push(...pageItems);
    if (!pageItems.length || items.length >= total || !page.sortValues) break;
    searchAfter = page.sortValues;
  }
  return { items, total };
}

async function definitionSnapshot(connection, limit = 10_000) {
  const [processResult, drdResult] = await Promise.all([
    searchOperateResources(connection, 'process-definitions', 'key', limit),
    searchOperateResources(connection, 'drd', 'key', limit),
  ]);
  if (processResult.items.length < processResult.total || drdResult.items.length < drdResult.total) {
    throw new Error('Mehr als 10.000 Definitionen gefunden; ein vollständiger Cleanup wird aus Sicherheitsgründen nicht angeboten.');
  }
  const excluded = deletedDefinitionKeys.get(connection.clusterId) || new Set();
  const processes = processResult.items.filter((item) => !excluded.has(String(item.key)));
  const drds = drdResult.items.filter((item) => !excluded.has(String(item.key)));
  return { processes, drds, processCount: processes.length, drdCount: drds.length, total: processes.length + drds.length };
}

function rootProcessInstances(instances) {
  return instances.filter((instance) => instance.parentKey === null || instance.parentKey === undefined);
}

function cleanupPreview(instances) {
  const roots = rootProcessInstances(instances);
  return {
    rootCount: roots.length,
    activeRootCount: roots.filter((instance) => instance.state === 'ACTIVE').length,
    finishedRootCount: roots.filter((instance) => instance.state !== 'ACTIVE').length,
    childCount: instances.length - roots.length,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestCleanupAction(url, options, label) {
  let lastStatus = 0;
  let lastDetail = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, options);
    if (response.ok) return { deleted: true, status: response.status };
    if (response.status === 404) return { deleted: false, missing: true, status: response.status };
    lastStatus = response.status;
    const responseText = await response.text();
    try {
      const payload = JSON.parse(responseText);
      lastDetail = payload.detail || payload.message || payload.error || responseText;
    } catch {
      lastDetail = responseText;
    }
    lastDetail = String(lastDetail || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (![429, 503, 504].includes(response.status)) break;
    await delay(500 * (2 ** attempt));
  }
  throw new Error(`${label} fehlgeschlagen (HTTP ${lastStatus})${lastDetail ? `: ${lastDetail}` : '.'}`);
}

async function forEachConcurrent(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function runProcessCleanup(clusterId, snapshot, job) {
  const connection = processConnection(clusterId);
  const roots = rootProcessInstances(snapshot);
  const snapshotKeys = new Set(roots.map((instance) => String(instance.key)));
  const activeRoots = roots.filter((instance) => instance.state === 'ACTIVE');
  const zeebeAudience = connection.credentials.CAMUNDA_TOKEN_AUDIENCE || connection.credentials.ZEEBE_TOKEN_AUDIENCE || 'zeebe.camunda.io';
  const zeebeToken = await getClusterAccessToken(connection.credentials, zeebeAudience);
  job.phase = 'cancelling';
  job.phaseLabel = 'Laufende Root-Instanzen werden beendet';
  job.totalToCancel = activeRoots.length;

  await forEachConcurrent(activeRoots, 5, async (instance) => {
    try {
      await requestCleanupAction(`${connection.zeebeRestAddress}/v2/process-instances/${encodeURIComponent(String(instance.key))}/cancellation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${zeebeToken}`, accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      }, `Instanz ${instance.key} beenden`);
      job.cancelled += 1;
    } catch (error) {
      job.failed += 1;
      if (job.errors.length < 25) job.errors.push(error.message);
    }
  });

  job.phase = 'waiting';
  job.phaseLabel = 'Warte auf die Synchronisierung mit Operate';
  let currentInstances = snapshot;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await searchProcessInstances(connection, Math.max(1000, snapshot.length + 100));
    currentInstances = current.instances;
    const pending = currentInstances.filter((instance) => snapshotKeys.has(String(instance.key)) && instance.state === 'ACTIVE');
    job.remainingActive = pending.length;
    if (!pending.length) break;
    await delay(2000);
  }

  const operateToken = await getClusterAccessToken(connection.credentials, 'operate.camunda.io');
  const deletableRoots = rootProcessInstances(currentInstances).filter((instance) => snapshotKeys.has(String(instance.key)) && instance.state !== 'ACTIVE');
  job.phase = 'deleting';
  job.phaseLabel = 'Beendete Root-Instanzen werden endgültig gelöscht';
  job.totalToDelete = deletableRoots.length;
  await forEachConcurrent(deletableRoots, 3, async (instance) => {
    try {
      await requestCleanupAction(`${connection.operateBaseUrl}/v1/process-instances/${encodeURIComponent(String(instance.key))}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${operateToken}`, accept: 'application/json' },
      }, `Instanz ${instance.key} löschen`);
      job.deleted += 1;
    } catch (error) {
      job.failed += 1;
      if (job.errors.length < 25) job.errors.push(error.message);
    }
  });
  job.status = 'completed';
  job.phase = 'completed';
  job.phaseLabel = job.failed ? 'Cleanup mit Fehlern abgeschlossen' : 'Cleanup abgeschlossen';
  job.finishedAt = new Date().toISOString();
}

async function runDefinitionCleanup(clusterId, snapshot, job) {
  const connection = processConnection(clusterId);
  const audience = connection.credentials.CAMUNDA_TOKEN_AUDIENCE || connection.credentials.ZEEBE_TOKEN_AUDIENCE || 'zeebe.camunda.io';
  const token = await getClusterAccessToken(connection.credentials, audience);
  const groups = [
    { items: snapshot.processes, phase: 'processes', label: 'Prozessdefinitionen werden gelöscht' },
    { items: snapshot.drds, phase: 'decisions', label: 'DMN-Definitionen werden gelöscht' },
  ];
  const removedKeys = [];
  for (const group of groups) {
    job.phase = group.phase;
    job.phaseLabel = group.label;
    await forEachConcurrent(group.items, 3, async (definition) => {
      try {
        const result = await requestCleanupAction(`${connection.zeebeRestAddress}/v2/resources/${encodeURIComponent(String(definition.key))}/deletion`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: '{}',
        }, `Definition ${definition.key} löschen`);
        if (result.missing) job.alreadyMissing += 1;
        else job.deleted += 1;
        removedKeys.push(String(definition.key));
      } catch (error) {
        job.failed += 1;
        if (job.errors.length < 25) job.errors.push(error.message);
      }
      job.processed += 1;
    });
    rememberDeletedDefinitions(clusterId, removedKeys);
  }
  job.status = 'completed';
  job.phase = 'completed';
  job.phaseLabel = job.failed ? 'Definitions-Cleanup mit Fehlern abgeschlossen' : 'Definitions-Cleanup abgeschlossen';
  job.finishedAt = new Date().toISOString();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(new Error('Anfrage ist zu groß.'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Ungültige JSON-Anfrage.')); }
    });
    request.on('error', reject);
  });
}

function connectorMetadata(cluster, secret, key) {
  const { secretValue, value, ...metadata } = secret || {};
  return { cluster: cluster.name || cluster.uuid, clusterUuid: cluster.uuid, ...(key ? { key } : {}), ...metadata };
}

async function loadResource(clusterId, resourceId) {
  const cluster = clusters[clusterId];
  const resource = resources[resourceId];
  if (!cluster || !resource) return null;

  const credentials = readCredentials(cluster.credentials);
  if (resource.kind === 'process-instances') {
    const limit = 1000;
    const connection = processConnection(clusterId);
    const { instances, total } = await searchProcessInstances(connection, limit);
    const safeInstances = instances.map((instance) => ({
      key: instance.key,
      bpmnProcessId: instance.bpmnProcessId,
      processVersion: instance.processVersion,
      startDate: instance.startDate,
      state: instance.state,
      incident: instance.incident,
      processDefinitionKey: instance.processDefinitionKey,
      tenantId: instance.tenantId,
      parentKey: instance.parentKey,
    }));
    return { cluster: cluster.name, resource: resource.label, data: safeInstances, total, limited: safeInstances.length < total };
  }
  if (resource.kind === 'definitions') {
    const connection = processConnection(clusterId);
    const snapshot = await definitionSnapshot(connection);
    const definitions = [
      ...snapshot.processes.map((item) => ({ type: 'Prozess', key: item.key, name: item.name, id: item.bpmnProcessId, version: item.version, tenantId: item.tenantId })),
      ...snapshot.drds.map((item) => ({ type: 'DMN', key: item.key, name: item.name, id: item.decisionRequirementsId, version: item.version, tenantId: item.tenantId })),
    ];
    return {
      cluster: cluster.name,
      resource: resource.label,
      data: definitions,
      processCount: snapshot.processCount,
      drdCount: snapshot.drdCount,
      formsSupported: false,
      clusterVersion: '8.7',
    };
  }
  const required = ['CAMUNDA_OAUTH_URL', 'CAMUNDA_CONSOLE_CLIENT_ID', 'CAMUNDA_CONSOLE_CLIENT_SECRET', 'CAMUNDA_CONSOLE_OAUTH_AUDIENCE'];
  if (required.some((key) => !credentials[key])) throw new Error(`Unvollständige Zugangsdaten für ${cluster.name}.`);

  const token = await getAccessToken(credentials);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

  if (resourceId === 'clusters') {
    const [data, parameters] = await Promise.all([
      requestJson(consoleApiUrl(credentials, 'clusters'), { headers }, 'Cluster'),
      requestJson(consoleApiUrl(credentials, 'clusters/parameters'), { headers }, 'Clusterparameter'),
    ]);
    const envSecrets = connectorSecretsFromEnv().map(({ name, secretValue }) => ({ name, configured: Boolean(secretValue) }));
    return { cluster: cluster.name, resource: resource.label, data, parameters, envSecrets };
  }

  if (resource.kind === 'projects') {
    const projectRequestOptions = (page) => ({
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ page, size: 25 }),
    });
    const firstPage = await requestJson('https://modeler.camunda.io/api/v1/projects/search', projectRequestOptions(0), resource.label);
    const projects = [...(firstPage.items || [])];
    const total = Number(firstPage.total) || projects.length;
    for (let page = 1; projects.length < total; page += 1) {
      const result = await requestJson('https://modeler.camunda.io/api/v1/projects/search', projectRequestOptions(page), resource.label);
      const items = result.items || [];
      if (!items.length) break;
      projects.push(...items);
    }

    const collaboratorRequestOptions = (page) => ({
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ page, size: 50 }),
    });
    const [firstCollaboratorPage, organizationMembers] = await Promise.all([
      requestJson('https://modeler.camunda.io/api/v1/collaborators/search', collaboratorRequestOptions(0), 'Teammitglieder'),
      requestJson(consoleApiUrl(credentials, 'members'), { headers }, 'Member'),
    ]);
    const collaborators = [...(firstCollaboratorPage.items || [])];
    const collaboratorTotal = Number(firstCollaboratorPage.total) || collaborators.length;
    for (let page = 1; collaborators.length < collaboratorTotal; page += 1) {
      const result = await requestJson('https://modeler.camunda.io/api/v1/collaborators/search', collaboratorRequestOptions(page), 'Teammitglieder');
      const items = result.items || [];
      if (!items.length) break;
      collaborators.push(...items);
    }

    const collaboratorsByProject = new Map();
    for (const collaborator of collaborators) {
      if (!collaborator.projectId) continue;
      const projectCollaborators = collaboratorsByProject.get(collaborator.projectId) || [];
      projectCollaborators.push({ name: collaborator.name, email: collaborator.email, role: collaborator.role });
      collaboratorsByProject.set(collaborator.projectId, projectCollaborators);
    }
    const memberEmails = new Set((organizationMembers || []).map((member) => String(member.email || '').trim().toLowerCase()).filter(Boolean));
    const projectsWithTeam = projects.map((project) => {
      const teamMembers = collaboratorsByProject.get(project.id) || [];
      const owners = teamMembers.filter((member) => member.role === 'project_admin').map(({ name, email }) => ({ name, email }));
      const activeOwnerCount = owners.filter((owner) => memberEmails.has(String(owner.email || '').trim().toLowerCase())).length;
      return {
        ...project,
        owners,
        ownerStatus: !owners.length ? 'Unbekannt' : activeOwnerCount ? 'Member' : 'No Member',
        ownerMissing: owners.length > 0 && activeOwnerCount === 0,
        teamMembers,
      };
    });
    return { cluster: cluster.name, resource: resource.label, data: projectsWithTeam };
  }

  if (resource.kind === 'connector-secrets') {
    const allClusters = await requestJson(consoleApiUrl(credentials, 'clusters'), { headers }, 'Cluster');
    const secretLists = await Promise.all(allClusters.map(async (consoleCluster) => {
      const secrets = await requestJson(consoleApiUrl(credentials, `clusters/${encodeURIComponent(consoleCluster.uuid)}/secrets`), { headers }, 'Connector-Secrets');
      if (Array.isArray(secrets)) return secrets.map((secret) => connectorMetadata(consoleCluster, secret));
      if (Array.isArray(secrets.items)) return secrets.items.map((secret) => connectorMetadata(consoleCluster, secret));
      return Object.keys(secrets || {}).map((key) => connectorMetadata(consoleCluster, {}, key));
    }));
    return { cluster: cluster.name, resource: resource.label, data: secretLists.flat() };
  }

  if (resource.kind === 'activities') {
    const events = await requestJson(consoleApiUrl(credentials, 'activity/json'), { headers }, 'Aktivitäten');
    const list = Array.isArray(events) ? events : events.items || events.events || [];
    const userNames = activityUserNames(clusterId, list);
    const safeEvents = list.map((event) => ({
      timestamp: event.timestamp,
      service: event.service,
      action: event.audit,
      actionType: event.auditType,
      entity: event.entity,
      entityId: event.entityId,
      userId: event.userId,
      userName: activityUserName(event.userId, userNames),
      parentEntity: event.parentEntity,
    }));
    return { cluster: cluster.name, resource: resource.label, data: safeEvents };
  }

  const data = await requestJson(consoleApiUrl(credentials, resource.path), { method: resource.method, headers }, resource.label);
  if (resourceId === 'members') {
    const events = await requestJson(consoleApiUrl(credentials, 'activity/json'), { headers }, 'Aktivitäten');
    const eventList = Array.isArray(events) ? events : events.items || events.events || [];
    const joinDates = memberJoinDates(data, eventList);
    const membersWithJoinDate = data.map((member) => ({
      ...member,
      memberSince: joinDates.get(normalizedMemberName(member.name)) || null,
    }));
    return { cluster: cluster.name, resource: resource.label, data: membersWithJoinDate };
  }
  return { cluster: cluster.name, resource: resource.label, data };
}

async function deleteMember(clusterId, email) {
  const cluster = clusters[clusterId];
  if (!cluster) throw new Error('Unbekannter Standort.');
  if (!email || email.length > 320 || !email.includes('@')) throw new Error('Ungültige E-Mail-Adresse.');

  const credentials = readCredentials(cluster.credentials);
  const token = await getAccessToken(credentials);
  const response = await fetch(consoleApiUrl(credentials, `members/${encodeURIComponent(email)}`), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Member konnte nicht gelöscht werden (HTTP ${response.status}).`);
}

function addProjectDeletionEvent(job, message, depth = 0, type = 'info') {
  if (!job) return;
  job.events.push({ message, depth, type, timestamp: new Date().toISOString() });
  if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
}

async function deleteModelerContent(content, headers, result, job, depth = 0) {
  const files = Array.isArray(content?.files) ? content.files : [];
  const folders = Array.isArray(content?.folders) ? content.folders : [];
  for (const file of files) {
    addProjectDeletionEvent(job, `Datei löschen: ${file.name || file.id}`, depth + 1);
    const deletion = await requestCleanupAction(`https://modeler.camunda.io/api/v1/files/${encodeURIComponent(String(file.id))}`, {
      method: 'DELETE', headers,
    }, `Datei ${file.name || file.id} löschen`);
    if (!deletion.missing) result.deletedFiles += 1;
    addProjectDeletionEvent(job, deletion.missing ? 'Datei war bereits entfernt' : 'Datei gelöscht', depth + 2, 'success');
    await delay(600);
  }
  for (const folder of folders) {
    addProjectDeletionEvent(job, `Going deep → Ordner: ${folder.name || folder.id}`, depth + 1, 'folder');
    const folderResponse = await fetch(`https://modeler.camunda.io/api/v1/folders/${encodeURIComponent(String(folder.id))}`, { headers });
    if (folderResponse.status !== 404) {
      if (!folderResponse.ok) throw new Error(`Ordner ${folder.name || folder.id} konnte nicht geladen werden (HTTP ${folderResponse.status}).`);
      const folderDetails = await folderResponse.json();
      await deleteModelerContent(folderDetails.content, headers, result, job, depth + 1);
    }
    addProjectDeletionEvent(job, `Ordner löschen: ${folder.name || folder.id}`, depth + 1);
    const deletion = await requestCleanupAction(`https://modeler.camunda.io/api/v1/folders/${encodeURIComponent(String(folder.id))}`, {
      method: 'DELETE', headers,
    }, `Ordner ${folder.name || folder.id} löschen`);
    if (!deletion.missing) result.deletedFolders += 1;
    addProjectDeletionEvent(job, `Going up ← ${folder.name || folder.id} entfernt`, depth + 1, 'success');
    await delay(600);
  }
}

async function deleteProjects(clusterId, projectIds, job) {
  const cluster = clusters[clusterId];
  if (!cluster) throw new Error('Unbekannter Standort.');
  const credentials = readCredentials(cluster.credentials);
  const result = job || { deleted: [], alreadyMissing: [], failed: [], deletedFiles: 0, deletedFolders: 0, events: [] };
  await forEachConcurrent(projectIds, 1, async (projectId, index) => {
    try {
      const token = await getAccessToken(credentials);
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      const detailResponse = await fetch(`https://modeler.camunda.io/api/v1/projects/${encodeURIComponent(projectId)}`, { headers });
      if (detailResponse.status === 404) {
        result.alreadyMissing.push(projectId);
        addProjectDeletionEvent(job, `Projekt ${index + 1}/${projectIds.length}: bereits entfernt`, 0, 'success');
        return;
      }
      if (!detailResponse.ok) throw new Error(`Projektinhalt konnte nicht geladen werden (HTTP ${detailResponse.status}).`);
      const project = await detailResponse.json();
      const projectName = project.metadata?.name || projectId;
      result.currentProject = index + 1;
      result.currentProjectName = projectName;
      addProjectDeletionEvent(job, `Projekt ${index + 1}/${projectIds.length}: ${projectName}`, 0, 'project');
      await deleteModelerContent(project.content, headers, result, job, 0);
      addProjectDeletionEvent(job, `Projekt löschen: ${projectName}`, 1);
      const deletion = await requestCleanupAction(`https://modeler.camunda.io/api/v1/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
        headers,
      }, `Projekt ${projectId} löschen`);
      if (deletion.missing) result.alreadyMissing.push(projectId);
      else result.deleted.push(projectId);
      addProjectDeletionEvent(job, `Projekt ${index + 1}/${projectIds.length} abgeschlossen`, 0, 'success');
      await delay(600);
    } catch (error) {
      result.failed.push({ projectId, error: error.message });
      addProjectDeletionEvent(job, `Projekt ${index + 1}/${projectIds.length} fehlgeschlagen: ${error.message}`, 0, 'error');
    }
  });
  if (job) {
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    job.currentProjectName = null;
    addProjectDeletionEvent(job, `Fertig: ${job.deleted.length + job.alreadyMissing.length} gelöscht, ${job.failed.length} fehlgeschlagen`, 0, job.failed.length ? 'error' : 'success');
  }
  return result;
}

async function createCluster(clusterId, input) {
  const connection = await consoleConnection(clusterId);
  const parameters = await requestJson(`${connection.baseUrl}/clusters/parameters`, { headers: connection.headers }, 'Clusterparameter');
  const plan = (parameters.clusterPlanTypes || []).find((item) => item.uuid === input.planTypeId);
  const channel = (parameters.channels || []).find((item) => item.uuid === input.channelId);
  const generation = channel?.allowedGenerations?.find((item) => item.uuid === input.generationId);
  const region = (parameters.regions || []).find((item) => item.uuid === input.regionId);
  const name = String(input.name || '').trim();
  if (!name || name.length > 100) throw new Error('Der Clustername muss zwischen 1 und 100 Zeichen lang sein.');
  if (!plan || !channel || !generation || !region) throw new Error('Mindestens ein ausgewählter Clusterparameter ist nicht mehr verfügbar.');
  if (!['dev', 'test', 'stage', 'prod'].includes(input.stageLabel)) throw new Error('Ungültiges Cluster-Label.');
  if (input.confirmation !== 'CREATE CLUSTER') throw new Error('Bestätigung stimmt nicht. Erwartet wird CREATE CLUSTER.');
  return requestAdminAction(`${connection.baseUrl}/clusters`, {
    method: 'POST',
    headers: { ...connection.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      description: String(input.description || '').trim().slice(0, 150),
      planTypeId: plan.uuid,
      channelId: channel.uuid,
      generationId: generation.uuid,
      regionId: region.uuid,
      autoUpdate: Boolean(input.autoUpdate),
      stageLabel: input.stageLabel,
      encryption: 'Provider',
    }),
  }, 'Cluster anlegen');
}

async function deleteCluster(clusterId, clusterUuid, confirmation) {
  const connection = await consoleConnection(clusterId);
  const currentClusters = await requestJson(`${connection.baseUrl}/clusters`, { headers: connection.headers }, 'Cluster');
  const target = currentClusters.find((item) => item.uuid === clusterUuid);
  if (!target) throw new Error('Der Cluster wurde nicht gefunden oder bereits gelöscht.');
  if (confirmation !== `DELETE CLUSTER ${target.name}`) throw new Error(`Bestätigung stimmt nicht. Erwartet wird DELETE CLUSTER ${target.name}.`);
  await requestAdminAction(`${connection.baseUrl}/clusters/${encodeURIComponent(clusterUuid)}`, {
    method: 'DELETE', headers: connection.headers,
  }, `Cluster ${target.name} löschen`);
  return { deleted: clusterUuid, name: target.name };
}

async function syncClusterSecrets(clusterId, clusterUuid) {
  const connection = await consoleConnection(clusterId);
  const currentClusters = await requestJson(`${connection.baseUrl}/clusters`, { headers: connection.headers }, 'Cluster');
  if (!currentClusters.some((item) => item.uuid === clusterUuid)) throw new Error('Der Cluster wurde nicht gefunden.');
  const configuredSecrets = connectorSecretsFromEnv().filter((item) => item.secretValue);
  if (!configuredSecrets.length) throw new Error('In der .env ist noch kein Secret-Wert eingetragen.');
  const current = await requestJson(`${connection.baseUrl}/clusters/${encodeURIComponent(clusterUuid)}/secrets`, { headers: connection.headers }, 'Connector-Secrets');
  const existingNames = new Set(Array.isArray(current) ? current.map((item) => item.name || item.key || item) : Object.keys(current || {}));
  const result = { created: [], skipped: [], failed: [] };
  for (const secret of configuredSecrets) {
    if (existingNames.has(secret.name)) {
      result.skipped.push(secret.name);
      continue;
    }
    try {
      await requestAdminAction(`${connection.baseUrl}/clusters/${encodeURIComponent(clusterUuid)}/secrets`, {
        method: 'POST',
        headers: { ...connection.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ secretName: secret.name, secretValue: secret.secretValue }),
      }, `Secret ${secret.name} anlegen`);
      result.created.push(secret.name);
    } catch (error) {
      result.failed.push({ name: secret.name, error: error.message });
    }
  }
  return result;
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

function serveStatic(response, filename, type) {
  fs.readFile(path.join(ROOT, 'public', filename), (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(data);
  });
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  // Cleanup and administration writes remain disabled until explicitly enabled in code.
  if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 403, { error: 'Schreibaktionen sind derzeit deaktiviert.' });
  const liveMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/live$/);
  if (request.method === 'GET' && liveMatch) {
    const checkedAt = new Date().toISOString();
    try {
      const connection = await consoleConnection(liveMatch[1]);
      const list = await requestJson(connection.baseUrl + '/clusters', { headers: connection.headers, signal: AbortSignal.timeout(20000) }, 'Cluster');
      let runtime = { ok: false, configured: false, message: 'Keine vollständigen Runtime-Zugangsdaten konfiguriert.' };
      try {
        const process = processConnection(liveMatch[1]);
        runtime.configured = true;
        const token = await getClusterAccessToken(process.credentials, 'operate.camunda.io');
        await requestJson(process.operateBaseUrl + '/v1/process-instances/search', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ size: 1 }), signal: AbortSignal.timeout(20000) }, 'Runtime');
        runtime = { ok: true, configured: true, message: 'Operate lesend erreichbar.' };
      } catch (error) { if (runtime.configured) runtime.message = error.message; }
      return sendJson(response, 200, { ok: true, checkedAt, runtime, clusters: list.map(item => ({ name: item.name, status: item.status || item.state || 'Unbekannt', version: item.generation?.name || '–', region: item.region?.name || '–' })) });
    } catch (error) { return sendJson(response, 200, { ok: false, checkedAt, error: error.message }); }
  }

  if (request.method === 'GET' && url.pathname === '/api/clusters') {
    return sendJson(response, 200, Object.entries(clusters).map(([id, cluster]) => ({ id, name: cluster.name })));
  }
  const definitionPreviewMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/definitions\/cleanup-preview$/);
  if (RUNTIME_CLEANUP_ENABLED && request.method === 'GET' && definitionPreviewMatch) {
    try {
      const connection = processConnection(definitionPreviewMatch[1]);
      const snapshot = await definitionSnapshot(connection);
      const instances = await searchProcessInstances(connection, 10_000);
      const activeInstances = instances.instances.filter((instance) => instance.state === 'ACTIVE').length;
      return sendJson(response, 200, {
        processCount: snapshot.processCount,
        drdCount: snapshot.drdCount,
        total: snapshot.total,
        activeInstances,
        formsSupported: false,
        clusterVersion: '8.7.21',
        confirmation: `DELETE DEFINITIONS ${connection.cluster.name.toUpperCase()}`,
      });
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const definitionCleanupMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/definitions\/cleanup$/);
  if (RUNTIME_CLEANUP_ENABLED && request.method === 'GET' && definitionCleanupMatch) {
    return sendJson(response, 200, definitionCleanupJobs.get(definitionCleanupMatch[1]) || { status: 'idle' });
  }
  if (RUNTIME_CLEANUP_ENABLED && request.method === 'POST' && definitionCleanupMatch) {
    try {
      const clusterId = definitionCleanupMatch[1];
      const existing = definitionCleanupJobs.get(clusterId);
      if (existing?.status === 'running') return sendJson(response, 409, { error: 'Für diesen Standort läuft bereits ein Definitions-Cleanup.' });
      const input = await readJsonBody(request);
      const connection = processConnection(clusterId);
      const snapshot = await definitionSnapshot(connection);
      const requiredConfirmation = `DELETE DEFINITIONS ${connection.cluster.name.toUpperCase()}`;
      if (input.confirmation !== requiredConfirmation || Number(input.expectedCount) !== snapshot.total) {
        return sendJson(response, 409, { error: 'Bestätigung oder Definitionsanzahl stimmt nicht mehr. Bitte Vorschau aktualisieren.' });
      }
      if (!snapshot.total) return sendJson(response, 409, { error: 'Keine Prozess- oder DMN-Definitionen zum Löschen vorhanden.' });
      const unsafeKey = [...snapshot.processes, ...snapshot.drds].some((item) => typeof item.key === 'number' && !Number.isSafeInteger(item.key));
      if (unsafeKey) return sendJson(response, 409, { error: 'Mindestens ein Definitions-Key ist nicht verlustfrei darstellbar; Cleanup wurde nicht gestartet.' });
      const instances = await searchProcessInstances(connection, 10_000);
      const activeInstances = instances.instances.filter((instance) => instance.state === 'ACTIVE').length;
      if (activeInstances) return sendJson(response, 409, { error: `Es existieren noch ${activeInstances} aktive Prozessinstanzen. Diese müssen zuerst beendet werden.` });
      const job = {
        status: 'running',
        phase: 'starting',
        phaseLabel: 'Definitions-Cleanup wird vorbereitet',
        startedAt: new Date().toISOString(),
        processCount: snapshot.processCount,
        drdCount: snapshot.drdCount,
        total: snapshot.total,
        processed: 0,
        deleted: 0,
        alreadyMissing: 0,
        failed: 0,
        formsSupported: false,
        errors: [],
      };
      definitionCleanupJobs.set(clusterId, job);
      runDefinitionCleanup(clusterId, snapshot, job).catch((error) => {
        job.status = 'failed';
        job.phase = 'failed';
        job.phaseLabel = 'Definitions-Cleanup abgebrochen';
        job.failed += 1;
        if (job.errors.length < 25) job.errors.push(error.message);
        job.finishedAt = new Date().toISOString();
      });
      return sendJson(response, 202, job);
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const cleanupPreviewMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/process-instances\/cleanup-preview$/);
  if (RUNTIME_CLEANUP_ENABLED && request.method === 'GET' && cleanupPreviewMatch) {
    try {
      const connection = processConnection(cleanupPreviewMatch[1]);
      const { instances, total } = await searchProcessInstances(connection, 10_000);
      if (instances.length < total) throw new Error('Mehr als 10.000 Instanzen gefunden; ein ungefilterter Cleanup wird aus Sicherheitsgründen nicht angeboten.');
      const preview = cleanupPreview(instances);
      return sendJson(response, 200, { ...preview, total, confirmation: `CLEAN ${connection.cluster.name.toUpperCase()}` });
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const cleanupStatusMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/process-instances\/cleanup$/);
  if (RUNTIME_CLEANUP_ENABLED && request.method === 'GET' && cleanupStatusMatch) {
    return sendJson(response, 200, cleanupJobs.get(cleanupStatusMatch[1]) || { status: 'idle' });
  }
  if (RUNTIME_CLEANUP_ENABLED && request.method === 'POST' && cleanupStatusMatch) {
    try {
      const clusterId = cleanupStatusMatch[1];
      const existing = cleanupJobs.get(clusterId);
      if (existing?.status === 'running') return sendJson(response, 409, { error: 'Für diesen Standort läuft bereits ein Cleanup.' });
      const input = await readJsonBody(request);
      const connection = processConnection(clusterId);
      const { instances, total } = await searchProcessInstances(connection, 10_000);
      if (instances.length < total) return sendJson(response, 409, { error: 'Mehr als 10.000 Instanzen gefunden; Cleanup wurde nicht gestartet.' });
      const preview = cleanupPreview(instances);
      const requiredConfirmation = `CLEAN ${connection.cluster.name.toUpperCase()}`;
      if (input.confirmation !== requiredConfirmation || Number(input.expectedRootCount) !== preview.rootCount) {
        return sendJson(response, 409, { error: 'Bestätigung oder Instanzanzahl stimmt nicht mehr. Bitte Vorschau aktualisieren.' });
      }
      if (!preview.rootCount) return sendJson(response, 409, { error: 'Keine Root-Prozessinstanzen zum Bereinigen vorhanden.' });
      const unsafeKey = instances.some((instance) => typeof instance.key === 'number' && !Number.isSafeInteger(instance.key));
      if (unsafeKey) return sendJson(response, 409, { error: 'Mindestens ein Instanz-Key ist nicht verlustfrei darstellbar; Cleanup wurde nicht gestartet.' });
      const job = {
        status: 'running',
        phase: 'starting',
        phaseLabel: 'Cleanup wird vorbereitet',
        startedAt: new Date().toISOString(),
        rootCount: preview.rootCount,
        childCount: preview.childCount,
        totalToCancel: preview.activeRootCount,
        totalToDelete: 0,
        cancelled: 0,
        deleted: 0,
        failed: 0,
        remainingActive: preview.activeRootCount,
        errors: [],
      };
      cleanupJobs.set(clusterId, job);
      runProcessCleanup(clusterId, instances, job).catch((error) => {
        job.status = 'failed';
        job.phase = 'failed';
        job.phaseLabel = 'Cleanup abgebrochen';
        job.failed += 1;
        if (job.errors.length < 25) job.errors.push(error.message);
        job.finishedAt = new Date().toISOString();
      });
      return sendJson(response, 202, job);
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const clusterCreateMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/clusters\/create$/);
  if (request.method === 'POST' && clusterCreateMatch) {
    try {
      const input = await readJsonBody(request);
      const result = await createCluster(clusterCreateMatch[1], input);
      return sendJson(response, 201, result);
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const clusterDeleteMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/clusters\/delete$/);
  if (request.method === 'POST' && clusterDeleteMatch) {
    try {
      const input = await readJsonBody(request);
      const result = await deleteCluster(clusterDeleteMatch[1], String(input.clusterUuid || ''), input.confirmation);
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const clusterSecretMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/clusters\/([^/]+)\/sync-secrets$/);
  if (request.method === 'POST' && clusterSecretMatch) {
    try {
      const result = await syncClusterSecrets(clusterSecretMatch[1], decodeURIComponent(clusterSecretMatch[2]));
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const projectDeleteStatusMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/projects\/delete\/status$/);
  if (request.method === 'GET' && projectDeleteStatusMatch) {
    return sendJson(response, 200, projectDeletionJobs.get(projectDeleteStatusMatch[1]) || { status: 'idle', events: [] });
  }
  const projectDeleteMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/projects\/delete$/);
  if (request.method === 'POST' && projectDeleteMatch) {
    try {
      const clusterId = projectDeleteMatch[1];
      const activeJob = projectDeletionJobs.get(clusterId);
      if (activeJob?.status === 'running') return sendJson(response, 409, { error: 'Für diesen Standort läuft bereits eine Projektlöschung.' });
      const input = await readJsonBody(request);
      const projectIds = [...new Set((Array.isArray(input.projectIds) ? input.projectIds : []).map(String))];
      if (!projectIds.length || projectIds.length > 500) return sendJson(response, 400, { error: 'Es müssen zwischen 1 und 500 Projekte ausgewählt sein.' });
      if (projectIds.some((id) => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) return sendJson(response, 400, { error: 'Mindestens eine Projekt-ID ist ungültig.' });
      const requiredConfirmation = `DELETE ${projectIds.length} PROJECTS`;
      if (input.confirmation !== requiredConfirmation) return sendJson(response, 409, { error: `Bestätigung stimmt nicht. Erwartet wird ${requiredConfirmation}.` });
      const job = {
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        totalProjects: projectIds.length,
        currentProject: 0,
        currentProjectName: null,
        deleted: [],
        alreadyMissing: [],
        failed: [],
        deletedFiles: 0,
        deletedFolders: 0,
        events: [],
      };
      projectDeletionJobs.set(clusterId, job);
      addProjectDeletionEvent(job, `Löschlauf gestartet: ${projectIds.length} Projekte`, 0, 'project');
      deleteProjects(clusterId, projectIds, job).catch((error) => {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.currentProjectName = null;
        job.failed.push({ projectId: '', error: error.message });
        addProjectDeletionEvent(job, `Löschlauf abgebrochen: ${error.message}`, 0, 'error');
      });
      return sendJson(response, 202, job);
    } catch (error) {
      return sendJson(response, 502, { error: error.message });
    }
  }
  const match = url.pathname.match(/^\/api\/(basel|brugg|olten)\/(members|projects|connectors|clusters|activities)$/);
  if (request.method === 'GET' && match) {
    try {
      const result = await loadResource(match[1], match[2]);
      return sendJson(response, 200, result);
    } catch (error) {
      console.error(`${match[1]}/${match[2]}:`, error.message);
      return sendJson(response, 502, { error: error.message });
    }
  }
  const deleteMatch = url.pathname.match(/^\/api\/(basel|brugg|olten)\/members\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteMatch) {
    try {
      const email = decodeURIComponent(deleteMatch[2]);
      await deleteMember(deleteMatch[1], email);
      return sendJson(response, 200, { deleted: email });
    } catch (error) {
      console.error(`${deleteMatch[1]}/members delete:`, error.message);
      return sendJson(response, 502, { error: error.message });
    }
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveStatic(response, 'index.html', 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/dashboard.js') return serveStatic(response, 'dashboard.js', 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/app.js') return serveStatic(response, 'app.js', 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/styles.css') return serveStatic(response, 'styles.css', 'text/css; charset=utf-8');
  response.writeHead(404);
  response.end('Not found');
}).listen(PORT, HOST, () => console.log(`Camunda Cleanup läuft auf http://${HOST}:${PORT}`));
