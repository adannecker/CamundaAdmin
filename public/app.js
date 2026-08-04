const state = {
  cluster: 'basel',
  resource: 'members',
  members: [],
  activities: [],
  selectedEmails: new Set(),
  filters: { name: '', email: '', roles: new Set() },
  activityFilters: { query: '', entity: '', actionType: '', limit: 100 },
};
const labels = { members: 'Member', projects: 'Projekte', connectors: 'Connectors', clusters: 'Cluster', activities: 'Aktivitäten' };
const clusterNames = { basel: 'Basel', brugg: 'Brugg', olten: 'Olten' };
const clusterNav = document.querySelector('#cluster-nav');
const resourceNav = document.querySelector('#resource-nav');
const content = document.querySelector('#content');
const notice = document.querySelector('#notice');
const deleteDialog = document.querySelector('#delete-dialog');
const deleteSummary = document.querySelector('#delete-summary');
const deleteProgress = document.querySelector('#delete-progress');
const deleteErrors = document.querySelector('#delete-errors');
const deleteCancel = document.querySelector('#delete-cancel');
const deleteConfirm = document.querySelector('#delete-confirm');

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

function value(input) {
  if (input === null || input === undefined) return '–';
  if (typeof input === 'object') return JSON.stringify(input);
  return String(input);
}

function rowsFrom(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['items', 'data', 'result', 'members', 'projects', 'clusters', 'connectors', 'activities']) if (Array.isArray(data?.[key])) return data[key];
  return data ? [data] : [];
}

function renderNavigation() {
  clusterNav.innerHTML = Object.entries(clusterNames).map(([id, name]) => `<button class="nav-item ${id === state.cluster ? 'active' : ''}" data-cluster="${id}">${name}</button>`).join('');
  resourceNav.innerHTML = Object.entries(labels).map(([id, name]) => `<button class="tab ${id === state.resource ? 'active' : ''}" data-resource="${id}">${name}</button>`).join('');
  document.querySelector('#page-title').textContent = clusterNames[state.cluster];
  document.querySelector('#list-title').textContent = labels[state.resource];
  clusterNav.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    state.cluster = button.dataset.cluster;
    state.selectedEmails.clear();
    state.filters.roles.clear();
    renderNavigation();
    load();
  }));
  resourceNav.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    state.resource = button.dataset.resource;
    renderNavigation();
    load();
  }));
}

function emailMatches(email, pattern) {
  const query = pattern.trim().toLowerCase();
  if (!query) return true;
  const source = String(email || '').toLowerCase();
  if (!query.includes('*')) return source.includes(query);
  const expression = `^${query.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
  return new RegExp(expression).test(source);
}

function filteredMembers() {
  const name = state.filters.name.trim().toLowerCase();
  return state.members.filter((member) => {
    const roles = (member.roles || []).map((role) => String(role).toLowerCase());
    return (!name || String(member.name || '').toLowerCase().includes(name))
      && emailMatches(member.email, state.filters.email)
      && [...state.filters.roles].every((role) => roles.includes(role.toLowerCase()));
  });
}

function availableRoles() {
  return [...new Set(state.members.flatMap((member) => member.roles || []).map(String))].sort((a, b) => a.localeCompare(b));
}

function renderRoleMenu() {
  const menu = document.querySelector('#role-menu');
  if (!menu) return;
  const roles = availableRoles();
  menu.innerHTML = roles.length
    ? roles.map((role) => `<label><input type="checkbox" value="${escapeHtml(role)}" ${state.filters.roles.has(role) ? 'checked' : ''}> ${escapeHtml(role)}</label>`).join('')
    : '<span>Keine Rollen vorhanden.</span>';
  menu.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) state.filters.roles.add(input.value);
    else state.filters.roles.delete(input.value);
    updateMemberTable();
  }));
  document.querySelector('#role-filter').textContent = state.filters.roles.size ? `Rollen (${state.filters.roles.size})` : 'Rollen filtern';
}

function updateMemberTable() {
  const tableHost = document.querySelector('#member-table');
  if (!tableHost) return;
  const members = filteredMembers();
  const selectedVisible = members.filter((member) => state.selectedEmails.has(member.email));
  const allSelected = members.length > 0 && selectedVisible.length === members.length;
  document.querySelector('#count').textContent = `${members.length} von ${state.members.length} Einträgen`;
  document.querySelector('#role-filter').textContent = state.filters.roles.size ? `Rollen (${state.filters.roles.size})` : 'Rollen filtern';
  document.querySelector('#selected-count').textContent = `${state.selectedEmails.size} ausgewählt`;
  document.querySelector('#delete-selected').disabled = state.selectedEmails.size === 0;

  if (!members.length) {
    tableHost.innerHTML = '<div class="empty">Keine Member entsprechen den aktuellen Filtern.</div>';
    return;
  }
  tableHost.innerHTML = `<div class="table-wrap"><table class="member-table"><thead><tr><th class="selection"><input id="select-all" type="checkbox" aria-label="Alle gefilterten Member auswählen" ${allSelected ? 'checked' : ''}></th><th>Name</th><th>E-Mail</th><th>Rollen</th><th>Einladung</th></tr></thead><tbody>${members.map((member) => `<tr><td class="selection"><input class="member-select" type="checkbox" data-email="${escapeHtml(member.email)}" ${state.selectedEmails.has(member.email) ? 'checked' : ''}></td><td>${escapeHtml(member.name)}</td><td>${escapeHtml(member.email)}</td><td>${(member.roles || []).map((role) => `<span class="role">${escapeHtml(role)}</span>`).join(' ') || '–'}</td><td>${member.invitePending ? 'Ausstehend' : '–'}</td></tr>`).join('')}</tbody></table></div>`;
  const selectAll = document.querySelector('#select-all');
  selectAll.indeterminate = selectedVisible.length > 0 && !allSelected;
  selectAll.addEventListener('change', () => {
    members.forEach((member) => selectAll.checked ? state.selectedEmails.add(member.email) : state.selectedEmails.delete(member.email));
    updateMemberTable();
  });
  tableHost.querySelectorAll('.member-select').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) state.selectedEmails.add(input.dataset.email);
    else state.selectedEmails.delete(input.dataset.email);
    updateMemberTable();
  }));
}

function renderMembers(rows) {
  state.members = rows.filter((member) => member?.email);
  state.selectedEmails.clear();
  const roles = availableRoles();
  content.innerHTML = `<div class="member-controls"><input id="name-filter" type="search" placeholder="Name suchen" aria-label="Name suchen" value="${escapeHtml(state.filters.name)}"><input id="email-filter" type="search" placeholder="E-Mail suchen, * als Platzhalter" aria-label="E-Mail suchen" value="${escapeHtml(state.filters.email)}"><div class="role-picker"><button id="role-filter" type="button" aria-expanded="false">Rollen filtern</button><div id="role-menu" class="role-menu" hidden></div></div><button id="clear-selection" type="button">Auswahl aufheben</button></div><div class="member-actions"><span id="selected-count"></span><button id="delete-selected" class="danger" type="button">Ausgewählte löschen</button></div><div id="member-table"></div>`;
  document.querySelector('#name-filter').addEventListener('input', (event) => { state.filters.name = event.target.value; updateMemberTable(); });
  document.querySelector('#email-filter').addEventListener('input', (event) => { state.filters.email = event.target.value; updateMemberTable(); });
  document.querySelector('#role-filter').addEventListener('click', () => {
    const menu = document.querySelector('#role-menu');
    menu.hidden = !menu.hidden;
    document.querySelector('#role-filter').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.querySelector('#clear-selection').addEventListener('click', () => { state.selectedEmails.clear(); updateMemberTable(); });
  document.querySelector('#delete-selected').addEventListener('click', openDeleteConfirmation);
  renderRoleMenu(roles);
  updateMemberTable();
}

function showNotice(message, type = 'error') {
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
}

function openDeleteConfirmation() {
  const emails = [...state.selectedEmails];
  if (!emails.length) return;
  const preview = emails.slice(0, 5).map(escapeHtml).join(', ');
  deleteSummary.innerHTML = `Du löschst <strong>${emails.length} Member</strong> aus ${escapeHtml(clusterNames[state.cluster])}. Diese Aktion kann nicht rückgängig gemacht werden.${preview ? `<br><small>${preview}${emails.length > 5 ? ' …' : ''}</small>` : ''}`;
  deleteProgress.hidden = true;
  deleteErrors.hidden = true;
  deleteCancel.hidden = false;
  deleteCancel.disabled = false;
  deleteConfirm.disabled = false;
  deleteConfirm.textContent = `Endgültig ${emails.length} löschen`;
  deleteCancel.onclick = () => deleteDialog.close();
  deleteConfirm.onclick = () => deleteSelectedMembers(emails);
  deleteDialog.showModal();
}

async function deleteSelectedMembers(emails) {
  deleteConfirm.disabled = true;
  deleteCancel.disabled = true;
  deleteProgress.hidden = false;
  const deleted = [];
  const failed = [];
  for (let index = 0; index < emails.length; index += 1) {
    const email = emails[index];
    deleteProgress.textContent = `Lösche ${index + 1} von ${emails.length}: ${email}`;
    try {
      const response = await fetch(`/api/${state.cluster}/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unbekannter Fehler');
      deleted.push(email);
    } catch (error) {
      failed.push(`${email}: ${error.message}`);
    }
  }
  state.members = state.members.filter((member) => !deleted.includes(member.email));
  state.selectedEmails = new Set(failed.map((message) => message.split(': ')[0]));
  deleteProgress.textContent = `${deleted.length} von ${emails.length} Membern gelöscht.`;
  if (failed.length) {
    deleteErrors.textContent = `${failed.length} Löschungen fehlgeschlagen: ${failed.join(' | ')}`;
    deleteErrors.hidden = false;
  }
  deleteCancel.hidden = true;
  deleteConfirm.disabled = false;
  deleteConfirm.textContent = 'Schließen';
  deleteConfirm.onclick = () => { deleteDialog.close(); updateMemberTable(); showNotice(`${deleted.length} Member gelöscht.`, 'success'); };
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? value(timestamp) : date.toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
}

function activityEntities() {
  return [...new Set(state.activities.map((activity) => activity.entity).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function filteredActivities() {
  const query = state.activityFilters.query.trim().toLowerCase();
  return state.activities
    .filter((activity) => (!state.activityFilters.entity || activity.entity === state.activityFilters.entity)
      && (!state.activityFilters.actionType || activity.actionType === state.activityFilters.actionType)
      && (!query || [activity.action, activity.userId, activity.entity, activity.service].some((field) => String(field || '').toLowerCase().includes(query))))
    .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
}

function updateActivityTable() {
  const tableHost = document.querySelector('#activity-table');
  if (!tableHost) return;
  const activities = filteredActivities();
  const visible = activities.slice(0, state.activityFilters.limit);
  document.querySelector('#count').textContent = `${activities.length} von ${state.activities.length} Ereignissen`;
  document.querySelector('#activity-results').textContent = `Zeige ${visible.length} von ${activities.length} gefilterten Ereignissen`;
  if (!visible.length) {
    tableHost.innerHTML = '<div class="empty">Keine Aktivitäten entsprechen den aktuellen Filtern.</div>';
    return;
  }
  tableHost.innerHTML = `<div class="table-wrap"><table class="activity-table"><thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Bereich</th><th>Ausgeführt von</th></tr></thead><tbody>${visible.map((activity) => `<tr><td>${escapeHtml(formatDate(activity.timestamp))}</td><td>${escapeHtml(value(activity.action))}</td><td><span class="role">${escapeHtml(value(activity.entity))}</span></td><td>${escapeHtml(value(activity.userId))}</td></tr>`).join('')}</tbody></table></div>${activities.length > visible.length ? '<button id="load-more-activities" class="load-more" type="button">Weitere 100 anzeigen</button>' : ''}`;
  document.querySelector('#load-more-activities')?.addEventListener('click', () => { state.activityFilters.limit += 100; updateActivityTable(); });
}

function renderActivities(rows) {
  state.activities = rows;
  state.activityFilters.limit = 100;
  const countByEntity = (entity) => rows.filter((activity) => activity.entity === entity).length;
  const entities = activityEntities();
  content.innerHTML = `<div class="activity-summary"><div><span>${rows.length}</span> Ereignisse</div><div><span>${countByEntity('member')}</span> Member-Aktionen</div><div><span>${countByEntity('cluster')}</span> Cluster-Aktionen</div><div><span>${countByEntity('connector secret')}</span> Secret-Aktionen</div></div><div class="member-controls activity-controls"><input id="activity-search" type="search" placeholder="Aktion oder Benutzer suchen" aria-label="Aktivitäten durchsuchen"><select id="activity-entity" aria-label="Bereich filtern"><option value="">Alle Bereiche</option>${entities.map((entity) => `<option value="${escapeHtml(entity)}">${escapeHtml(entity)}</option>`).join('')}</select><select id="activity-type" aria-label="Aktionstyp filtern"><option value="">Alle Aktionstypen</option><option value="c">Erstellt</option><option value="u">Geändert</option><option value="d">Gelöscht</option></select></div><p id="activity-results" class="activity-results"></p><div id="activity-table"></div>`;
  document.querySelector('#activity-search').addEventListener('input', (event) => { state.activityFilters.query = event.target.value; state.activityFilters.limit = 100; updateActivityTable(); });
  document.querySelector('#activity-entity').addEventListener('change', (event) => { state.activityFilters.entity = event.target.value; state.activityFilters.limit = 100; updateActivityTable(); });
  document.querySelector('#activity-type').addEventListener('change', (event) => { state.activityFilters.actionType = event.target.value; state.activityFilters.limit = 100; updateActivityTable(); });
  updateActivityTable();
}

function renderData(data) {
  const rows = rowsFrom(data);
  document.querySelector('#description').textContent = `Aktuelle ${labels[state.resource]} für ${clusterNames[state.cluster]}.`;
  if (state.resource === 'members') {
    renderMembers(rows);
    return;
  }
  if (state.resource === 'activities') {
    renderActivities(rows);
    return;
  }
  document.querySelector('#count').textContent = `${rows.length} Einträge`;
  if (!rows.length) { content.innerHTML = '<div class="empty">Keine Einträge vorhanden.</div>'; return; }
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  content.innerHTML = `<div class="table-wrap"><table><thead><tr>${keys.map((key) => `<th>${key}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${keys.map((key) => `<td title="${escapeHtml(value(row[key]))}">${escapeHtml(value(row[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

async function load() {
  content.className = 'loading';
  content.textContent = 'Daten werden geladen …';
  notice.hidden = true;
  document.querySelector('#count').textContent = '';
  try {
    const response = await fetch(`/api/${state.cluster}/${state.resource}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Die Daten konnten nicht geladen werden.');
    content.className = '';
    renderData(result.data);
  } catch (error) {
    content.className = 'empty';
    content.textContent = 'Es liegen derzeit keine anzeigbaren Daten vor.';
    showNotice(error.message);
  }
}

document.querySelector('#refresh').addEventListener('click', load);
renderNavigation();
load();
