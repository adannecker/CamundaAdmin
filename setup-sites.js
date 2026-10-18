const fs = require('node:fs');
const path = require('node:path');
const { CamundaApi, readCredentials } = require('./lib/camunda-api');
const { SiteSetup } = require('./lib/site-setup');

async function main() {
  const root = __dirname;
  const setup = new SiteSetup({ root, organizationApiForSite: site => new CamundaApi(readCredentials(path.join(root, `credentials_${site}.txt`)), { freshReads: true }) });
  const args = process.argv.slice(2);
  let result;
  if (!args.length) result = { sites: await setup.all() };
  else if (args.length === 3 && args[0] === '--apply') result = await setup.apply(args[1], args[2]);
  else throw new Error('Aufruf: node setup-sites.js [--apply basel|brugg|olten create-client|create-role|student-grants|client-grants|support-access]');
  fs.writeFileSync(path.join(root, 'site-readiness.local.json'), JSON.stringify({ checkedAt: new Date().toISOString(), result }, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message + ' Kein automatischer Wiederholungsversuch. Bestand vor weiteren Aktionen neu prüfen.'); process.exitCode = 1; });
module.exports = { main };
