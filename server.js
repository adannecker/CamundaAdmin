const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3300);
const ROOT = __dirname;

const clusters = {
  basel: { name: 'Basel', credentials: 'credentials_basel - test.txt' },
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
const tokenCache = new Map();

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

function connectorMetadata(cluster, secret, key) {
  const { secretValue, value, ...metadata } = secret || {};
  return { cluster: cluster.name || cluster.uuid, clusterUuid: cluster.uuid, ...(key ? { key } : {}), ...metadata };
}

async function loadResource(clusterId, resourceId) {
  const cluster = clusters[clusterId];
  const resource = resources[resourceId];
  if (!cluster || !resource) return null;

  const credentials = readCredentials(cluster.credentials);
  const required = ['CAMUNDA_OAUTH_URL', 'CAMUNDA_CONSOLE_CLIENT_ID', 'CAMUNDA_CONSOLE_CLIENT_SECRET', 'CAMUNDA_CONSOLE_OAUTH_AUDIENCE'];
  if (required.some((key) => !credentials[key])) throw new Error(`Unvollständige Zugangsdaten für ${cluster.name}.`);

  const token = await getAccessToken(credentials);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

  if (resource.kind === 'projects') {
    const requestOptions = (page) => ({
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ page, size: 25 }),
    });
    const firstPage = await requestJson('https://modeler.camunda.io/api/v1/projects/search', requestOptions(0), resource.label);
    const projects = [...(firstPage.items || [])];
    const total = Number(firstPage.total) || projects.length;
    for (let page = 1; projects.length < total; page += 1) {
      const result = await requestJson('https://modeler.camunda.io/api/v1/projects/search', requestOptions(page), resource.label);
      const items = result.items || [];
      if (!items.length) break;
      projects.push(...items);
    }
    return { cluster: cluster.name, resource: resource.label, data: projects };
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
    const safeEvents = list.map((event) => ({
      timestamp: event.timestamp,
      service: event.service,
      action: event.audit,
      actionType: event.auditType,
      entity: event.entity,
      entityId: event.entityId,
      userId: event.userId,
      parentEntity: event.parentEntity,
    }));
    return { cluster: cluster.name, resource: resource.label, data: safeEvents };
  }

  const data = await requestJson(consoleApiUrl(credentials, resource.path), { method: resource.method, headers }, resource.label);
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
    response.writeHead(200, { 'content-type': type });
    response.end(data);
  });
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'GET' && url.pathname === '/api/clusters') {
    return sendJson(response, 200, Object.entries(clusters).map(([id, cluster]) => ({ id, name: cluster.name })));
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
  if (request.method === 'GET' && url.pathname === '/app.js') return serveStatic(response, 'app.js', 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/styles.css') return serveStatic(response, 'styles.css', 'text/css; charset=utf-8');
  response.writeHead(404);
  response.end('Not found');
}).listen(PORT, HOST, () => console.log(`Camunda Cleanup läuft auf http://${HOST}:${PORT}`));
