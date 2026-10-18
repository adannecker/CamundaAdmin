const fs = require('node:fs');
const path = require('node:path');
const { CamundaApi, readCredentials } = require('./lib/camunda-api');
const { Onboarding } = require('./lib/onboarding');
const { TenancySetup } = require('./lib/tenancy');

async function main() {
  const [filename, ...args] = process.argv.slice(2);
  if (!filename) throw new Error('Lokale Konfigurationsdatei fehlt.');
  const absolute = path.resolve(filename);
  const directory = path.dirname(absolute);
  const config = JSON.parse(fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, ''));
  const action = args[0];
  const apply = ['--groups-only', '--support-access'].includes(action);
  if (args.length && !(apply && args.length === 3 && args[1] === '--confirm' && args[2] === config.expectedOrganization) && !(args.length === 1 && action === '--verify')) throw new Error('Erlaubt: --verify oder --groups-only/--support-access mit --confirm und exakter Organisations-ID.');
  const organizationApi = new CamundaApi(readCredentials(path.resolve(directory, config.credentialsFile)));
  const credentials = readCredentials(path.resolve(directory, config.runtimeCredentialsFile));
  const runtimeApi = new CamundaApi(credentials);
  const runner = new TenancySetup(new Onboarding(organizationApi, config, runtimeApi), runtimeApi, credentials.CAMUNDA_CLIENT_ID);
  const result = action === '--groups-only' ? await runner.prepare() : action === '--support-access' ? await runner.prepareSupportAccess() : action === '--verify' ? await runner.verify() : await runner.plan();
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), result }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
