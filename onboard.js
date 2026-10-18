const dataStore = require('./lib/state-store');
const fs = require('node:fs');
const path = require('node:path');
const { CamundaApi, readCredentials } = require('./lib/camunda-api');
const { Onboarding } = require('./lib/onboarding');

async function main() {
  const [configFile, ...args] = process.argv.slice(2);
  if (!configFile || args.includes('--help')) {
    console.log('node onboard.js <config.local.json> [--structure | --hub-access | --runtime-access] [--confirm "Workspace-Name"]');
    return;
  }
  const modes = args.filter(arg => ['--structure', '--hub-access', '--runtime-access'].includes(arg));
  if (modes.length > 1) throw new Error('Nur eine Ausführungsphase je Aufruf auswählen.');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--confirm') { if (!args[index + 1]) throw new Error('Bestätigung fehlt.'); index++; }
    else if (!modes.includes(args[index])) throw new Error('Unbekanntes Argument.');
  }
  const absolute = path.resolve(configFile);
  if (fs.existsSync(path.join(path.dirname(absolute), 'camundaadmin.sqlite'))) dataStore.initializeStore(path.dirname(absolute));
  const config = dataStore.readJson(absolute);
  const directory = path.dirname(absolute);
  const credentials = readCredentials(path.resolve(directory, config.credentialsFile));
  const api = new CamundaApi(credentials);
  let runtimeApi = null;
  if (config.runtimeCredentialsFile && fs.existsSync(path.resolve(directory, config.runtimeCredentialsFile))) {
    runtimeApi = new CamundaApi({ ...credentials, ...readCredentials(path.resolve(directory, config.runtimeCredentialsFile)) });
  }
  const runner = new Onboarding(api, config, runtimeApi);
  const mode = modes[0];
  if (['--hub-access', '--runtime-access'].includes(mode) && (!args.includes('--confirm') || args[args.indexOf('--confirm') + 1] !== runner.config.workspaceName)) throw new Error('Zugriffsänderungen benötigen --confirm mit dem exakten Workspace-Namen.');
  let result;
  if (mode === '--structure') result = await runner.ensureStructure();
  else if (mode === '--hub-access') result = await runner.ensureHubAccess();
  else if (mode === '--runtime-access') result = await runner.ensureRuntimeAccess();
  else result = await runner.plan();
  console.log(JSON.stringify({ phase: mode || 'plan', checkedAt: new Date().toISOString(), result }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
