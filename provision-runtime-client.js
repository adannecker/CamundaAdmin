const fs = require('node:fs');
const path = require('node:path');
const { CamundaApi, readCredentials } = require('./lib/camunda-api');
const { validateConfig } = require('./lib/onboarding');

async function main() {
  const [filename, ...args] = process.argv.slice(2);
  if (!filename) throw new Error('Konfigurationsdatei fehlt.');
  const absolute = path.resolve(filename);
  const config = validateConfig(JSON.parse(fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')));
  const directory = path.dirname(absolute);
  const clientName = config.runtimeClientName;
  if (typeof clientName !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clientName)) throw new Error('runtimeClientName fehlt oder ist ungültig.');
  if (!config.runtimeCredentialsFile) throw new Error('runtimeCredentialsFile fehlt.');
  const target = path.resolve(directory, config.runtimeCredentialsFile);
  const api = new CamundaApi(readCredentials(path.resolve(directory, config.credentialsFile)));
  const info = await api.hub('/info');
  if (info.authorizedOrganization !== config.expectedOrganization) throw new Error('Falsche Organisation.');
  const clusterId = new URL(config.runtimeBase).pathname.slice(1);
  const endpoint = `/clusters/${clusterId}/clients`;
  const clients = await api.console(endpoint);
  if (!Array.isArray(clients)) throw new Error('Unerwartete Client-Liste.');
  const existing = clients.filter(client => client.name === clientName);
  if (!args.length) {
    console.log(JSON.stringify({ clientName, clusterId, permissions: ['Zeebe'], existing: existing.length, credentialsFileExists: fs.existsSync(target) }, null, 2));
    return;
  }
  if (args.length !== 2 || args[0] !== '--confirm' || args[1] !== clientName) throw new Error('Neuanlage benötigt --confirm mit dem exakten Clientnamen.');
  if (existing.length) throw new Error('Client existiert bereits. Kein Duplikat und keine Löschung ausgeführt.');
  // Reserve the secret file before creating a client whose secret is shown only once.
  const fd = fs.openSync(target, 'wx', 0o600);
  let created = false;
  try {
    const client = await api.console(endpoint, { method: 'POST', body: { clientName, permissions: ['Zeebe'] } });
    created = true;
    if (!client.clientId || !client.clientSecret) throw new Error('Client wurde erstellt, Antwort enthält aber keine vollständigen Credentials.');
    const entries = {
      CAMUNDA_CLIENT_ID: client.clientId,
      CAMUNDA_CLIENT_SECRET: client.clientSecret,
      CAMUNDA_CLUSTER_ID: clusterId,
      CAMUNDA_REST_ADDRESS: config.runtimeBase,
      CAMUNDA_OAUTH_URL: 'https://login.cloud.camunda.io/oauth/token',
      CAMUNDA_TOKEN_AUDIENCE: client.audience || 'zeebe.camunda.io',
    };
    if (Object.values(entries).some(value => /[\r\n]/.test(value))) throw new Error('Unerwarteter mehrzeiliger Credential-Wert.');
    fs.writeFileSync(fd, Object.entries(entries).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
    console.log(JSON.stringify({ created: true, name: clientName, clientId: client.clientId, permissions: client.permissions, credentialsFile: target, note: 'Cluster-Rollen separat prüfen und gezielt zuweisen.' }, null, 2));
  } catch (error) {
    if (!created) { fs.closeSync(fd); fs.unlinkSync(target); }
    throw error;
  } finally {
    if (created) fs.closeSync(fd);
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
