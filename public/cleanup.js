(() => {
  const el = id => document.getElementById(id), kinds = ['students', 'workspaces', 'tenants'];
  const labels = { students: 'Studierende', workspaces: 'Workspaces', tenants: 'Tenants', runtime: 'Laufzeitdaten', groups: 'Runtime-Gruppen' };
  const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  let analysis = null, busy = false, plan = null, expiry;
  async function json(url, options) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000), ...options });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status); return data;
  }
  function invalidate() { plan = null; clearTimeout(expiry); el('cleanup-apply').disabled = true; }
  function selection() { return Object.fromEntries(kinds.map(kind => [kind, [...el('cleanup-selection').querySelectorAll('input[data-cleanup-kind="' + kind + '"]:checked')].map(input => input.dataset.id)])); }
  function controls() {
    el('analyze-cleanup').disabled = busy; el('cleanup-site').disabled = busy; el('cleanup-selection-open').disabled = busy;
    el('cleanup-analysis-back').disabled = busy; el('cleanup-dialog-close').disabled = busy; el('cleanup-ack').disabled = busy;
    const selected = selection(), count = Object.values(selected).reduce((n, ids) => n + ids.length, 0);
    el('cleanup-delete').disabled = busy || !analysis || !count;
    el('cleanup-selected-count').textContent = kinds.map(kind => selected[kind].length + ' ' + labels[kind]).join(' · ') + ' ausgewählt';
    for (const kind of kinds) {
      const inputs = [...el('cleanup-selection').querySelectorAll('input[data-cleanup-kind="' + kind + '"]')].filter(i => i.dataset.allowed === 'true');
      const all = document.querySelector('[data-cleanup-all="' + kind + '"]');
      all.disabled = busy || !inputs.length; all.checked = inputs.length > 0 && inputs.every(i => i.checked); all.indeterminate = inputs.some(i => i.checked) && !all.checked;
      inputs.forEach(i => { i.disabled = busy; });
    }
    el('cleanup-apply').disabled = busy || !plan || !el('cleanup-ack').checked;
  }
  function reset() {
    invalidate(); analysis = null; el('analysis-result').innerHTML = ''; el('analysis-result').hidden = false;
    el('cleanup-selection').hidden = true; el('cleanup-selection-open').hidden = true;
    kinds.forEach(kind => { el('cleanup-' + kind + '-list').innerHTML = ''; }); controls();
  }
  el('analyze-cleanup').addEventListener('click', async () => {
    if (busy) return; reset(); busy = true; controls(); el('analysis-status').textContent = 'Bestand wird lesend analysiert …';
    try {
      analysis = await json('/api/' + el('cleanup-site').value + '/cleanup-analysis');
      renderCleanupAnalysis(analysis); el('cleanup-selection-open').hidden = false;
      for (const kind of kinds) el('cleanup-' + kind + '-list').innerHTML = analysis.selection[kind].length ? analysis.selection[kind].map(item => '<label class="cleanup-choice' + (item.selectable ? '' : ' blocked') + '"><input type="checkbox" data-cleanup-kind="' + kind + '" data-id="' + html(item.id) + '" data-allowed="' + item.selectable + '" aria-label="' + html(labels[kind] + ': ' + item.name + ' (' + item.id + ')') + '"' + (item.selectable ? '' : ' disabled') + '><span><strong>' + html(item.name) + '</strong><small>' + html(item.id) + '</small><small>' + html(item.reason) + '</small></span></label>').join('') : '<p class="muted">Keine Einträge vorhanden.</p>';
      el('analysis-status').textContent = 'Bestand für ' + el('cleanup-site').selectedOptions[0].text + ' analysiert am ' + new Date(analysis.checkedAt).toLocaleString('de-CH') + '. Mit „Auswahl“ fortfahren. Noch nichts gelöscht.';
    } catch (error) { el('analysis-status').textContent = 'Analyse fehlgeschlagen: ' + error.message; }
    finally { busy = false; controls(); }
  });
  el('cleanup-site').addEventListener('change', () => { reset(); el('analysis-status').textContent = 'Noch keine Analyse für diesen Standort ausgeführt.'; });
  el('cleanup-selection-open').addEventListener('click', () => { if (!analysis || busy) return; el('analysis-result').hidden = true; el('cleanup-selection').hidden = false; controls(); });
  el('cleanup-analysis-back').addEventListener('click', () => { el('cleanup-selection').hidden = true; el('analysis-result').hidden = false; });
  el('cleanup-selection').addEventListener('change', event => {
    if (busy) return;
    const kind = event.target.dataset.cleanupAll;
    if (kind) el('cleanup-selection').querySelectorAll('input[data-cleanup-kind="' + kind + '"][data-allowed="true"]').forEach(i => { i.checked = event.target.checked; });
    invalidate(); controls();
  });
  el('cleanup-delete').addEventListener('click', async () => {
    if (!analysis || busy) return; busy = true; invalidate(); controls(); el('analysis-status').textContent = 'Auswahl wird vor dem Löschen erneut geprüft …';
    try {
      const result = await json('/api/' + el('cleanup-site').value + '/cleanup/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysisId: analysis.analysisId, selection: selection() }) });
      plan = result.preview; el('cleanup-ack').checked = false; el('cleanup-ack').parentElement.hidden = false;
      el('cleanup-dialog-summary').textContent = el('cleanup-site').selectedOptions[0].text + ': ' + kinds.map(kind => plan.selection[kind].length + ' ' + labels[kind]).join(', ') + '. Noch nichts gelöscht.';
      el('cleanup-dialog-items').innerHTML = kinds.filter(kind => plan.items[kind].length).map(kind => '<h3>' + labels[kind] + '</h3><ul>' + plan.items[kind].map(item => '<li>' + html(item.name) + ' · ' + html(item.id) + '</li>').join('') + '</ul>').join('');
      el('cleanup-dialog-effects').innerHTML = (plan.runtimeCounts.length ? '<h3>Laufzeitdaten der ausgewählten Tenants</h3><div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Prozessinstanzen</th><th>Davon laufend</th><th>Aufgaben</th><th>Runtime-Gruppen</th></tr></thead><tbody>' + plan.runtimeCounts.map(c => '<tr><td>' + html(plan.items.tenants.find(t => t.id === c.tenantId)?.name || c.tenantId) + '</td><td>' + c.processInstances + '</td><td>' + c.activeProcessInstances + '</td><td>' + c.tasks + '</td><td>' + c.runtimeGroups + '</td></tr>').join('') + '</tbody></table></div><p class="muted">Aufgaben aller Zustände werden über ihre Prozessinstanzen gelöscht. Gemeinsam genutzte Gruppen werden nur einmal gelöscht.</p>' : '') + '<h3>Löschfolgen</h3><ul>' + plan.effects.map(effect => '<li>' + html(effect) + '</li>').join('') + '</ul>' + (plan.permissionSummary.length ? '<p class="analysis-note">Gezielte technische Freigaben für diese Auswahl: ' + plan.permissionSummary.map(g => html(g.resourceType) + ' (' + g.count + ')').join(', ') + '. Keine pauschalen Abbruch- oder Löschrechte.</p>' : '');
      el('cleanup-result').hidden = true; el('cleanup-result').textContent = ''; el('cleanup-dialog-close').textContent = 'Abbrechen'; el('cleanup-dialog').showModal();
      expiry = setTimeout(() => { invalidate(); controls(); el('cleanup-dialog-summary').textContent = 'Löschvorschau abgelaufen. Bitte schließen und erneut prüfen.'; }, Math.max(0, Date.parse(plan.expiresAt) - Date.now()));
      el('analysis-status').textContent = 'Löschvorschau bereit. Bis zur ausdrücklichen Bestätigung wird nichts gelöscht.';
    } catch (error) { invalidate(); el('analysis-status').textContent = error.message; }
    finally { busy = false; controls(); }
  });
  el('cleanup-ack').addEventListener('change', controls);
  el('cleanup-dialog-close').addEventListener('click', () => { if (busy) return; invalidate(); el('cleanup-dialog').close(); controls(); });
  el('cleanup-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else { invalidate(); controls(); } });
  el('cleanup-apply').addEventListener('click', async () => {
    if (busy || !plan || !el('cleanup-ack').checked) return;
    const id = plan.id, site = el('cleanup-site').value; busy = true; invalidate(); controls();
    const output = el('cleanup-result'); output.hidden = false; output.textContent = 'Cleanup läuft. Bitte Ergebnis abwarten. Schreibaufrufe werden nicht automatisch wiederholt.';
    try {
      const result = await json('/api/' + site + '/cleanup/apply', { method: 'POST', signal: AbortSignal.timeout(20 * 60000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ previewId: id, acknowledged: true }) });
      el('cleanup-dialog-summary').textContent = result.status === 'completed' ? 'Cleanup abgeschlossen und lesend bestätigt.' : 'Cleanup gestoppt. Bitte die einzelnen Ergebnisse prüfen.';
      output.innerHTML = '<ul>' + result.results.map(r => '<li>' + html(labels[r.kind] + ': ' + (r.kind === 'groups' ? r.count : r.id)) + ' – ' + html(r.status === 'verified' ? 'Bestätigt' : r.status === 'uncertain' ? 'Ergebnis unklar' : 'Nicht ausgeführt') + '. ' + html(r.message) + '</li>').join('') + '</ul>' + (result.notAttempted.length ? '<p>' + result.notAttempted.length + ' weitere Aktionen nicht versucht.</p>' : '') + '<p>' + html(result.note) + '</p>';
    } catch (error) { el('cleanup-dialog-summary').textContent = 'Cleanup-Ergebnis nicht vollständig bestätigt.'; output.textContent = error.message + ' Keine automatische Wiederholung. Der Lauf kann bereits Änderungen ausgeführt haben; vor einem neuen Versuch den Bestand prüfen.'; }
    finally {
      busy = false; reset(); el('cleanup-ack').parentElement.hidden = true; el('cleanup-dialog-close').textContent = 'Schließen';
      el('analysis-status').textContent = 'Löschlauf beendet oder Ergebnis unklar. Vor weiteren Aktionen Bestand erneut analysieren.'; controls();
    }
  });
  controls();
})();
