(() => {
  const el = id => document.getElementById(id), html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const states = { draft: 'Lokaler Entwurf', ready: 'Eingerichtet', pending: 'Einladungen / Zugriffe ausstehend', attention: 'Nachprüfung erforderlich', cleaned: 'Im Cleanup bereinigt' };
  let data = null, busy = false, importPlan = null, actionPlan = null;
  const selected = () => data?.classes.find(c => c.site === el('class-site').value && c.lecturerEmail === el('class-lecturer').value && c.day === el('class-day').value);
  async function json(url, options) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000), ...options });
      let d;
      try { d = await r.json(); } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
        throw new Error('Der lokale Dienst hat keine gültige JSON-Antwort geliefert (HTTP ' + r.status + '). Bitte den Dienst prüfen.');
      }
      if (!r.ok) throw new Error(d.error || 'Anfrage fehlgeschlagen (HTTP ' + r.status + ').');
      return d;
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Zeitüberschreitung: Der Dienst hat nicht rechtzeitig geantwortet. Bitte Verbindung und Dienst prüfen. Bei einer Änderung vor einem erneuten Versuch zuerst den aktuellen Stand nachlesen.');
      if (error instanceof TypeError) throw new Error('Der lokale Dienst ist nicht erreichbar oder die Verbindung wurde unterbrochen. Bitte prüfen, ob das Projekt läuft.');
      throw error;
    }
  }
  const post = (url, input, long = false, timeoutMs = 180000) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(long ? 20 * 60000 : timeoutMs) });
  function controls() { document.querySelectorAll('#students button,#students select,#students input,#class-dialog button,#class-dialog input').forEach(e => { e.disabled = busy; }); el('class-dialog-apply').disabled = busy || !actionPlan || !el('class-dialog-ack').checked; el('class-import-save').hidden = !importPlan; const c = selected(); if (el('class-provision')) el('class-provision').disabled = busy || Boolean(c?.pendingMove || c?.uncertainCreate || c?.status === 'cleaned'); }
  function lecturers() { const previous = el('class-lecturer').value; el('class-lecturer').innerHTML = data.lecturers.filter(p => p.sites[el('class-site').value]).map(p => '<option value="' + html(p.email) + '">' + html(p.name || p.email) + '</option>').join(''); if ([...el('class-lecturer').options].some(o => o.value === previous)) el('class-lecturer').value = previous; }
  function cards(c, preview = false) {
    const pending = new Map((c.pendingStudents || []).map(s => [s.email, s.reason]));
    return '<div class="class-groups">' + c.groups.map(g => '<article class="panel class-group"><div class="class-group-heading"><h3>' + html(g.name) + '</h3><span>' + g.students.length + '</span></div><p class="muted">' + (g.workspaceKey ? '<a href="https://hub.camunda.io/workspaces/' + html(g.workspaceKey) + '/projects" target="_blank" rel="noopener">' + html(g.workspaceName) + '</a>' : html(g.workspaceName)) + '</p><ul>' + g.students.map(s => '<li><div><strong>' + html(s.name) + '</strong><br><small>' + html(s.email) + '</small>' + (pending.has(s.email) ? '<p class="admin-warning">' + html(pending.get(s.email)) + '</p>' : '') + '</div>' + (!preview && c.groups.length > 1 ? '<div class="class-move"><select data-move-email="' + html(s.email) + '" aria-label="' + html('Zielgruppe für ' + s.email) + '">' + c.groups.filter(t => t.id !== g.id).map(t => '<option value="' + t.id + '">' + html(t.name) + '</option>').join('') + '</select><button class="action" data-class-move="' + html(s.email) + '">' + (c.pendingMove?.email === s.email ? 'Wechsel fortsetzen …' : 'Verschieben …') + '</button></div>' : '') + '</li>').join('') + '</ul>' + (!g.students.length ? '<p class="muted">Noch keine Studierenden.</p>' : '') + '</article>').join('') + '</div>';
  }
  function lecturerFindings(people = []) {
    if (!people.length) return '';
    return '<div class="analysis-note"><h3>Erkannte Dozenten-/Ownerkonten (' + people.length + ')</h3><p>Separat erkannt und aus den Studierendengruppen ausgelassen. Bestehende Rollen und Zugriffe bleiben unverändert.</p><ul>' + people.map(p => '<li><strong>' + html(p.configuredName || p.name || p.email) + '</strong> · ' + html(p.email) + (p.group ? ' · Excel-Gruppe: ' + html(p.group) : '') + (p.source ? ' · ' + html(p.source.sheet) + ', Zeile ' + html(p.source.row) : '') + '</li>').join('') + '</ul></div>';
  }
  function automaticAccess(c) {
    if (c.status === 'draft') return '';
    if (c.cleanupState) return '<div class="analysis-note">Bestätigter Cleanup: Die Automatik ist deaktiviert. Eine vollständig bereinigte Klasse kann durch einen neuen Excel-Import erneut vorbereitet werden.</div>';
    const a = c.autoAccess;
    const active = a?.enabled && a.status !== 'stopped';
    return '<div class="analysis-note" id="class-auto-access"><strong>' + (c.status === 'ready' ? 'Alle Benutzerzugriffe sind eingerichtet.' : active ? 'Automatische Vervollständigung aktiv' : 'Automatische Vervollständigung pausiert') + '</strong><p>' + (active ? 'Der laufende Dienst prüft ausstehende Zugriffe jede Minute. Einladung annehmen und einmal anmelden genügt; der Dozent muss keinen weiteren Einrichtungslauf starten.' : 'Die bereits freigegebenen Benutzerzuweisungen können automatisch ergänzt werden, sobald die Konten verfügbar sind.') + '</p>' + (a?.lastCheckAt ? '<small>Zuletzt geprüft: ' + html(new Date(a.lastCheckAt).toLocaleString('de-DE')) + '</small>' : '') + (a?.lastError ? '<p class="admin-warning">' + html(a.lastError) + '</p>' : '') + '<button class="action" data-class-auto="' + (active ? 'false' : 'true') + '">' + (active ? 'Automatik pausieren' : 'Automatik aktivieren') + '</button></div>';
  }
  function render() {
    if (!data) {
      el('class-board').innerHTML = '<div class="panel" role="status"><h3>Klassen und Dozenten noch nicht geladen</h3><p>Bei abgelaufener Sitzung bitte erneut mit AAI anmelden. Ansonsten „Aktualisieren“ wählen.</p></div>';
      controls();
      return;
    }
    const c = selected();
    el('class-board').innerHTML = c ? '<div class="panel"><div class="setup-heading"><h2>Gruppenübersicht</h2><span class="badge">' + states[c.status] + '</span></div><p>' + c.groups.length + ' Gruppen · ' + c.groups.reduce((n, g) => n + g.students.length, 0) + ' Studierende</p>' + (c.pendingMove ? '<p class="analysis-note">Gruppenwechsel für ' + html(c.pendingMove.email) + ' ist offen. Diesen Wechsel zuerst fortsetzen; andere Zuordnungen werden erhalten.</p>' : '') + (c.uncertainCreate ? '<p class="analysis-note">Ein Anlageversuch ist unbestätigt: ' + html(c.uncertainCreate) + '. Bestand vor einem weiteren Lauf manuell prüfen.</p>' : '') + '<button id="class-provision" class="action"' + (c.pendingMove || c.uncertainCreate ? ' disabled' : '') + '>' + (c.status === 'draft' ? 'In Camunda anlegen …' : 'Camunda-Einrichtung / Rechte prüfen …') + '</button>' + (c.status === 'draft' ? '<form id="class-add-group" class="admin-controls"><input id="class-group-name" aria-label="Neue Gruppe" placeholder="Weitere Gruppe" required maxlength="100"><button class="action">Gruppe ergänzen</button></form>' : '') + '</div>' + automaticAccess(c) + lecturerFindings(c.excludedLecturers) + cards(c) : '<div class="panel"><h3>Noch keine Klasse für diese Auswahl</h3><p class="muted">Excel-Liste importieren und den geprüften Entwurf übernehmen.</p><button class="action" id="class-example">Beispielansicht mit erfundenen Daten</button></div>';
    controls(); if (c?.pendingMove || c?.uncertainCreate) el('class-provision').disabled = true;
  }
  async function refresh() { if (busy) return; busy = true; controls(); const previous = el('class-lecturer').value; try { data = await json('/api/classes'); lecturers(); if (previous && [...el('class-lecturer').options].some(o => o.value === previous)) el('class-lecturer').value = previous; render(); el('class-status').textContent = 'Klassen geladen. Neue Klassen benötigen eine Bestätigung; aktivierte automatische Benutzerzuweisungen laufen im Hintergrund.'; } catch (error) { el('class-status').textContent = error.message; } finally { busy = false; controls(); render(); } }
  document.querySelector('[data-section="students"]').addEventListener('click', () => { if (!data) refresh(); });
  window.addEventListener('open-class', async event => {
    await refresh();
    if (!data) return;
    el('class-site').value = event.detail.site; lecturers(); el('class-lecturer').value = event.detail.lecturerEmail; el('class-day').value = event.detail.day; render();
    document.querySelector('[data-section="students"]').click();
  });
  el('class-refresh').addEventListener('click', refresh);
  function importStatus(message, error = false) {
    el('class-status').textContent = message;
    el('class-import-status').textContent = message;
    el('class-import-status').classList.toggle('import-error', error);
  }
  function importError(message) {
    importStatus(message, true);
    el('class-import-error-message').textContent = message;
    if (!el('class-import-error').open) el('class-import-error').showModal();
  }
  el('class-import-error-close').addEventListener('click', () => el('class-import-error').close());
  for (const id of ['class-site', 'class-lecturer', 'class-day']) el(id).addEventListener('change', () => { importPlan = null; el('class-import-preview').innerHTML = ''; el('class-import-status').textContent = ''; if (id === 'class-site') lecturers(); render(); });
  el('class-file').addEventListener('change', () => { importPlan = null; el('class-import-preview').innerHTML = ''; el('class-import-status').textContent = ''; controls(); });
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const timer = setTimeout(() => { finish(new Error('Das Einlesen der Datei dauert zu lange. Bitte die Datei erneut lokal auswählen.')); reader.abort(); }, 30000);
      function finish(error, value) { clearTimeout(timer); reader.onload = reader.onerror = reader.onabort = null; error ? reject(error) : resolve(value); }
      reader.onload = () => finish(null, String(reader.result).split(',')[1]);
      reader.onerror = () => finish(new Error('Die Excel-Datei konnte nicht gelesen werden. Bitte prüfen, ob sie lokal verfügbar und zugänglich ist.'));
      reader.onabort = () => finish(new Error('Das Einlesen der Datei wurde abgebrochen. Bitte die Datei erneut auswählen.'));
      try { reader.readAsDataURL(file); } catch { finish(new Error('Die Excel-Datei konnte nicht geöffnet werden. Bitte erneut auswählen.')); }
    });
  }
  el('class-analyze').addEventListener('click', async () => {
    const file = el('class-file').files[0]; if (busy) return;
    if (!file) return importError('Bitte zuerst eine Excel-Datei (.xlsx) auswählen.');
    if (!/\.xlsx$/i.test(file.name)) return importError('Bitte eine .xlsx-Datei auswählen. Andere Excel-Formate werden nicht unterstützt.');
    if (!file.size || file.size > 4 * 1024 * 1024) return importError('Die Excel-Datei muss Daten enthalten und darf höchstens 4 MiB groß sein.');
    if (!el('class-ai-consent').checked) return importError('Bitte das Häkchen zur KI-Analyse setzen: Sämtliche Zellinhalte aller Tabellenblätter werden an OpenAI gesendet.');
    if (!el('class-lecturer').value) return importError('Bitte einen am gewählten Standort konfigurierten Dozenten auswählen.');
    busy = true; importPlan = null; controls();
    el('class-import-preview').innerHTML = '';
    const task = window.WaitOverlay.begin({ title: 'Excel mit KI analysieren', detail: 'Schritt 1 von 3: Excel-Datei lokal einlesen …' });
    let failure;
    try {
      importStatus('Excel-Datei wird eingelesen …');
      const base64 = await readFile(file);
      task.update('Schritt 2 von 3: Sämtliche Tabelleninhalte an OpenAI senden und Gruppen als JSON analysieren. Das kann bis zu drei Minuten dauern …');
      importStatus('KI-Analyse läuft. Bitte warten …');
      const r = await post('/api/classes/import/preview', { site: el('class-site').value, lecturerEmail: el('class-lecturer').value, day: el('class-day').value, filename: file.name, base64, aiConsent: 'full-workbook-v1' }, false, 240000);
      task.update('Schritt 3 von 3: Gruppen und Studierende für die Vorschau aufbereiten …');
      el('class-import-preview').innerHTML = '<h3>KI-Zuordnung prüfen</h3><p>' + html(r.note) + ' Modell: ' + html(r.model) + '. Analysiert: ' + r.transmittedRows + ' befüllte Zeilen aus ' + r.transmittedSheets + ' Tabellenblättern.</p>' + (r.warnings.length ? '<details open><summary>Hinweise (' + r.warnings.length + ')</summary><ul>' + r.warnings.map(w => '<li>' + html(w) + '</li>').join('') + '</ul></details>' : '') + lecturerFindings(r.excludedLecturers) + '<p><strong>' + r.classroom.groups.reduce((n, g) => n + g.students.length, 0) + ' Studierende · ' + r.classroom.groups.length + ' Gruppen · ' + (r.excludedLecturers || []).length + ' Dozenten-/Ownerkonten ausgelassen</strong></p>' + cards(r.classroom, true) + '<details><summary>Strukturiertes JSON anzeigen</summary><pre class="class-roster-json">' + html(JSON.stringify(r.structuredRoster, null, 2)) + '</pre></details>';
      importPlan = r.previewId;
      importStatus(r.previewId ? 'Vorschau bereit. Namen, E-Mails, Gruppen und separat erkannte Dozentenkonten prüfen; noch keine Camunda-Änderung.' : 'Analyse abgeschlossen. Keine Studierenden zur Übernahme; erkannte Dozentenkonten sind unten aufgelistet. Der bestehende Entwurf bleibt erhalten.');
    } catch (error) { failure = error.message || 'Die Excel-Analyse ist fehlgeschlagen. Bitte die Datei und die Verbindung prüfen.'; }
    finally { task.end(); busy = false; controls(); }
    if (failure) importError(failure);
    else { el('class-import-preview').focus(); el('class-import-preview').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  });
  el('class-import-save').addEventListener('click', async () => { if (!importPlan || busy) return; const id = importPlan; importPlan = null; busy = true; controls(); try { await post('/api/classes/import/save', { previewId: id, acknowledged: true }); el('class-import-preview').innerHTML = ''; el('class-import').open = false; } catch (error) { el('class-status').textContent = error.message; } finally { busy = false; await refresh(); } });
  el('class-board').addEventListener('submit', async event => { if (event.target.id !== 'class-add-group') return; event.preventDefault(); if (busy) return; busy = true; controls(); try { await post('/api/classes/groups', { classId: selected().id, name: el('class-group-name').value }); } catch (error) { el('class-status').textContent = error.message; } finally { busy = false; await refresh(); } });
  async function previewAction(type, input) {
    busy = true; actionPlan = null; controls();
    const creating = type === 'provision' && selected()?.status === 'draft';
    const heading = type === 'move' ? 'Gruppenwechsel prüfen' : creating ? 'Klasse in Camunda anlegen' : 'Camunda-Einrichtung prüfen';
    el('class-dialog-title').textContent = heading;
    el('class-dialog-preview').textContent = 'Aktuellen Camunda-Bestand und benötigte Zuweisungen prüfen …';
    el('class-dialog-result').textContent = '';
    el('class-dialog-ack').checked = false;
    el('class-dialog-ack').parentElement.hidden = true;
    el('class-dialog-apply').hidden = true;
    el('class-dialog-apply').textContent = type === 'move' ? 'Gruppenwechsel anwenden' : creating ? 'Jetzt in Camunda anlegen' : 'Einrichtung jetzt abgleichen';
    if (!el('class-dialog').open) el('class-dialog').showModal();
    const task = window.WaitOverlay.begin({ title: heading + ': Vorschau', detail: 'Organisation, Dozent, Workspaces, Tenants und Gruppenrechte lesen. Es wird noch nichts angelegt …' });
    try {
      const r = await post('/api/classes/' + type + '/preview', input); actionPlan = { id: r.previewId, type };
      task.update('Geplante Änderungen und Einladungen für die Bestätigung aufbereiten …');
      el('class-dialog-preview').innerHTML = (type === 'move' ? '<p>' + html(r.email) + '<br><strong>' + html(r.from) + ' → ' + html(r.to) + '</strong></p>' : '<p>' + r.groups.length + ' Gruppen. Folgende Workspaces werden angelegt bzw. wiederverwendet:</p><ul>' + r.groups.map(g => '<li>' + html(g.name) + ' · ' + g.students + ' Studierende · Admin: ' + html(g.adminEmail) + (g.projects?.length ? '<br>Projekte: ' + g.projects.map(p => html(p.name) + ' (' + (p.action === 'create' ? 'anlegen' : 'vorhanden') + ')').join(', ') : '') + '</li>').join('') + '</ul><p>' + r.invitations.length + ' tatsächliche Organisationseinladungen beim Anwenden.</p>' + (r.invitations.length ? '<details><summary>E-Mail-Adressen</summary><ul>' + r.invitations.map(e => '<li>' + html(e) + '</li>').join('') + '</ul></details>' : '')) + '<ul>' + r.changes.map(c => '<li>' + html(c) + '</li>').join('') + '</ul>';
      el('class-dialog-ack').parentElement.hidden = false; el('class-dialog-apply').hidden = false;
      el('class-dialog-result').textContent = 'Vorschau bereit. Erst der bestätigte Klick führt die Änderungen aus.';
    } catch (error) {
      actionPlan = null;
      el('class-dialog-preview').textContent = 'Die Vorschau konnte nicht erstellt werden.';
      el('class-dialog-result').textContent = error.message;
      el('class-status').textContent = error.message;
    } finally { task.end(); busy = false; controls(); }
  }
  async function configureAutomatic(enabled) {
    busy = true; controls();
    const task = window.WaitOverlay.begin({ title: 'Automatische Benutzerzuweisung', detail: 'Bereits freigegebene Klassenzuordnung prüfen und Automatik ' + (enabled ? 'aktivieren' : 'pausieren') + ' …' });
    try { await post('/api/classes/access/configure', { classId: selected().id, enabled }); }
    catch (error) {
      actionPlan = null; el('class-dialog-title').textContent = 'Automatische Benutzerzuweisung';
      el('class-dialog-preview').textContent = 'Die Automatik konnte nicht geändert werden.';
      el('class-dialog-result').textContent = error.message;
      el('class-dialog-ack').parentElement.hidden = true; el('class-dialog-apply').hidden = true;
      if (!el('class-dialog').open) el('class-dialog').showModal();
    } finally { busy = false; try { await refresh(); } finally { task.end(); controls(); } }
  }
  el('class-board').addEventListener('click', event => { const b = event.target.closest('button'); if (!b || busy) return; const c = selected(); if (b.dataset.classAuto !== undefined) { configureAutomatic(b.dataset.classAuto === 'true'); return; } if (b.id === 'class-example') { const name = data.lecturers.find(p => p.email === el('class-lecturer').value)?.name || 'Dozent'; el('class-board').innerHTML = '<div class="panel"><h2>Beispielansicht</h2><p class="muted">Erfundene Daten, nur zur Ansicht. Keine Klasse gespeichert, keine Camunda-Zuweisungen oder Einladungen.</p><button id="class-example-close" class="action">Beispiel schließen</button></div>' + cards({ groups: [1, 2, 3].map((n, index) => ({ id: 'demo' + n, name: 'Gruppe ' + n, workspaceName: name + '_' + data.days[el('class-day').value] + '_Gruppe ' + n, students: ['Anna', 'Ben', 'Clara'].slice(0, index + 1).map((name, i) => ({ name: name + ' Beispiel', email: 'demo' + n + '-' + i + '@example.org' })) })) }, true); return; } if (b.id === 'class-example-close') { render(); return; } if (b.id === 'class-provision') previewAction('provision', { classId: c.id }); if (b.dataset.classMove) { const select = [...el('class-board').querySelectorAll('[data-move-email]')].find(s => s.dataset.moveEmail === b.dataset.classMove); previewAction('move', { classId: c.id, email: b.dataset.classMove, targetGroupId: c.pendingMove?.email === b.dataset.classMove ? c.pendingMove.to : select.value }); } });
  el('class-dialog-ack').addEventListener('change', controls);
  el('class-dialog-close').addEventListener('click', () => { if (!busy) { actionPlan = null; el('class-dialog').close(); controls(); } });
  el('class-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else { actionPlan = null; controls(); } });
  el('class-dialog-apply').addEventListener('click', async () => {
    if (!actionPlan || busy || !el('class-dialog-ack').checked) return; const plan = actionPlan; actionPlan = null; busy = true; controls();
    el('class-dialog-result').textContent = 'Bestätigte Änderungen werden ausgeführt …';
    const task = window.WaitOverlay.begin({ title: plan.type === 'move' ? 'Gruppenwechsel läuft' : 'Klasse in Camunda anlegen / abgleichen', detail: 'Bestand erneut prüfen, Workspaces, Tenants und Gruppen einrichten und die Rechte nachprüfen …' });
    try {
      const r = await post('/api/classes/' + plan.type + '/apply', { previewId: plan.id, acknowledged: true }, true);
      task.update('Ergebnis und bestätigte Schritte aufbereiten …');
      const pending = r.classroom?.pendingStudents || [];
      const message = r.status === 'completed' ? (plan.type === 'move' ? 'Gruppenwechsel bestätigt.' : 'Camunda-Einrichtung bestätigt. ' + pending.length + ' Studierendenzugriffe noch ausstehend.') : (r.error || 'Nicht vollständig.') + ' ' + (r.note || '');
      el('class-dialog-result').innerHTML = '<p>' + html(message) + '</p>' + (r.results?.length ? '<details open><summary>Bestätigte Schritte (' + r.results.length + ')</summary><ol>' + r.results.map(step => '<li>' + html(step) + '</li>').join('') + '</ol></details>' : '') + (pending.length ? '<h3>Noch ausstehend</h3><ul>' + pending.map(p => '<li>' + html(p.email) + ': ' + html(p.reason) + '</li>').join('') + '</ul>' : '');
    }
    catch (error) { el('class-dialog-result').textContent = error.message + ' Keine automatische Wiederholung. Vor weiterem Anwenden den Stand neu prüfen.'; }
    finally {
      el('class-dialog-ack').parentElement.hidden = true; el('class-dialog-apply').hidden = true;
      task.update('Aktualisierte Klassenübersicht laden …');
      busy = false;
      try { await refresh(); } finally { task.end(); controls(); }
    }
  });
  let backgroundRefresh = false;
  setInterval(async () => {
    if (busy || backgroundRefresh || !data || !selected()?.autoAccess?.enabled || selected().status !== 'pending' || el('class-dialog').open) return;
    backgroundRefresh = true;
    try {
      const latest = await json('/api/classes?background=1');
      if (!busy && !el('class-dialog').open && !document.activeElement?.closest('#class-board')) { data = latest; render(); }
    } catch { /* Explicit refresh and the persisted queue status expose errors. */ }
    finally { backgroundRefresh = false; }
  }, 30000);
})();
