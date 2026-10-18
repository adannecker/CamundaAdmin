const { loadOpenAiConfig, checkOpenAiConnection } = require('./lib/openai');

async function main() {
  console.log(JSON.stringify(await checkOpenAiConnection(loadOpenAiConfig()), null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
