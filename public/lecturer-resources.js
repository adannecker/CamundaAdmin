(() => {
  const el = id => document.getElementById(id), sites = { basel: 'Basel', brugg: 'Brugg', olten: 'Olten' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const { icon, info } = window.AdminUi;
  const readableError = error => /HTTP 503/.test(error) ? 'Camunda Runtime ist derzeit nicht verfügbar (HTTP 503). Clusterstatus prüfen.' : error;
  let rows = [], busy = false, dirty = false, plan = null;
  async function json(url, options) { const r = await fetch(url, { signal: AbortSignal.timeout(180000), ...options }); const data = await r.json(); if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status); return data; }
  function controls() {
    el('lecturer-resources-read').disabled = busy; el('lecturer-resource-close').disabled = busy; el('lecturer-resource-ack').disabled = busy || !plan;
    el('lecturer-resource-apply').hidden = !plan; el('lecturer-resource-apply').disabled = busy || !plan || !el('lecturer-resource-ack').checked;
    document.querySelectorAll('[data-private-action]').forEach(b => { b.disabled = busy || dirty || b.dataset.allowed !== 'true'; });
  }
  function actions(row, knownMember = false, protectedOwner = false) {
    // Even if the last runtime read failed, opening a fresh read-only preview is safe.
    return (row.state !== 'ready' ? '<button type="button" class="admin-icon-button resource-plus" data-private-action="create" data-private-email="' + esc(row.email) + '" data-private-site="' + row.site + '" data-allowed="' + Boolean(row.canCreate || row.state === 'unknown' && knownMember) + '" aria-label="' + esc('Private Ressourcen für ' + row.email + ' in ' + sites[row.site] + ' anlegen') + '" data-admin-info="' + esc(dirty ? 'Lokale Änderungen zuerst speichern.' : row.state === 'unknown' ? 'Bestand derzeit nicht prüfbar. Vorschau erneut lesen; eine Anlage ist erst nach vollständiger Prüfung möglich.' : row.canCreate ? 'Privaten Workspace und Tenant anlegen. Öffnet zuerst eine Vorschau.' : row.detail) + '">' + icon('plus') + '</button>' : '') + (!row.protectedOwner && !protectedOwner && (row.canRemove || knownMember) ? '<button type="button" class="admin-icon-button resource-remove" data-private-action="remove" data-private-email="' + esc(row.email) + '" data-private-site="' + row.site + '" data-allowed="true" aria-label="' + esc(row.email + ' aus Organisation ' + sites[row.site] + ' entfernen') + '" data-admin-info="Aus dieser Organisation entfernen. Öffnet zuerst die Vorschau mit Bestätigung für Mitgliedschaft und private Ressourcen.">' + icon('remove') + '</button>' : '');
  }
  function render() {
    for (const cell of document.querySelectorAll('[data-resource-email]')) {
      const row = rows.find(r => r.email === cell.dataset.resourceEmail && r.site === cell.dataset.resourceSite), target = cell.querySelector('.lecturer-resource-state');
      if (!target) continue;
      const roleInfo = cell.querySelector('.admin-role-info'), help = roleInfo.querySelector('[data-admin-info]');
      help.dataset.adminInfo = roleInfo.dataset.roleInfo + '\n\n' + (row ? (row.state === 'unknown' ? 'Private Ressourcen nicht prüfbar.' : (row.workspace ? 'Workspace vorhanden.' : 'Workspace fehlt.') + '\n' + (row.tenant ? 'Tenant vorhanden.' : 'Tenant fehlt.')) + '\n' + readableError(row.detail) : 'Private Ressourcen noch nicht geprüft.');
      help.classList.toggle('resource-unknown', row?.state === 'unknown' || row?.state === 'blocked');
      help.classList.toggle('resource-missing', row?.state === 'missing' || row?.state === 'partial');
      target.innerHTML = row ? actions(row, cell.dataset.orgMember === 'true', cell.dataset.protectedOwner === 'true') : '';
    }
    el('lecturer-resources-sites').innerHTML = Object.entries(sites).map(([site, name]) => '<h3>' + name + '</h3><div class="table-wrap"><table><thead><tr><th>Dozent</th><th>Workspace</th><th>Tenant</th><th>Aktion</th></tr></thead><tbody>' + rows.filter(r => r.site === site && (r.selected || r.member || r.workspace || r.tenant || r.state === 'unknown')).map(r => '<tr><td>' + esc(r.name || r.email) + '<br><small>' + esc(r.email) + '</small></td><td>' + (r.workspace ? '<a href="' + esc(r.workspace.url) + '" target="_blank" rel="noopener">' + esc(r.workspace.name) + '</a>' : r.state === 'unknown' ? 'Nicht prüfbar' : 'Fehlt') + '</td><td>' + esc(r.tenant?.name || (r.state === 'unknown' ? 'Nicht prüfbar' : 'Fehlt')) + ' ' + info(r.detail, 'Ressourcendetails für ' + r.email + ' in ' + name) + '</td><td><span class="lecturer-resource-state">' + actions(r) + '</span></td></tr>').join('') + '</tbody></table></div>').join('');
    controls();
  }
  async function refresh() {
    if (busy) return; busy = true; controls(); el('lecturer-resources-status').textContent = 'Private Workspaces und Tenant-Zuordnungen werden gelesen …';
    try { const result = await json('/api/admin/lecturer-resources'); rows = result.rows; render(); el('lecturer-resources-status').textContent = result.note + ' Stand: ' + new Date(result.checkedAt).toLocaleString('de-CH'); }
    catch (error) { el('lecturer-resources-status').textContent = error.message; for (const cell of document.querySelectorAll('[data-resource-email]')) { cell.querySelector('.admin-info').dataset.adminInfo += '\nAktualisierung fehlgeschlagen: ' + error.message; } }
    finally { busy = false; controls(); }
  }
  document.addEventListener('lecturer-resources-render', render);
  document.addEventListener('lecturer-resources-refresh', refresh);
  document.addEventListener('admin-config-dirty', () => { dirty = true; controls(); });
  document.addEventListener('admin-config-saved', () => { dirty = false; controls(); });
  el('lecturer-resources-read').addEventListener('click', refresh);
  document.querySelector('[data-section="setup"]').addEventListener('click', () => { if (!rows.length) refresh(); });
  document.addEventListener('click', async event => {
    const b = event.target.closest('[data-private-action]'); if (!b || busy || dirty || b.disabled) return;
    plan = null; busy = true; controls();
    const removing = b.dataset.privateAction === 'remove';
    el('lecturer-resource-title').textContent = removing ? 'Aus Organisation entfernen?' : 'Private Ressourcen anlegen';
    el('lecturer-resource-preview').textContent = sites[b.dataset.privateSite] + ' · ' + b.dataset.privateEmail;
    el('lecturer-resource-result').classList.remove('cleanup-error'); el('lecturer-resource-result').textContent = 'Aktuellen Bestand und geplante Änderungen prüfen …';
    el('lecturer-resource-ack').checked = false; el('lecturer-resource-ack').parentElement.hidden = true;
    el('lecturer-resource-dialog').showModal();
    try {
      const result = await json('/api/admin/lecturer-resources/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: b.dataset.privateSite, email: b.dataset.privateEmail, action: b.dataset.privateAction }) });
      plan = result.preview; el('lecturer-resource-title').textContent = plan.action === 'create' ? 'Private Ressourcen anlegen' : 'Aus Organisation entfernen?';
      el('lecturer-resource-preview').innerHTML = '<p><strong>' + esc(plan.name) + '</strong> · ' + sites[plan.site] + '<br>' + esc(plan.email) + '</p><p>Workspace: ' + esc(plan.workspaceName) + '<br>Tenant: ' + esc(plan.tenantName) + '</p><ul>' + plan.changes.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>' + plan.runtimeCounts.map(c => '<p>' + c.processInstances + ' Instanzen · ' + c.tasks + ' Aufgaben · ' + c.runtimeGroups + ' Runtime-Gruppen</p>').join('') + '<p class="muted">' + plan.permissionCount + ' gezielte technische Freigaben. Vorschau zehn Minuten gültig.</p>';
      el('lecturer-resource-result').textContent = ''; el('lecturer-resource-ack').checked = false; el('lecturer-resource-ack').parentElement.hidden = false;
      el('lecturer-resource-apply').textContent = plan.action === 'create' ? 'Private Ressourcen anlegen' : 'Aus Organisation entfernen';
      el('lecturer-resource-apply').classList.toggle('danger', removing);
    } catch (error) { el('lecturer-resource-result').classList.add('cleanup-error'); el('lecturer-resource-result').textContent = (/HTTP 503/.test(error.message) ? 'Camunda Runtime ist derzeit nicht verfügbar (HTTP 503). Clusterstatus prüfen und die Vorschau danach erneut öffnen.' : error.message) + ' Es wurde nichts geändert.'; }
    finally { busy = false; controls(); }
  });
  el('lecturer-resource-ack').addEventListener('change', controls);
  el('lecturer-resource-close').addEventListener('click', () => { if (!busy) { plan = null; el('lecturer-resource-dialog').close(); controls(); } });
  el('lecturer-resource-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else { plan = null; controls(); } });
  el('lecturer-resource-apply').addEventListener('click', async () => {
    if (!plan || busy || !el('lecturer-resource-ack').checked) return;
    const id = plan.id, removing = plan.action === 'remove'; plan = null; busy = true; controls();
    try { const r = await json('/api/admin/lecturer-resources/apply', { method: 'POST', signal: AbortSignal.timeout(20 * 60000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ previewId: id, acknowledged: true }) }); el('lecturer-resource-result').textContent = (r.status === 'completed' ? 'Bestätigt. ' : 'Nicht vollständig. ' + (r.error || '') + ' ') + r.note; if (removing && r.status === 'completed') el('admin-load').click(); }
    catch (error) { el('lecturer-resource-result').textContent = error.message + ' Vor einem weiteren Versuch Bestand neu prüfen.'; }
    finally { busy = false; el('lecturer-resource-ack').parentElement.hidden = true; controls(); await refresh(); }
  });
})();
