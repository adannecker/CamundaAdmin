const path = require('node:path');
const { initializeStore } = require('./lib/state-store');

function main() {
  const args = process.argv.slice(2), at = args.indexOf('--root');
  if (at < 0 || !args[at + 1] || args.some((a, i) => !['--root', '--prune', '--backup-confirmed'].includes(a) && i !== at + 1)) throw new Error('Aufruf: node migrate-data.js --root DATENORDNER [--prune --backup-confirmed]');
  if (args.includes('--prune') && !args.includes('--backup-confirmed')) throw new Error('Vor der Bereinigung eine konsistente Sicherung erstellen und mit --backup-confirmed bestätigen.');
  const store = initializeStore(path.resolve(args[at + 1]));
  try {
    const migratedFiles = store.verifyLegacy(); store.verifyAudit();
    const counts = Object.fromEntries(['organizations', 'lecturers', 'class_runs', 'class_groups', 'class_students', 'lecturer_resources', 'receipts', 'documents'].map(table => [table, store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
    const events = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get() ? store.db.prepare('SELECT count(*) AS n FROM events').get().n : 0;
    const removedFiles = args.includes('--prune') ? store.pruneLegacy() : 0;
    console.log(JSON.stringify({ ok: true, migratedFiles, counts, events, removedFiles }));
  } finally { store.close(); }
}
if (require.main === module) { try { main(); } catch (error) { console.error('Datenbankmigration/Bereinigung gestoppt: ' + (error instanceof SyntaxError ? 'Ungültiges JSON in einer Quelldatei.' : error.message)); process.exitCode = 1; } }
module.exports = { main };
