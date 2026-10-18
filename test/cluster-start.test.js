const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClusterStart } = require('../lib/cluster-start');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camunda-start-'));
  t.after(() => { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); });
  const config = { clusterId: 'cluster1', organizationId: 'org1' }, state = { status: 'Suspended', scope: 'GetCluster Wake', ownerId: 'org1', calls: [], failure: null, gate: null };
  const api = {
    token: async () => 'header.' + Buffer.from(JSON.stringify({ scope: state.scope })).toString('base64url') + '.signature',
    async console(endpoint, options = {}) {
      if (!options.method) return { uuid: 'cluster1', ownerId: state.ownerId, name: 'Test', status: { ready: state.status } };
      state.calls.push({ endpoint, options }); if (state.gate) await state.gate; if (state.failure) throw state.failure; return null;
    },
  };
  const build = () => new ClusterStart({ root, apiForSite: () => api, setup: () => config });
  return { root, state, manager: build(), build };
}

test('start capability is read-only; authorization is enforced by the provider rather than an invented scope', async t => {
  const f = fixture(t); f.state.scope = 'GetCluster';
  assert.equal((await f.manager.status('basel')).canStart, true); assert.equal(f.state.calls.length, 0);
  f.state.failure = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(f.manager.start('basel', 'cluster1'), e => e.status === 403 && /Clusterberechtigungen/.test(e.message));
  assert.equal(f.state.calls.length, 1);
});

test('only the configured owned suspended cluster can be woken; healthy and resuming are idempotent', async t => {
  const f = fixture(t); await assert.rejects(f.manager.start('basel', 'other-cluster'), e => e.status === 400);
  f.state.ownerId = 'foreign-org'; await assert.rejects(f.manager.start('basel', 'cluster1'), /Organisation/);
  f.state.ownerId = 'org1'; f.state.status = 'Unhealthy'; await assert.rejects(f.manager.start('basel', 'cluster1'), /pausierte/);
  f.state.status = 'Healthy'; assert.equal((await f.manager.start('basel', 'cluster1')).outcome, 'running');
  f.state.status = 'Resuming'; assert.equal((await f.manager.start('basel', 'cluster1')).outcome, 'starting');
  assert.equal(f.state.calls.length, 0);
});

test('one documented PUT with no body starts the cluster; stale paused reads cannot repeat it', async t => {
  const f = fixture(t); assert.equal((await f.manager.start('basel', 'cluster1')).outcome, 'accepted');
  assert.deepEqual(f.state.calls, [{ endpoint: '/clusters/cluster1/wake', options: { method: 'PUT' } }]);
  await assert.rejects(f.manager.start('basel', 'cluster1'), /angefordert/);
  assert.equal((await f.manager.status('basel')).pending, true);
  f.state.status = 'Healthy'; assert.equal((await f.manager.status('basel')).pending, false);
  f.state.status = 'Suspended'; assert.equal((await f.manager.status('basel')).canStart, true);
  await f.manager.start('basel', 'cluster1'); assert.equal(f.state.calls.length, 2);
});

test('uncertain network writes remain blocked across restart until a Healthy read proves completion', async t => {
  const f = fixture(t); f.state.failure = new Error('Connection lost');
  await assert.rejects(f.manager.start('basel', 'cluster1'), /nicht bestätigt/);
  const restarted = f.build(); await assert.rejects(restarted.start('basel', 'cluster1'), /unbestätigt/);
  assert.equal(f.state.calls.length, 1);
  f.state.status = 'Healthy'; await restarted.status('basel'); f.state.status = 'Suspended'; f.state.failure = null;
  await restarted.start('basel', 'cluster1'); assert.equal(f.state.calls.length, 2);
});

test('definite permission rejection can be reviewed; concurrent requests and cross-process locks never double-start', async t => {
  const denied = fixture(t); denied.state.failure = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(denied.manager.start('basel', 'cluster1'), /Clusterberechtigungen/); denied.state.failure = null;
  await denied.manager.start('basel', 'cluster1'); assert.equal(denied.state.calls.length, 2);
  const f = fixture(t); let release; f.state.gate = new Promise(resolve => { release = resolve; });
  const first = f.manager.start('basel', 'cluster1');
  await assert.rejects(f.manager.start('basel', 'cluster1'), /bereits/);
  await assert.rejects(f.build().start('basel', 'cluster1'), /gesperrt/);
  release(); await first; assert.equal(f.state.calls.length, 1);
});
