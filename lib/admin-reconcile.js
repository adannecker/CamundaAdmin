const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { loadAdminConfig, readAdminInventory, adminRolePreview, SITE_IDS } = require('./admin-config');

class ReconcileError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const sameRoles = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function fingerprint(config, inventory) {
  const rows = adminRolePreview(config, inventory).map(row => ({ ...row,
    currentRoles: row.currentRoles && [...row.currentRoles].sort(),
    targetRoles: row.targetRoles && [...row.targetRoles].sort(), removeRoles: [...row.removeRoles].sort(),
    pending: inventory.sites[row.site].members?.find(m => m.email === row.email)?.pending ?? null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function assertInventory(config, inventory) {
  for (const site of SITE_IDS) {
    if (config.lecturers.some(p => p.sites[site]) && !inventory.sites[site]?.ok) throw new ReconcileError(`Standort ${site} konnte nicht vollständig geprüft werden. Keine Freigabe zum Anwenden.`, 502);
    for (const owner of config.protectedOwners.filter(p => p.sites[site])) {
      if (!inventory.sites[site]?.ok || !inventory.sites[site].members.some(m => m.email === owner.email && m.roles.includes('owner'))) throw new ReconcileError(`Owner-Zugriff in ${site} weicht ab. Vor einem Rollenabgleich prüfen.`);
    }
  }
}

class AdminReconciler {
  constructor({ configFile, apiForSite, now = Date.now, wait = delay }) {
    this.configFile = configFile; this.apiForSite = apiForSite; this.now = now; this.wait = wait;
    this.plans = new Map(); this.applying = false;
  }

  async preview(revision) {
    if (this.applying) throw new ReconcileError('Ein Abgleich läuft bereits.');
    const loaded = loadAdminConfig(this.configFile);
    if (loaded.revision !== revision) throw new ReconcileError('Die Konfiguration wurde geändert. Bitte neu laden und Vorschau neu erstellen.');
    const inventory = await readAdminInventory(loaded.config, this.apiForSite);
    assertInventory(loaded.config, inventory);
    // Re-read after the network calls: do not arm a preview for an outdated local file.
    if (loadAdminConfig(this.configFile).revision !== revision) throw new ReconcileError('Die Konfiguration wurde während der Prüfung geändert.');
    const rows = adminRolePreview(loaded.config, inventory);
    const changes = rows.filter(row => ['invite', 'update'].includes(row.action));
    const publicPlan = { id: crypto.randomUUID(), revision, expiresAt: new Date(this.now() + 10 * 60 * 1000).toISOString(), changes, rows,
      protectedCount: rows.filter(row => row.action === 'protected').length, unchangedCount: rows.filter(row => row.action === 'unchanged').length };
    for (const [id, plan] of this.plans) if (plan.status !== 'ready' || plan.expires <= this.now()) this.plans.delete(id);
    if (this.plans.size >= 50) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(publicPlan.id, { ...loaded, ...publicPlan, snapshot: fingerprint(loaded.config, inventory), expires: this.now() + 10 * 60 * 1000, status: 'ready' });
    return { preview: publicPlan, inventory, appliedToCamunda: false };
  }

  async apply(id) {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== 'ready') throw new ReconcileError('Vorschau fehlt oder wurde bereits verwendet. Bitte neu vorbereiten.');
    if (this.applying) throw new ReconcileError('Ein Abgleich läuft bereits.');
    plan.status = 'used';
    if (plan.expires <= this.now()) throw new ReconcileError('Vorschau ist abgelaufen. Bitte neu vorbereiten.');
    if (!plan.changes.length) throw new ReconcileError('Es gibt keine anzuwendenden Änderungen.');
    this.applying = true;
    const results = [];
    try {
      if (loadAdminConfig(this.configFile).revision !== plan.revision) throw new ReconcileError('Konfiguration wurde nach der Vorschau geändert. Nichts angewendet.');
      const apis = new Map();
      const apiForSite = site => { if (!apis.has(site)) apis.set(site, this.apiForSite(site)); return apis.get(site); };
      const inventory = await readAdminInventory(plan.config, apiForSite);
      assertInventory(plan.config, inventory);
      if (fingerprint(plan.config, inventory) !== plan.snapshot) throw new ReconcileError('Camunda-Stand wurde nach der Vorschau geändert. Nichts angewendet; bitte neu vorbereiten.');

      for (const change of plan.changes) {
        let submitted = false;
        try {
          if (loadAdminConfig(this.configFile).revision !== plan.revision) throw new Error('Konfiguration wurde während des Abgleichs geändert.');
          const api = apiForSite(change.site);
          const info = await api.hub('/info');
          if (info.authorizedOrganization !== plan.config.organizations[change.site]) throw new Error('Organisation stimmt nicht mehr überein.');
          const members = await api.console('/members');
          if (!Array.isArray(members)) throw new Error('Mitglieder konnten nicht geprüft werden.');
          const member = members.find(m => String(m.email).toLowerCase() === change.email);
          if (member?.roles.includes('owner') || plan.config.protectedOwners.some(p => p.email === change.email)) throw new Error('Owner-Konto bleibt geschützt.');
          if ((change.action === 'invite' && member) || (change.action === 'update' && (!member || !sameRoles(member.roles, change.currentRoles)))) throw new Error('Mitglied oder Rollen wurden zwischenzeitlich geändert.');
          submitted = true;
          await api.console(`/members/${encodeURIComponent(change.email)}`, { method: 'POST', body: { orgRoles: change.targetRoles } });
          let observed = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await this.wait(attempt === 1 ? 250 : 750);
            const updated = await api.console('/members');
            if (!Array.isArray(updated)) throw new Error('Nachprüfung lieferte keine Mitgliederliste.');
            observed = updated.find(m => String(m.email).toLowerCase() === change.email);
            if (observed && sameRoles(observed.roles, change.targetRoles)) break;
          }
          const verified = Boolean(observed && sameRoles(observed.roles, change.targetRoles));
          results.push({ ...change, status: verified ? 'verified' : 'pending', invitationPending: Boolean(observed?.invitePending), message: verified ? 'Änderung lesend bestätigt.' : 'API-Aufruf angenommen; Nachprüfung noch nicht bestätigt. Keine automatische Wiederholung.' });
          if (!verified) break;
        } catch (error) {
          results.push({ ...change, status: submitted ? 'uncertain' : 'failed', message: `${error.message} Weitere Änderungen gestoppt; keine automatische Wiederholung.` });
          break;
        }
      }
      const completed = results.length === plan.changes.length && results.every(r => r.status === 'verified');
      return { status: completed ? 'completed' : 'incomplete', results, notAttempted: plan.changes.slice(results.length), appliedToCamunda: results.some(r => ['verified', 'pending', 'uncertain'].includes(r.status)) };
    } finally { this.applying = false; }
  }
}

module.exports = { AdminReconciler, ReconcileError };
