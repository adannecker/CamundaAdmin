const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { searchAll } = require('./onboarding');
const emailOf = p => String(p.email || p.username || '').toLowerCase();
const blocked = message => Object.assign(new Error(message), { stopAccess: true });

// Only completes previously approved user assignments; never creates resources,
// sends organization invitations, changes roles or removes access.
class ClassAccess {
  constructor(manager) { this.manager = manager; this.running = false; }
  scope(c) {
    return crypto.createHash('sha256').update(JSON.stringify({ id: c.id, site: c.site, lecturerEmail: c.lecturerEmail,
      groups: c.groups.map(g => ({ id: g.id, workspaceKey: g.workspaceKey, tenantId: g.tenantId, runtimeGroupId: g.runtimeGroupId, emails: g.students.map(s => s.email).sort() })).sort((a, b) => a.id.localeCompare(b.id)) })).digest('hex');
  }
  authorize(c, context) {
    return { enabled: true, status: c.pendingStudents?.length ? 'waiting' : 'completed', scope: this.scope(c), contextRevision: context.revision,
      authorizedAt: new Date(this.manager.now()).toISOString(), nextCheckAt: this.manager.now() };
  }
  assertStructure(c, state) {
    for (const g of c.groups) {
      const r = state.resources.find(r => r.groupId === g.id);
      if (!r?.workspace || !r.tenant || !r.group || !r.tm.groups.some(x => x.groupId === g.runtimeGroupId) || !r.gr.some(x => x.roleId === 'studierende') || !r.grants.some(a => a.resourceType === 'TENANT' && a.resourceId === g.tenantId && a.permissionTypes?.includes('READ')) || !r.wm.some(m => emailOf(m) === c.lecturerEmail && m.role === 'workspace_admin')) throw blocked('Klassenstruktur oder bestätigte Gruppenrechte fehlen. Einrichtung zuerst manuell prüfen.');
    }
  }
  observed(c, g, email, event, summary, status = 'verified') {
    // This is the time of a confirmed API observation, never an inferred login time.
    // Stable IDs make repeated checks and process restarts safe without duplicate events.
    const id = 'student-access-' + crypto.createHash('sha256').update(JSON.stringify([c.id, c.createdAt, g.id, g.workspaceKey, g.runtimeGroupId, g.tenantId, email, event])).digest('hex');
    this.manager.audit?.record({ id, at: new Date(this.manager.now()).toISOString(), event, status,
      site: c.site, classId: c.id, lecturerEmail: c.lecturerEmail, email, groupName: g.name, summary });
  }
  async sync(c, state, save, { initial = false, write = async (_label, call) => call() } = {}) {
    const targets = initial ? c.groups.flatMap(g => g.students.map(s => s.email)) : (c.pendingStudents || []).map(s => s.email);
    const pending = [], seg = encodeURIComponent;
    for (const email of targets) {
      const g = c.groups.find(g => g.students.some(s => s.email === email));
      if (!g) throw blocked('Ausstehendes Konto ist keiner freigegebenen Gruppe mehr zugeordnet.');
      this.manager.audit?.enrich({ email, groupName: g.name });
      const member = (await state.api.console('/members')).find(m => emailOf(m) === email);
      if (state.cxt.protectedEmails.includes(email) || member?.roles?.some(r => !['member', 'modeler'].includes(r))) throw blocked('Konto hat zusätzliche Rollen erhalten. Automatische Zuweisung angehalten.');
      if (!member) { pending.push({ email, reason: 'Organisationseinladung noch nicht sichtbar oder Mitgliedschaft entfernt; keine erneute Einladung.' }); continue; }
      if (member.invitePending === false) this.observed(c, g, email, 'student.accepted', 'Camunda meldet die Organisationseinladung als angenommen. Bei dieser Prüfung erkannt; kein Anmeldezeitpunkt.');
      const workspaceMembers = () => searchAll(state.api, '/members/search', { workspaceKey: { $eq: g.workspaceKey } });
      let workspaceMember = (await workspaceMembers()).find(m => emailOf(m) === email);
      if (workspaceMember && workspaceMember.role !== 'editor') throw blocked('Workspace-Rolle weicht von Editor ab. Automatische Zuweisung angehalten.');
      const key = g.id + ':' + email;
      c.workspaceAccessAttempts ||= {};
      const receipt = c.workspaceAccessAttempts[key];
      if (!workspaceMember && (!receipt || (receipt.status === 'deferred' && !member.invitePending))) {
        c.workspaceAccessAttempts[key] = { status: 'reserved', at: new Date(this.manager.now()).toISOString() }; save();
        try {
          await write('Workspace-Zugriff / Einladung vorbereiten', async () => {
            try { await state.api.hub('/workspaces/' + seg(g.workspaceKey) + '/members', { method: 'POST', body: { email, role: 'editor' } }); }
            catch (error) {
              if (error.status !== 400) throw error;
              const current = (await workspaceMembers()).find(m => emailOf(m) === email);
              if (current && current.role !== 'editor') throw blocked('Workspace-Rolle wurde geändert.');
              if (!current) await state.api.request('https://hub.camunda.io', '/api/v1/collaborators', { method: 'PUT', body: { email, projectId: g.workspaceKey, role: 'editor' } });
            }
          });
          c.workspaceAccessAttempts[key].status = 'submitted'; save();
        } catch (error) {
          // Definitively rejected requests can be tried once after acceptance.
          // Unknown outcomes remain reserved and are only read back, never resent.
          if (![400, 404].includes(error.status) || !member.invitePending) throw error;
          c.workspaceAccessAttempts[key].status = 'deferred'; save();
        }
        workspaceMember = (await workspaceMembers()).find(m => emailOf(m) === email);
        if (workspaceMember && workspaceMember.role !== 'editor') throw blocked('Workspace-Rolle wurde geändert.');
      }
      if (workspaceMember && !workspaceMember.invitePending) this.observed(c, g, email, 'student.workspace', 'Editor-Zugriff auf den Gruppen-Workspace lesend bestätigt.');
      const usersPath = '/v2/groups/' + seg(g.runtimeGroupId) + '/users';
      const runtimeUsers = () => state.search(usersPath + '/search');
      let runtimeAssigned = (await runtimeUsers()).some(u => emailOf(u) === email);
      if (!runtimeAssigned && (initial || !member.invitePending || !c.autoAccess?.lastCheckAt)) {
        try { await write('Studierendenkonto der Runtime-Gruppe zuweisen', () => state.runtime(usersPath + '/' + seg(email), { method: 'PUT' })); }
        catch (error) { if (![404, 409].includes(error.status)) throw error; }
        runtimeAssigned = (await runtimeUsers()).some(u => emailOf(u) === email);
      }
      if (runtimeAssigned) this.observed(c, g, email, 'student.runtime', 'Camunda-Konto in der vorgesehenen Runtime-Gruppe lesend bestätigt; Gruppenrechte für den eigenen Tenant geprüft.');
      if (member.invitePending || !workspaceMember || workspaceMember.invitePending || !runtimeAssigned) {
        const reasons = [];
        if (member.invitePending) reasons.push('Organisationseinladung annehmen');
        if (!workspaceMember || workspaceMember.invitePending) reasons.push('Workspace-Zugriff noch ausstehend');
        if (!runtimeAssigned) reasons.push('Runtime-Konto noch unbekannt; einmal anmelden');
        if (c.workspaceAccessAttempts[key]?.status === 'reserved') reasons.push('Workspace-Anfrage unbestätigt; keine erneute Einladung');
        pending.push({ email, reason: reasons.join('. ') + '. Wird automatisch nachgeprüft.' });
      } else this.observed(c, g, email, 'student.assigned', 'Benutzerzugriff vollständig bestätigt: Organisation aktiv, Workspace-Editor, Runtime-Gruppe und Rechte für den eigenen Tenant.', 'completed');
    }
    return pending;
  }
  async locked(id, fn) {
    const m = this.manager;
    if (m.busy || this.running) return { skipped: true };
    const before = m.load().classes.find(c => c.id === id);
    if (!before) throw new Error('Klasse nicht gefunden.');
    if (m.cleanup.busy.has(before.site)) return { skipped: true };
    let classFd, siteFd; m.busy = true; this.running = true;
    const classLock = path.join(m.root, 'classes-lock.local.json'), siteLock = path.join(m.root, 'cleanup-lock-' + before.site + '.local.json');
    try {
      classFd = fs.openSync(classLock, 'wx', 0o600); siteFd = fs.openSync(siteLock, 'wx', 0o600); m.cleanup.busy.add(before.site);
      const data = m.load(), c = data.classes.find(c => c.id === id); if (!c) return { skipped: true }; let revision = c.revision;
      const save = ({ revise = true } = {}) => { if (m.load().classes.find(c => c.id === id)?.revision !== revision) throw blocked('Klasse wurde während der Zuweisung geändert.'); if (revise) c.revision = crypto.randomUUID(); revision = c.revision; m.save(data); };
      return await (m.audit ? m.audit.run({ site: c.site, classId: c.id, lecturerEmail: c.lecturerEmail }, () => fn(c, save)) : fn(c, save));
    } catch (error) { if (error.code === 'EEXIST') return { skipped: true }; throw error; }
    finally {
      if (siteFd !== undefined) { fs.closeSync(siteFd); fs.unlinkSync(siteLock); m.cleanup.busy.delete(before.site); }
      if (classFd !== undefined) { fs.closeSync(classFd); fs.unlinkSync(classLock); }
      m.busy = false; this.running = false;
    }
  }
  async configure(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Automatik ausdrücklich aktivieren oder deaktivieren.');
    const result = await this.locked(id, async (c, save) => {
      if (c.cleanupState || c.status === 'draft' || c.pendingMove || c.uncertainCreate) throw new Error('Zuerst die bestätigte Camunda-Einrichtung abschließen; bereinigte Klassen als neuen Entwurf importieren.');
      if (enabled) {
        this.manager.identity(c.site, c.lecturerEmail, c.day);
        const state = await this.manager.inspect(c); this.assertStructure(c, state);
        c.autoAccess = this.authorize(c, state.cxt);
      } else c.autoAccess = { ...c.autoAccess, enabled: false, status: 'paused' };
      save(); return { classroom: c };
    });
    if (result?.skipped) throw new Error('Klassen- oder Standortverwaltung läuft bereits. Bitte später erneut versuchen.');
    return result;
  }
  async tick() {
    const m = this.manager;
    if (m.busy || this.running) return;
    const queued = m.load().classes.filter(c => c.status === 'pending' && c.autoAccess?.enabled && c.autoAccess.status !== 'stopped' && (c.autoAccess.nextCheckAt || 0) <= m.now());
    for (const item of queued) await this.locked(item.id, async (c, save) => {
      const a = c.autoAccess;
      if (!a?.enabled || c.status !== 'pending') return;
      const before = JSON.stringify({ status: a.status, error: a.lastError, pending: c.pendingStudents });
      try {
        if (c.pendingMove || c.uncertainCreate || a.scope !== this.scope(c) || a.contextRevision !== m.contextForSite(c.site).revision) throw blocked('Klasse oder Standortkonfiguration geändert. Automatik bitte neu prüfen und aktivieren.');
        const context = m.contextForSite(c.site), members = await context.organizationApi.console('/members');
        for (const person of c.pendingStudents || []) {
          const member = members.find(x => emailOf(x) === person.email);
          if (context.protectedEmails.includes(person.email) || member?.roles?.some(r => !['member', 'modeler'].includes(r))) throw blocked('Ausstehendes Konto hat zusätzliche Rollen erhalten. Automatik angehalten.');
        }
        if (a.lastCheckAt && c.pendingStudents.every(p => { const member = members.find(x => emailOf(x) === p.email); return !member || member.invitePending; })) {
          a.status = 'waiting'; a.lastCheckAt = new Date(m.now()).toISOString(); a.nextCheckAt = m.now() + 60000; save({ revise: false }); return;
        }
        const state = await m.inspect(c); this.assertStructure(c, state);
        const guard = () => { if (m.get(c.id).revision !== c.revision || a.scope !== this.scope(c) || a.contextRevision !== m.contextForSite(c.site).revision) throw blocked('Freigegebene Zuordnung wurde geändert.'); };
        c.pendingStudents = await this.sync(c, state, save, { write: async (_label, call) => { guard(); return call(); } });
        c.status = c.pendingStudents.length ? 'pending' : 'ready';
        a.status = c.pendingStudents.length ? 'waiting' : 'completed'; delete a.lastError;
      } catch (error) { a.status = error.stopAccess || [400, 401, 403].includes(error.status) ? 'stopped' : 'waiting'; a.lastError = error.message; }
      a.lastCheckAt = new Date(m.now()).toISOString(); a.nextCheckAt = m.now() + (a.lastError ? 300000 : 60000); save({ revise: c.status === 'ready' || a.status === 'stopped' });
      m.audit?.enrich({ email: '', groupName: '' });
      if (before !== JSON.stringify({ status: a.status, error: a.lastError, pending: c.pendingStudents })) m.audit?.record({ event: 'access.sync', actor: 'Automatik', status: a.status === 'completed' ? 'completed' : a.status === 'stopped' ? 'stopped' : 'waiting', count: c.pendingStudents.length, summary: a.status === 'completed' ? 'Alle freigegebenen Benutzerzuweisungen bestätigt.' : a.status === 'stopped' ? 'Automatik angehalten; Klassenrechte oder Konfiguration prüfen.' : 'Benutzerzuweisungen geprüft; Einladungen oder Konten noch ausstehend.' });
    });
  }
}
module.exports = { ClassAccess };
