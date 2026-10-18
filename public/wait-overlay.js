(() => {
  const dialog = document.getElementById('wait-overlay');
  const title = document.getElementById('wait-title'), detail = document.getElementById('wait-detail');
  const counter = document.getElementById('wait-counter'), elapsed = document.getElementById('wait-elapsed');
  const originalFetch = window.fetch.bind(window), pending = new Map();
  const sites = { basel: 'Basel', brugg: 'Brugg', olten: 'Olten' };
  let runs = [], started = 0, pollFailed = false;
  function description(url, options) {
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname.endsWith('/progress') || url.searchParams.get('background') === '1') return null;
    if (url.pathname.startsWith('/api/classes')) return { title: url.pathname.includes('/import/preview') ? 'Excel mit KI analysieren' : url.pathname.includes('/move/') ? 'Gruppenwechsel vorbereiten' : url.pathname.includes('/provision/') ? 'Klasse und Gruppenrechte bearbeiten' : 'Klassenübersicht laden', detail: url.pathname.includes('/import/preview') ? 'Sämtliche Excel-Zellinhalte mit OpenAI analysieren und das strukturierte Ergebnis gegen die Originalzellen prüfen …' : url.pathname.endsWith('/apply') ? 'Bestätigte Änderungen ausführen und bei Camunda nachprüfen …' : 'Standort, Dozent, Tag und Gruppenzuordnungen prüfen …', priority: 8 };
    if (url.pathname.startsWith('/api/admin/lecturer-resources')) return { title: 'Private Dozentenressourcen', detail: url.pathname.endsWith('/apply') ? 'Bestätigte Workspace-/Tenant-Änderung ausführen und nachprüfen …' : url.pathname.endsWith('/preview') ? 'Dozent, Standort und zugehörige private Ressourcen für die Vorschau prüfen …' : 'Eigene Workspaces und Tenants aller Dozenten lesen …', priority: 8 };
    const match = url.pathname.match(/^\/api\/(basel|brugg|olten)\/(.*)$/), site = sites[match?.[1]], action = match?.[2];
    if (action === 'clusters/start') return { title: site + ': Cluster starten', detail: 'Cluster und Startrecht prüfen, Start einmalig anfordern …', priority: 8 };
    if (action === 'cleanup/apply') return { title: site + ': Cleanup läuft', detail: 'Bestand erneut prüfen und bestätigte Auswahl bearbeiten …', priority: 10 };
    if (action === 'cleanup/preview') return { title: site + ': Löschvorschau vorbereiten', detail: 'Auswahl, Zugriffe und Laufzeitdaten erneut prüfen; Instanzen, Aufgaben und Gruppen zählen …', priority: 9 };
    if (action === 'cleanup-analysis') return { title: site + ': Bestand analysieren', detail: 'Mitglieder, Rollen, Workspaces und Tenant-Zuordnungen lesen …', priority: 8 };
    if (action === 'live') return { title: 'Verbindungen prüfen', detail: 'Organisationszugang und Runtime-Verbindungen für Basel, Brugg und Olten prüfen …', priority: 1 };
    if (url.pathname === '/api/admin/setup') return { title: 'Standorte prüfen', detail: 'Konfiguration, Cluster, Clients, Rollen und Tenant-Zugriffe aller drei Standorte lesen …', priority: 5 };
    if (/^\/api\/admin\/setup\/(basel|brugg|olten)\/apply$/.test(url.pathname)) return { title: 'Standorteinrichtung ausführen', detail: 'Die ausgewählte Ergänzung anlegen und anschließend bei Camunda nachprüfen …', priority: 7 };
    if (url.pathname === '/api/admin/reconcile/apply') return { title: 'Dozentenrollen abgleichen', detail: 'Die bestätigten Änderungen ausführen und die Rollen erneut lesen …', priority: 8 };
    if (url.pathname === '/api/admin/reconcile/preview') return { title: 'Rollenabgleich vorbereiten', detail: 'Aktuelle Mitgliedschaften und Rollen mit der lokalen Konfiguration vergleichen …', priority: 5 };
    if (url.pathname === '/api/admin/inventory') return { title: 'Dozentenrollen lesen', detail: 'Aktuelle Rollen aus allen drei Organisationen abrufen …', priority: 4 };
    if (url.pathname === '/api/admin/config') return { title: options?.method === 'PUT' ? 'Konfiguration speichern' : 'Konfiguration laden', detail: 'Lokale Dozentenkonfiguration bearbeiten …', priority: 2 };
    return null;
  }
  function render() {
    const request = [...pending.values()].sort((a, b) => b.priority - a.priority)[0], run = runs[0];
    if (!request && !run) { if (dialog.open) dialog.close(); started = 0; return; }
    if (!started) started = Date.now();
    title.textContent = run ? sites[run.site] + ': Verwaltung läuft' : request.title;
    detail.textContent = run ? run.message : request.detail;
    counter.textContent = run?.total ? run.completed + ' von ' + run.total + ' Schritten bestätigt' : 'Bitte warten …';
    elapsed.textContent = 'Seit ' + Math.floor((Date.now() - started) / 1000) + ' s' + (pollFailed && run ? ' · Fortschrittsanzeige wird erneut abgefragt.' : '');
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener('cancel', event => event.preventDefault());
  // Explicit tasks also cover local work and reading the response body.
  window.WaitOverlay = {
    begin(info) {
      const id = Symbol();
      pending.set(id, { priority: 20, ...info }); render();
      return {
        update(detail) { if (pending.has(id)) { pending.get(id).detail = detail; render(); } },
        end() { pending.delete(id); render(); }
      };
    }
  };
  window.fetch = async (input, options) => {
    let info;
    try { info = description(new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href), options); } catch {}
    if (!info) return originalFetch(input, options);
    const id = Symbol(); pending.set(id, info); render();
    try { return await originalFetch(input, options); }
    finally { pending.delete(id); render(); }
  };
  async function poll() {
    try {
      const response = await originalFetch('/api/cleanup/progress', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      if (!response.ok) throw new Error('Fortschritt nicht erreichbar');
      const data = await response.json(); runs = data.runs; pollFailed = false;
    } catch { pollFailed = true; }
    render(); setTimeout(poll, 1000);
  }
  setInterval(() => { if (dialog.open) render(); }, 1000);
  poll();
})();
