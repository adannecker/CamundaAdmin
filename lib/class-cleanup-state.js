const dataStore = require('./state-store');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Reconcile only definitive deletion receipts, never infer deletion from a failed API read.
function reconcileClassCleanup(root, { busy = false } = {}) {
  const file = path.join(root, 'classes.local.json');
  if (busy || !dataStore.exists(file)) return 0;
  const receipts = dataStore.list(root).filter(name => /^cleanup-(basel|brugg|olten)-[a-f0-9-]{36}\.local\.json$/.test(name)).flatMap(name => {
    try { const r = dataStore.readJson(path.join(root, name)); return ['completed', 'incomplete'].includes(r.status) && Number.isFinite(Date.parse(r.checkedAt)) ? [{ ...r, receiptId: name }] : []; }
    catch { return []; }
  }).sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  let fd, changed = 0; const lock = path.join(root, 'classes-lock.local.json');
  try {
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return 0; throw error; }
    const data = dataStore.readJson(file);
    for (const c of data.classes) {
      const since = Math.max(Date.parse(c.createdAt) || 0, Date.parse(c.autoAccess?.authorizedAt) || 0);
      const lifecycle = c.cleanupState || { receipts: [], students: [], workspaces: [], groups: [], tenants: [] };
      let affected = false;
      for (const r of receipts) {
        if (r.site !== c.site || Date.parse(r.checkedAt) < since || lifecycle.receipts.includes(r.receiptId)) continue;
        const matches = (r.results || []).filter(x => x.status === 'verified' && (
          x.kind === 'students' && c.groups.some(g => g.students.some(s => s.email === x.id)) ||
          x.kind === 'workspaces' && c.groups.some(g => g.workspaceKey === x.id) ||
          x.kind === 'groups' && c.groups.some(g => g.runtimeGroupId === x.id) ||
          x.kind === 'tenants' && c.groups.some(g => g.tenantId === x.id)));
        if (!matches.length) continue;
        for (const x of matches) if (!lifecycle[x.kind].includes(x.id)) lifecycle[x.kind].push(x.id);
        lifecycle.receipts.push(r.receiptId); lifecycle.checkedAt = r.checkedAt; affected = true;
      }
      if (!affected) continue;
      c.cleanupState = lifecycle;
      c.status = c.groups.length && c.groups.every(g => lifecycle.workspaces.includes(g.workspaceKey) && lifecycle.tenants.includes(g.tenantId) && lifecycle.groups.includes(g.runtimeGroupId) && g.students.every(s => lifecycle.students.includes(s.email))) ? 'cleaned' : 'attention';
      c.pendingStudents = (c.pendingStudents || []).filter(s => !lifecycle.students.includes(s.email));
      c.autoAccess = { ...c.autoAccess, enabled: false, status: 'cleanup', lastError: 'Bestätigte Löschung erkannt. Automatik beendet; vor erneuter Einrichtung einen neuen Entwurf prüfen.' };
      c.revision = crypto.randomUUID(); changed++;
    }
    if (changed) { dataStore.writeJson(file, data); }
    return changed;
  } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
}
module.exports = { reconcileClassCleanup };
