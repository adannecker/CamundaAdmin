const cards = document.querySelector('#cards');
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let checking = false;
const liveResults = new Map(), startingClusters = new Set(), clusterWatches = new Map(), startErrors = new Map();
const clusterStates = { Healthy: 'Läuft', Suspended: 'Pausiert', Resuming: 'Startet …', Creating: 'Wird angelegt', Updating: 'Wird aktualisiert', Unhealthy: 'Gestört', Maintenance: 'Wartung', WaitingForInput: 'Eingabe erforderlich' };
const siteLabel = id => id[0].toUpperCase() + id.slice(1);
const playIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l12-7z"/></svg>';
function renderSidebarSites() {
 const host = document.querySelector('#sidebar-sites'); if (!host) return;
 host.innerHTML = ['basel', 'brugg', 'olten'].map(id => {
  const result = liveResults.get(id), clusters = result?.clusters || [];
  let state = 'unknown', label = 'Status unbekannt';
  if (result?.ok && clusters.length) {
   if (startingClusters.has(id) || clusters.some(c => c.start?.pending || ['Resuming', 'Creating', 'Updating'].includes(c.status))) { state = 'starting'; label = 'Startet'; }
   else if (clusters.every(c => c.status === 'Healthy')) { state = 'live'; label = 'Live'; }
   else if (clusters.every(c => c.status === 'Suspended')) { state = 'paused'; label = 'Pausiert'; }
  }
  return '<div class="sidebar-site" title="' + siteLabel(id) + ': ' + label + '" aria-label="' + siteLabel(id) + ': ' + label + '"><span class="site-dot ' + state + '" aria-hidden="true"></span><span>' + siteLabel(id) + '</span></div>';
 }).join('');
}
function renderLiveCard(id, result) {
 renderSidebarSites();
 const card = document.querySelector('#card-' + id); if (!card) return;
 card.innerHTML = '<h3>' + siteLabel(id) + '</h3><span class="badge ' + (result.ok ? 'ok' : 'bad') + '">' + (result.ok ? 'Console erreichbar' : 'Zugriff fehlgeschlagen') + '</span><p class="muted">' + escapeHtml(result.error || 'Authentifizierung und Clusterabfrage erfolgreich.') + '</p>' +
  (result.clusters || []).map(c => '<div class="live-cluster"><div class="live-cluster-heading"><strong>' + escapeHtml(c.name) + '</strong>' + (c.start && (c.status === 'Suspended' || c.start.pending) ? '<button type="button" class="cluster-play" data-cluster-start="' + id + '" data-cluster-id="' + escapeHtml(c.id) + '" aria-label="' + siteLabel(id) + ': Cluster starten" title="' + escapeHtml(c.start.pending ? c.start.message : 'Cluster starten') + '"' + (startingClusters.has(id) || c.start.pending ? ' disabled' : '') + '>' + playIcon + '</button>' : '') + '</div><span class="setup-state ' + (c.status === 'Healthy' ? 'ready' : 'unknown') + '">' + escapeHtml(startingClusters.has(id) ? 'Start wird angefordert …' : c.start?.pending && c.status === 'Suspended' ? 'Start wird nachgeprüft …' : clusterStates[c.status] || c.status) + '</span><p class="muted">' + escapeHtml(c.version) + ' · ' + escapeHtml(c.region) + '</p>' +
  (c.start?.pending ? '<p class="cluster-start-hint">' + escapeHtml(c.start.message) + '</p>' : '') + '</div>').join('') +
  (result.runtime ? '<p><strong>Runtime:</strong> ' + escapeHtml(result.runtime.message) + '</p>' : '') + (startErrors.has(id) ? '<p class="cluster-start-error" role="alert">' + escapeHtml(startErrors.get(id)) + '</p>' : '') + '<p class="muted">Geprüft: ' + new Date(result.checkedAt).toLocaleString('de-CH') + '</p>';
}
async function readLiveSite(id, background = false) {
 const response = await fetch('/api/' + id + '/live' + (background ? '?background=1' : ''), { signal: AbortSignal.timeout(55000) });
 if (response.status === 401) throw Object.assign(new Error('Die Anmeldung bei Camunda Admin ist abgelaufen. Bitte erneut mit AAI anmelden. Die Camunda-Verbindung wurde nicht geprüft.'), { sessionExpired: true });
 if (!response.ok) throw new Error('HTTP ' + response.status);
 const result = await response.json(); liveResults.set(id, result); renderLiveCard(id, result); return result;
}
function watchCluster(id) {
 if (clusterWatches.has(id)) return;
 const watch = { until: Date.now() + 10 * 60000 }; clusterWatches.set(id, watch);
 const poll = async () => {
  try {
   const result = await readLiveSite(id, true), cluster = result.clusters?.find(c => c.start);
   if (cluster?.status === 'Healthy') { clusterWatches.delete(id); startErrors.delete(id); renderLiveCard(id, result); return; }
  } catch { startErrors.set(id, 'Startstatus derzeit nicht erreichbar. Es wird nur erneut gelesen.'); }
  if (Date.now() >= watch.until) { clusterWatches.delete(id); startErrors.set(id, 'Cluster noch nicht als laufend bestätigt. Status im Hub prüfen oder „Zugriff prüfen“ verwenden.'); const result = liveResults.get(id); if (result) renderLiveCard(id, result); return; }
  setTimeout(poll, 5000);
 };
 setTimeout(poll, 5000);
}
async function checkLive() {
 if(checking) return; checking=true; document.querySelector('#refresh').disabled=true;
 cards.innerHTML=['Basel','Brugg','Olten'].map(name=>'<article class="card" id="card-'+name.toLowerCase()+'"><h3>'+name+'</h3><p role="status">Verbindung wird geprüft …</p></article>').join('');
 await Promise.all(['basel','brugg','olten'].map(async id=>{
 try { const result = await readLiveSite(id); if (result.clusters?.some(c => c.start?.pending)) watchCluster(id); }
 catch(error){liveResults.delete(id); renderSidebarSites(); document.querySelector('#card-'+id).innerHTML='<h3>'+siteLabel(id)+'</h3><span class="badge'+(error.sessionExpired?'':' bad')+'">'+(error.sessionExpired?'Anmeldung erforderlich':'Prüfung fehlgeschlagen')+'</span><p>'+escapeHtml(error.message)+'</p>';}
 })); checking=false;document.querySelector('#refresh').disabled=false;
}
cards.addEventListener('click', async event => {
 const button = event.target.closest('[data-cluster-start]'); if (!button || button.disabled) return;
 const id = button.dataset.clusterStart, cluster = liveResults.get(id)?.clusters?.find(c => c.id === button.dataset.clusterId);
 if (!cluster?.start || startingClusters.has(id)) return;
 if (!cluster.start.canStart) { startErrors.set(id, cluster.start.message); renderLiveCard(id, liveResults.get(id)); return; }
 startingClusters.add(id); startErrors.delete(id); renderLiveCard(id, liveResults.get(id));
 try {
  const response = await fetch('/api/' + id + '/clusters/start', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({ clusterId: cluster.id }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  watchCluster(id);
 } catch (error) { startErrors.set(id, error.message); }
 finally { startingClusters.delete(id); try { await readLiveSite(id, true); } catch { renderLiveCard(id, liveResults.get(id)); } }
});
document.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>{const section=button.dataset.section;document.querySelectorAll('[data-panel]').forEach(panel=>{panel.hidden=panel.dataset.panel!==section;});document.querySelector('#title').textContent=button.textContent;document.querySelector('#refresh').hidden=section!=='live';document.querySelectorAll('[data-section]').forEach(b=>b.classList.toggle('active',b===button));}));
document.querySelector('#refresh').addEventListener('click',checkLive);
document.querySelector('#validate').addEventListener('click',()=>{const entries=document.querySelector('#emails').value.split(/[;\r\n]+/).map(s=>s.trim()).filter(Boolean);const unique=[...new Set(entries.map(s=>s.toLowerCase()))];const invalid=unique.filter(s=>! /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(s));document.querySelector('#preview').textContent=entries.length ? unique.length+' eindeutige Adressen für '+document.querySelector('#org').value+'. '+(entries.length-unique.length)+' Duplikate entfernt. '+(invalid.length?'Ungültig: '+invalid.join('; '):'Alle Adressen sind formal gültig. Noch keine Einladungen versendet.'):'Bitte mindestens eine E-Mail-Adresse eingeben.';});
function renderCleanupAnalysis(result) {
 const labels={student:'Studierende zugeordnet',review:'Zuordnung offen',protected:'Geschütztes Konto'};
 const workspaceNames=new Map(result.workspaces.map(w=>[w.id,w.name]));
 const groupNames=new Map(result.runtime.groups.map(g=>[g.id,g.name]));
 const tenantNames=new Map(result.runtime.tenants.map(t=>[t.id,t.name]));
 const list=values=>values.length?values.map(escapeHtml).join('<br>'):'–';
 const summary=result.summary;
 const people=[...result.people].sort((a,b)=>({student:0,review:1,protected:2}[a.classification]-{student:0,review:1,protected:2}[b.classification]));
 document.querySelector('#analysis-result').innerHTML=
  '<div class="cards analysis-summary">'+[[summary.students,'Studierende zugeordnet'],[summary.review,'Zuordnung offen'],[summary.protected,'Geschützte Konten'],[summary.workspaces,'Workspaces']].map(([n,label])=>'<div class="card"><span class="count">'+n+'</span>'+label+'</div>').join('')+'</div>'+
  '<p class="analysis-note">Die Studierendenrolle bestätigt eine Zuordnung, keine Löschfreigabe. Lehrpersonen, gemeinsam genutzte Inhalte und der Default-Tenant werden nicht automatisch zur Löschung ausgewählt.</p>'+
  '<h3>Konten und Zuordnungen ('+summary.totalMembers+')</h3><p class="muted">Angezeigt sind explizite Workspace-Mitgliedschaften und Tenant-Zuordnungen über Benutzer oder Gruppen. Zusätzliche Zugriffe über Rollen und Organisationsadminrechte sind hier nicht vollständig enthalten.</p><div class="table-wrap"><table><thead><tr><th>Konto</th><th>Einordnung</th><th>Workspaces</th><th>Gruppen / Tenants</th></tr></thead><tbody>'+
  people.map(p=>'<tr><td>'+escapeHtml(p.name)+'<br>'+escapeHtml(p.email)+(p.pending?'<br><span class="badge">Einladung offen</span>':'')+'</td><td><strong>'+labels[p.classification]+'</strong><br><small>'+escapeHtml(p.evidence)+'</small><br><small>Organisation: '+list(p.organizationRoles)+'</small></td><td>'+list(p.workspaceIds.map(id=>workspaceNames.get(id)||id))+'</td><td>'+list(p.groupIds.map(id=>groupNames.get(id)||id))+'<br><small>Tenants: '+list(p.tenantIds.map(id=>tenantNames.get(id)||id))+'</small></td></tr>').join('')+'</tbody></table></div>'+
  '<h3>Workspaces und Projekte</h3><div class="table-wrap"><table><thead><tr><th>Workspace</th><th>Projekte</th><th>Mitglieder</th></tr></thead><tbody>'+
  result.workspaces.map(w=>'<tr><td>'+escapeHtml(w.name)+'</td><td>'+(w.projects===null?'Nicht ermittelt':w.projects.length+'<br>'+list(w.projects.map(p=>p.name)))+'</td><td>'+(w.members===null?'Nicht ermittelt':w.members.length+' insgesamt<br>'+w.studentEmails.length+' Studierende zugeordnet<br>'+w.otherMemberEmails.length+' weitere Konten')+'</td></tr>').join('')+'</tbody></table></div>'+
  '<h3>Tenants</h3>'+(result.runtime.available?'<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Gruppen</th><th>Weitere Zuordnungen</th><th>Laufzeitdaten</th></tr></thead><tbody>'+result.runtime.tenants.map(t=>'<tr><td>'+escapeHtml(t.name)+'<br><small>'+escapeHtml(t.id)+(t.system?' · System-Tenant':'')+'</small></td><td>'+list(t.groupIds.map(id=>groupNames.get(id)||id))+'</td><td>'+t.users.length+' direkte Benutzer, '+t.roleIds.length+' Rollen, '+t.clientIds.length+' Clients, '+t.mappingRuleCount+' Mapping-Regeln</td><td>Noch nicht geprüft</td></tr>').join('')+'</tbody></table></div>':'<p>Runtime-Zuordnungen sind nicht vollständig verfügbar.</p>')+
  (result.warnings.length?'<h3>Unvollständige Abfragen</h3><ul class="analysis-list">'+result.warnings.map(w=>'<li>'+escapeHtml(w)+'</li>').join('')+'</ul>':'')+
  '<details class="analysis-detail"><summary>Was vor einer Löschung noch geprüft werden muss</summary><ul class="analysis-list">'+result.limitations.map(l=>'<li>'+escapeHtml(l)+'</li>').join('')+'</ul></details>';
}

renderSidebarSites();
checkLive();
let sidebarPolling = false;
setInterval(async () => {
 if (document.hidden || checking || sidebarPolling) return;
 sidebarPolling = true;
 try {
  for (const id of ['basel', 'brugg', 'olten']) {
   if (clusterWatches.has(id) || startingClusters.has(id)) continue;
   try { await readLiveSite(id, true); }
   catch { liveResults.delete(id); renderSidebarSites(); }
  }
 } finally { sidebarPolling = false; }
}, 60000);


let assignmentSummaryBusy = false;
async function loadAssignmentSummary(refresh = false) {
 if (assignmentSummaryBusy || window.SessionState?.expired) return;
 assignmentSummaryBusy = true;
 const button = document.querySelector('#sidebar-check'), host = document.querySelector('#sidebar-assignments'), note = document.querySelector('#sidebar-check-status');
 button.disabled = true; if (refresh) note.textContent = 'Live-Abgleich läuft …';
 try {
  const response = await fetch('/api/operations/pending' + (refresh ? '?refresh=1' : ''), { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error('Prüfstand derzeit nicht erreichbar.');
  const data = await response.json();
  host.innerHTML = ['basel', 'brugg', 'olten'].map(id => {
   const s = data.sites?.[id]; if (!s) return '';
   const stale = !s.checkedAt || Date.now() - Date.parse(s.checkedAt) > 10 * 60000;
   return '<div class="sidebar-assignment"><strong>' + siteLabel(id) + '</strong><dl>' + [[s.students,'Erfasst'],[s.invitedOrActive,'Eingel./aktiv'],[s.invitations,'Offen'],[s.ready,'Vollständig'],[s.assignments,'Fehlt/prüfen'],[s.unknown,'Unbestätigt']].map(([n,label]) => '<div><dt>' + label + '</dt><dd>' + n + '</dd></div>').join('') + '</dl><small>' + (stale ? 'Stand nicht aktuell · ' : 'Geprüft · ') + (s.checkedAt ? escapeHtml(new Date(s.checkedAt).toLocaleString('de-CH')) : 'noch keine vollständige Prüfung') + '</small></div>';
  }).join('');
  note.textContent = refresh ? 'Live-Stand abgeglichen.' : 'Automatischer Abgleich: alle 5 Min.';
  host.title = 'Personen je Standort einmal. Vollständig: alle Klassenzugriffe bestätigt. Eingeladen/aktiv: aktueller Organisationsstand, keine historische Versandzahl. Kategorien können sich überschneiden.';
 } catch (error) { note.textContent = error.message; }
 finally { assignmentSummaryBusy = false; button.disabled = false; }
}
document.querySelector('#sidebar-check').addEventListener('click', () => loadAssignmentSummary(true));
window.addEventListener('session-restored', () => loadAssignmentSummary());
setInterval(() => { if (!document.hidden) loadAssignmentSummary(); }, 60000);
loadAssignmentSummary();
