const dataStore = require('./state-store');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadSetup } = require('./site-setup');

class ClusterStartError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

class ClusterStart {
  constructor({ root, apiForSite, setup = loadSetup }) { this.root = root; this.apiForSite = apiForSite; this.setup = setup; this.busy = new Set(); }
  file(site) { return path.join(this.root, 'cluster-start-' + site + '.local.json'); }
  receipt(site, config) {
    if (!dataStore.exists(this.file(site))) return null;
    const r = dataStore.readJson(this.file(site));
    if (r.clusterId !== config.clusterId || r.organizationId !== config.organizationId) throw new ClusterStartError('Gespeicherter Startnachweis gehört zu einem anderen Cluster. Zuerst manuell prüfen.');
    return r;
  }
  save(site, record) {
    dataStore.writeJson(this.file(site), record);
  }
  async inspect(site, providedCluster) {
    const config = this.setup(this.root, site), api = this.apiForSite(site);
    const cluster = providedCluster || await api.console('/clusters/' + encodeURIComponent(config.clusterId));
    if (cluster.uuid !== config.clusterId || cluster.ownerId !== config.organizationId) throw new ClusterStartError('Cluster und Organisation stimmen nicht mit der Standortkonfiguration überein.');
    const status = cluster.status?.ready || 'Unbekannt';
    return { site, config, api, cluster, status, receipt: this.receipt(site, config) };
  }
  describe(s) {
    const pending = s.receipt && !['verified', 'rejected'].includes(s.receipt.phase) && s.status !== 'Healthy';
    return { clusterId: s.config.clusterId, status: s.status, canStart: s.status === 'Suspended' && !pending,
      pending: Boolean(pending || s.status === 'Resuming'),
      message: s.status === 'Healthy' ? 'Cluster läuft.' : pending ? (s.receipt.phase === 'uncertain' || s.receipt.phase === 'submitting' ? 'Startausgang noch unbestätigt. Status im Hub prüfen; keinen Start automatisch wiederholen.' : 'Start wurde angefordert. Auf den bestätigten Clusterzustand warten; keinen Start automatisch wiederholen.') : s.status === 'Resuming' ? 'Cluster startet …' : s.status === 'Suspended' ? 'Pausierten Cluster starten.' : 'Start nur für pausierte Cluster möglich.',
      hubUrl: 'https://hub.camunda.io/org/' + s.config.organizationId + '/cluster/' + s.config.clusterId,
      permissionsUrl: 'https://hub.camunda.io/org/' + s.config.organizationId + '/management/api' };
  }
  async status(site, cluster) {
    const s = await this.inspect(site, cluster), info = this.describe(s);
    if (s.status === 'Healthy' && s.receipt && s.receipt.phase !== 'verified' && !this.busy.has(site)) {
      let fd; const lock = this.file(site) + '.lock';
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        const current = await this.inspect(site);
        if (current.status === 'Healthy' && current.receipt?.id === s.receipt.id) this.save(site, { ...s.receipt, phase: 'verified', verifiedAt: new Date().toISOString() });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
    }
    return info;
  }
  async start(site, clusterId) {
    const config = this.setup(this.root, site);
    if (clusterId !== config.clusterId) throw new ClusterStartError('Nur der konfigurierte Standortcluster kann gestartet werden.', 400);
    if (this.busy.has(site)) throw new ClusterStartError('Ein Clusterstart wird bereits bearbeitet.');
    this.busy.add(site); const lock = this.file(site) + '.lock'; let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      const s = await this.inspect(site), state = this.describe(s);
      if (s.status === 'Healthy') { if (s.receipt) this.save(site, { ...s.receipt, phase: 'verified' }); return { ...state, outcome: 'running' }; }
      if (s.status === 'Resuming') return { ...state, outcome: 'starting' };
      if (s.receipt && !['verified', 'rejected'].includes(s.receipt.phase)) throw new ClusterStartError(state.message);
      if (s.status !== 'Suspended') throw new ClusterStartError(state.message);
      const record = { id: crypto.randomUUID(), organizationId: config.organizationId, clusterId, phase: 'submitting', requestedAt: new Date().toISOString() };
      this.save(site, record);
      try {
        await s.api.console('/clusters/' + encodeURIComponent(clusterId) + '/wake', { method: 'PUT' });
        record.phase = 'accepted'; this.save(site, record);
      } catch (error) {
        // A definite 4xx rejection is safe to review and retry after fixing the permission.
        record.phase = [400, 401, 403, 404, 405, 422].includes(error.status) ? 'rejected' : 'uncertain'; this.save(site, record);
        throw new ClusterStartError(error.status === 403 ? 'Camunda hat den Start abgewiesen (HTTP 403). Clusterberechtigungen des Organisations-API-Clients prüfen.' : 'Clusterstart nicht bestätigt. Status im Hub prüfen; kein automatischer Wiederholungsversuch.', error.status || 502);
      }
      return { ...state, canStart: false, pending: true, outcome: 'accepted', message: 'Start angefordert. Der Cluster wird im Hintergrund hochgefahren.' };
    } catch (error) { if (error.code === 'EEXIST') throw new ClusterStartError('Ein Startlauf oder unbestätigter Startnachweis ist gesperrt. Erst Status prüfen.'); throw error; }
    finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } this.busy.delete(site); }
  }
}

module.exports = { ClusterStart, ClusterStartError };
