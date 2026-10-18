(() => {
  const el = id => document.getElementById(id);
  const labels = { basel: 'Basel', brugg: 'Brugg', olten: 'Olten' };
  const states = { ready: 'Bereit', missing: 'Fehlt', blocked: 'Gesperrt', unknown: 'Nicht geprüft' };
  const html = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  let busy = false;
  async function json(url, options) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000), ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  }
  function controls() {
    el('setup-read').disabled = busy;
    el('setup-read').setAttribute('aria-busy', String(busy));
    el('setup-sites').querySelectorAll('button').forEach(b => { b.disabled = busy; });
  }
  function render(sites) {
    el('setup-summary').innerHTML = sites.map(s => '<div class="card"><h3>' + labels[s.site] + '</h3><span class="setup-state ' + s.status + '">' + (s.status === 'ready' ? 'Grundkonfiguration bereit' : s.status === 'missing' ? 'Vorbereitung fehlt' : 'Prüfung offen') + '</span><p>' + s.checks.filter(c => ['missing', 'blocked'].includes(c.state)).length + ' fehlend/gesperrt · ' + s.checks.filter(c => c.state === 'unknown').length + ' nicht geprüft</p><ul class="muted">' + s.checks.filter(c => ['missing', 'blocked'].includes(c.state)).slice(0, 3).map(c => '<li>' + html(c.label) + '</li>').join('') + '</ul><a href="#setup-' + s.site + '">Details ansehen</a></div>').join('');
    el('setup-sites').innerHTML = sites.map(s => '<article id="setup-' + s.site + '" class="panel setup-site"><div class="setup-heading"><h3>' + labels[s.site] + '</h3><span class="setup-state ' + s.status + '">' + (s.status === 'missing' ? 'Vorbereitung fehlt' : s.status === 'unknown' ? 'Prüfung offen' : 'Bereit') + '</span></div><p class="muted">API-Prüfung: ' + new Date(s.checkedAt).toLocaleString('de-CH') + '</p><details' + (s.actions.length ? ' open' : '') + '><summary>Alle Einzelprüfungen und Aktionen (' + s.checks.length + ')</summary><div class="table-wrap"><table><thead><tr><th>Voraussetzung</th><th>Status</th><th>Ergebnis / nächste Aktion</th></tr></thead><tbody>' + s.checks.map(c => '<tr><td>' + html(c.label) + '</td><td><span class="setup-state ' + c.state + '">' + states[c.state] + '</span></td><td>' + html(c.detail) + (c.planned?.length ? '<details><summary>Geplante Ergänzungen (' + c.planned.length + ')</summary><ul>' + c.planned.map(p => '<li>' + html(p.tenantId ? p.tenantId + ' → ' + p.type + ': ' + p.id : p.ownerType + ' ' + p.ownerId + ' → ' + p.resourceType + ' ' + p.resourceId + ': ' + p.permissionTypes.join(', ')) + '</li>').join('') + '</ul></details>' : '') + (c.action ? '<p><button class="action" data-setup-site="' + s.site + '" data-setup-action="' + c.action.id + '">' + html(c.action.label) + '</button></p>' : '') + '</td></tr>').join('') + '</tbody></table></div></details><p class="muted">' + html(s.limitation || '') + '</p>' + (s.hubUrl ? '<a href="' + html(s.hubUrl) + '" target="_blank" rel="noopener">Cluster / Settings im Hub öffnen</a> · <a href="' + html(s.adminUrl) + '" target="_blank" rel="noopener">Runtime-Freigaben öffnen</a>' : '') + '</article>').join('');
    controls();
  }
  async function read() {
    if (busy) return;
    busy = true; controls(); el('setup-status').textContent = 'Alle drei Standorte werden lesend geprüft …';
    try {
      const data = await json('/api/admin/setup'); render(data.sites);
      el('setup-status').textContent = 'Prüfung abgeschlossen. Unbekannte oder gesperrte Antworten gelten nicht als fehlende Ressourcen. Die Prüfung führt keine Einrichtung aus.';
    } catch (error) { el('setup-status').textContent = error.message; }
    finally { busy = false; controls(); }
  }
  el('setup-read').addEventListener('click', read);
  el('setup-summary').addEventListener('click', event => {
    const link = event.target.closest('a[href^="#setup-"]');
    if (link) { const details = document.querySelector(link.getAttribute('href') + ' > details'); if (details) details.open = true; }
  });
  document.querySelector('[data-section="setup"]').addEventListener('click', () => { if (!el('setup-sites').children.length) read(); });
  el('setup-sites').addEventListener('click', async event => {
    const button = event.target.closest('button[data-setup-action]');
    if (!button || busy) return;
    const site = button.dataset.setupSite, action = button.dataset.setupAction;
    busy = true; controls();
    el('setup-status').textContent = labels[site] + ': ' + button.textContent + ' … Vorbedingungen werden erneut geprüft.';
    try {
      const result = await json('/api/admin/setup/' + site + '/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await json('/api/admin/setup'); render(data.sites);
      el('setup-status').textContent = labels[site] + ': ' + result.message + ' ' + result.attempted + ' API-Schritte ausgeführt.';
    } catch (error) { el('setup-status').textContent = error.message; }
    finally { busy = false; controls(); }
  });
})();
