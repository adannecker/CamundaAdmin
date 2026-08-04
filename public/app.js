const state = {
  cluster: 'basel',
  resource: 'members',
  members: [],
  projects: [],
  projectColumns: [],
  projectSort: { key: 'name', direction: 'asc' },
  selectedProjectIds: new Set(),
  projectFilters: { query: '', ownerStatus: '' },
  activities: [],
  selectedEmails: new Set(),
  filters: { name: '', email: '', roles: new Set() },
  memberSort: { key: 'name', direction: 'asc' },
  memberSinceFilter: null,
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
const processCleanupDialog = document.querySelector('#process-cleanup-dialog');
const processCleanupSummary = document.querySelector('#process-cleanup-summary');
const processCleanupConfirmation = document.querySelector('#process-cleanup-confirmation');
const processCleanupDialogError = document.querySelector('#process-cleanup-dialog-error');
const processCleanupCancel = document.querySelector('#process-cleanup-cancel');
const processCleanupConfirm = document.querySelector('#process-cleanup-confirm');
const definitionCleanupDialog = document.querySelector('#definition-cleanup-dialog');
const definitionCleanupSummary = document.querySelector('#definition-cleanup-summary');
const definitionCleanupConfirmation = document.querySelector('#definition-cleanup-confirmation');
const definitionCleanupDialogError = document.querySelector('#definition-cleanup-dialog-error');
const definitionCleanupCancel = document.querySelector('#definition-cleanup-cancel');
const definitionCleanupConfirm = document.querySelector('#definition-cleanup-confirm');
const projectDeleteDialog = document.querySelector('#project-delete-dialog');
const projectDeleteSummary = document.querySelector('#project-delete-summary');
const projectDeleteConfirmation = document.querySelector('#project-delete-confirmation');
const projectDeleteProgress = document.querySelector('#project-delete-progress');
const projectDeleteError = document.querySelector('#project-delete-error');
const projectDeleteCancel = document.querySelector('#project-delete-cancel');
const projectDeleteConfirm = document.querySelector('#project-delete-confirm');
const clusterDeleteDialog = document.querySelector('#cluster-delete-dialog');
const clusterDeleteSummary = document.querySelector('#cluster-delete-summary');
const clusterDeleteConfirmation = document.querySelector('#cluster-delete-confirmation');
const clusterDeleteError = document.querySelector('#cluster-delete-error');
const clusterDeleteCancel = document.querySelector('#cluster-delete-cancel');
const clusterDeleteConfirm = document.querySelector('#cluster-delete-confirm');
let cleanupPollTimer;
let definitionCleanupPollTimer;
let projectDeletionPollTimer;
let projectDeletionFinished = false;

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
  document.body.classList.toggle('projects-view', state.resource === 'projects' || state.resource === 'clusters');
  clusterNav.innerHTML = Object.entries(clusterNames).map(([id, name]) => `<button class="nav-item ${id === state.cluster ? 'active' : ''}" data-cluster="${id}">${name}</button>`).join('');
  resourceNav.innerHTML = Object.entries(labels).map(([id, name]) => `<button class="tab ${id === state.resource ? 'active' : ''}" data-resource="${id}">${name}</button>`).join('');
  document.querySelector('#page-title').textContent = clusterNames[state.cluster];
  document.querySelector('#list-title').textContent = labels[state.resource];
  clusterNav.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    state.cluster = button.dataset.cluster;
    state.selectedEmails.clear();
    state.selectedProjectIds.clear();
    state.projectFilters = { query: '', ownerStatus: '' };
    state.filters.roles.clear();
    state.memberSinceFilter = null;
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

function memberSinceKey(member) {
  if (!member?.memberSince) return '__empty__';
  const date = new Date(member.memberSince);
  if (Number.isNaN(date.getTime())) return '__empty__';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(date);
}

function availableMemberSinceDates() {
  const keys = [...new Set(state.members.map(memberSinceKey))];
  return keys.sort((left, right) => {
    if (left === '__empty__') return 1;
    if (right === '__empty__') return -1;
    return right.localeCompare(left);
  });
}

function memberSinceLabel(key) {
  if (key === '__empty__') return '(Leer)';
  const date = new Date(`${key}T12:00:00`);
  return date.toLocaleDateString('de-CH', { dateStyle: 'medium' });
}

function memberSortValue(member, key) {
  if (key === 'roles') return (member.roles || []).join(', ');
  if (key === 'invitePending') return member.invitePending ? 1 : 0;
  if (key === 'memberSince') return member.memberSince ? Number(member.memberSince) : null;
  return member?.[key];
}

function compareMembers(left, right) {
  const { key, direction } = state.memberSort;
  const leftValue = memberSortValue(left, key);
  const rightValue = memberSortValue(right, key);
  const leftEmpty = leftValue === null || leftValue === undefined || leftValue === '';
  const rightEmpty = rightValue === null || rightValue === undefined || rightValue === '';
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
  const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
    ? leftValue - rightValue
    : String(leftValue).localeCompare(String(rightValue), 'de-CH', { numeric: true, sensitivity: 'base' });
  return comparison * (direction === 'asc' ? 1 : -1);
}

function filteredMembers() {
  const name = state.filters.name.trim().toLowerCase();
  return state.members.filter((member) => {
    const roles = (member.roles || []).map((role) => String(role).toLowerCase());
    return (!name || String(member.name || '').toLowerCase().includes(name))
      && emailMatches(member.email, state.filters.email)
      && [...state.filters.roles].every((role) => roles.includes(role.toLowerCase()))
      && (state.memberSinceFilter === null || state.memberSinceFilter.has(memberSinceKey(member)));
  }).sort(compareMembers);
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

function renderMemberSinceMenu() {
  const menu = document.querySelector('#member-date-menu');
  if (!menu) return;
  const dates = availableMemberSinceDates();
  const selected = state.memberSinceFilter;
  const selectedCount = selected === null ? dates.length : dates.filter((key) => selected.has(key)).length;
  const allSelected = selectedCount === dates.length;
  menu.innerHTML = `<label class="date-filter-all"><input id="member-date-all" type="checkbox" ${allSelected ? 'checked' : ''}> (Alle auswählen)</label>${dates.map((key) => `<label><input class="member-date-option" type="checkbox" value="${escapeHtml(key)}" ${selected === null || selected.has(key) ? 'checked' : ''}> ${escapeHtml(memberSinceLabel(key))}</label>`).join('')}`;
  const selectAll = menu.querySelector('#member-date-all');
  selectAll.indeterminate = selectedCount > 0 && !allSelected;
  selectAll.addEventListener('change', () => {
    state.memberSinceFilter = selectAll.checked ? null : new Set();
    renderMemberSinceMenu();
    updateMemberTable();
  });
  menu.querySelectorAll('.member-date-option').forEach((input) => input.addEventListener('change', () => {
    if (state.memberSinceFilter === null) state.memberSinceFilter = new Set(dates);
    if (input.checked) state.memberSinceFilter.add(input.value);
    else state.memberSinceFilter.delete(input.value);
    if (state.memberSinceFilter.size === dates.length) state.memberSinceFilter = null;
    renderMemberSinceMenu();
    updateMemberTable();
  }));
  const button = document.querySelector('#member-date-filter');
  if (button) button.textContent = selectedCount === dates.length ? 'Member seit filtern' : `Member seit (${selectedCount}/${dates.length})`;
}

function memberSortHeader(key, label) {
  const active = state.memberSort.key === key;
  const direction = state.memberSort.direction;
  const arrow = active ? (direction === 'asc' ? ' ↑' : ' ↓') : '';
  return `<th aria-sort="${active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sort-button member-sort-button" type="button" data-column="${escapeHtml(key)}">${escapeHtml(label)}${arrow}</button></th>`;
}

function updateMemberTable() {
  const tableHost = document.querySelector('#member-table');
  if (!tableHost) return;
  const members = filteredMembers();
  const selectedVisible = members.filter((member) => state.selectedEmails.has(member.email));
  const allSelected = members.length > 0 && selectedVisible.length === members.length;
  document.querySelector('#count').textContent = `${members.length} von ${state.members.length} Einträgen`;
  document.querySelector('#role-filter').textContent = state.filters.roles.size ? `Rollen (${state.filters.roles.size})` : 'Rollen filtern';
  const dateOptions = availableMemberSinceDates();
  const selectedDateCount = state.memberSinceFilter === null ? dateOptions.length : dateOptions.filter((key) => state.memberSinceFilter.has(key)).length;
  document.querySelector('#member-date-filter').textContent = selectedDateCount === dateOptions.length ? 'Member seit filtern' : `Member seit (${selectedDateCount}/${dateOptions.length})`;
  document.querySelector('#selected-count').textContent = `${state.selectedEmails.size} ausgewählt`;
  document.querySelector('#delete-selected').disabled = state.selectedEmails.size === 0;

  if (!members.length) {
    tableHost.innerHTML = '<div class="empty">Keine Member entsprechen den aktuellen Filtern.</div>';
    return;
  }
  tableHost.innerHTML = `<div class="table-wrap"><table class="member-table"><thead><tr><th class="selection"><input id="select-all" type="checkbox" aria-label="Alle gefilterten Member auswählen" ${allSelected ? 'checked' : ''}></th>${memberSortHeader('name', 'Name')}${memberSortHeader('email', 'E-Mail')}${memberSortHeader('roles', 'Rollen')}${memberSortHeader('memberSince', 'Member seit')}${memberSortHeader('invitePending', 'Einladung')}</tr></thead><tbody>${members.map((member) => `<tr><td class="selection"><input class="member-select" type="checkbox" data-email="${escapeHtml(member.email)}" ${state.selectedEmails.has(member.email) ? 'checked' : ''}></td><td>${escapeHtml(member.name)}</td><td>${escapeHtml(member.email)}</td><td>${(member.roles || []).map((role) => `<span class="role">${escapeHtml(role)}</span>`).join(' ') || '–'}</td><td>${escapeHtml(member.memberSince ? formatDate(member.memberSince) : '–')}</td><td>${member.invitePending ? 'Ausstehend' : '–'}</td></tr>`).join('')}</tbody></table></div>`;
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
  tableHost.querySelectorAll('.member-sort-button').forEach((button) => button.addEventListener('click', () => {
    const column = button.dataset.column;
    state.memberSort = state.memberSort.key === column
      ? { key: column, direction: state.memberSort.direction === 'asc' ? 'desc' : 'asc' }
      : { key: column, direction: 'asc' };
    updateMemberTable();
  }));
}

function renderMembers(rows) {
  state.members = rows.filter((member) => member?.email);
  state.selectedEmails.clear();
  const roles = availableRoles();
  content.innerHTML = `<div class="member-controls"><input id="name-filter" type="search" placeholder="Name suchen" aria-label="Name suchen" value="${escapeHtml(state.filters.name)}"><input id="email-filter" type="search" placeholder="E-Mail suchen, * als Platzhalter" aria-label="E-Mail suchen" value="${escapeHtml(state.filters.email)}"><div class="role-picker"><button id="role-filter" type="button" aria-expanded="false">Rollen filtern</button><div id="role-menu" class="role-menu" hidden></div></div><div class="role-picker"><button id="member-date-filter" type="button" aria-expanded="false">Member seit filtern</button><div id="member-date-menu" class="role-menu member-date-menu" hidden></div></div><button id="clear-selection" type="button">Auswahl aufheben</button></div><div class="member-actions"><span id="selected-count"></span><button id="delete-selected" class="danger" type="button">Ausgewählte löschen</button></div><div id="member-table"></div>`;
  document.querySelector('#name-filter').addEventListener('input', (event) => { state.filters.name = event.target.value; updateMemberTable(); });
  document.querySelector('#email-filter').addEventListener('input', (event) => { state.filters.email = event.target.value; updateMemberTable(); });
  document.querySelector('#role-filter').addEventListener('click', () => {
    const menu = document.querySelector('#role-menu');
    menu.hidden = !menu.hidden;
    document.querySelector('#role-filter').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.querySelector('#member-date-filter').addEventListener('click', () => {
    const menu = document.querySelector('#member-date-menu');
    menu.hidden = !menu.hidden;
    document.querySelector('#member-date-filter').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.querySelector('#clear-selection').addEventListener('click', () => { state.selectedEmails.clear(); updateMemberTable(); });
  document.querySelector('#delete-selected').addEventListener('click', openDeleteConfirmation);
  renderRoleMenu(roles);
  renderMemberSinceMenu();
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
      && (!query || [activity.action, activity.userId, activity.userName, activity.entity, activity.service].some((field) => String(field || '').toLowerCase().includes(query))))
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
  tableHost.innerHTML = `<div class="table-wrap"><table class="activity-table"><thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Bereich</th><th>Name</th><th>Ausgeführt von</th></tr></thead><tbody>${visible.map((activity) => `<tr><td>${escapeHtml(formatDate(activity.timestamp))}</td><td>${escapeHtml(value(activity.action))}</td><td><span class="role">${escapeHtml(value(activity.entity))}</span></td><td>${escapeHtml(value(activity.userName))}</td><td>${escapeHtml(value(activity.userId))}</td></tr>`).join('')}</tbody></table></div>${activities.length > visible.length ? '<button id="load-more-activities" class="load-more" type="button">Weitere 100 anzeigen</button>' : ''}`;
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

const projectTeamFields = ['teamMembers', 'members', 'collaborators', 'team', 'users'];
const projectHiddenFields = ['ownerMissing'];

function projectTeamMembers(project) {
  const field = projectTeamFields.find((key) => Array.isArray(project?.[key]));
  if (!field) return [];
  return project[field].map((member) => {
    if (typeof member === 'string') return member;
    const name = String(member?.name || member?.displayName || '').trim();
    const email = String(member?.email || member?.username || '').trim();
    if (name && email && !name.toLowerCase().includes(email.toLowerCase())) return `${name} (${email})`;
    return name || email || member?.id;
  }).filter(Boolean).map(String);
}

function projectPeopleText(people) {
  return (Array.isArray(people) ? people : []).map((person) => {
    if (typeof person === 'string') return person;
    const name = String(person?.name || person?.displayName || '').trim();
    const email = String(person?.email || person?.username || '').trim();
    if (name && email && !name.toLowerCase().includes(email.toLowerCase())) return `${name} (${email})`;
    return name || email || person?.id || '';
  }).filter(Boolean).join(', ');
}

function projectRawText(input) {
  if (input === null || input === undefined) return '';
  if (Array.isArray(input)) return projectPeopleText(input);
  if (typeof input === 'object') return projectPeopleText([input]) || JSON.stringify(input);
  return String(input);
}

function projectSortValue(project, key) {
  if (key === 'teamMembers') return projectTeamMembers(project).join(', ');
  return projectRawText(project?.[key]);
}

function compareProjectValues(left, right, key) {
  const leftValue = projectSortValue(left, key);
  const rightValue = projectSortValue(right, key);
  const leftEmpty = leftValue === null || leftValue === undefined || leftValue === '';
  const rightEmpty = rightValue === null || rightValue === undefined || rightValue === '';
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
  if (key === 'created' || key === 'updated') {
    const difference = new Date(leftValue).getTime() - new Date(rightValue).getTime();
    if (!Number.isNaN(difference)) return difference;
  }
  if (typeof leftValue === 'number' && typeof rightValue === 'number') return leftValue - rightValue;
  return String(leftValue).localeCompare(String(rightValue), 'de-CH', { numeric: true, sensitivity: 'base' });
}

function projectDisplayValue(project, key) {
  if (key === 'teamMembers') return projectTeamMembers(project).join(', ') || '–';
  if ((key === 'created' || key === 'updated') && project?.[key]) return formatDate(project[key]);
  return projectRawText(project?.[key]) || '–';
}

function projectColumnLabel(key) {
  return ({
    id: 'ID',
    name: 'Name',
    created: 'Erstellt',
    createdBy: 'Erstellt von',
    updated: 'Aktualisiert',
    updatedBy: 'Aktualisiert von',
    owners: 'Owner',
    ownerStatus: 'Owner-Status',
    teamMembers: 'Teammitglieder',
  })[key] || key;
}

function filteredProjects() {
  const query = state.projectFilters.query.trim().toLowerCase();
  return state.projects.filter((project) => {
    const matchesOwner = !state.projectFilters.ownerStatus
      || (state.projectFilters.ownerStatus === 'no-member' ? project.ownerMissing : project.ownerStatus === 'Member');
    const matchesQuery = !query || state.projectColumns.some((column) => projectDisplayValue(project, column).toLowerCase().includes(query));
    return matchesOwner && matchesQuery;
  });
}

function updateProjectControls(projects) {
  const selectedCount = state.selectedProjectIds.size;
  document.querySelector('#count').textContent = `${state.projects.length} Projekte`;
  const result = document.querySelector('#project-results');
  if (result) result.textContent = `${projects.length} von ${state.projects.length} Projekten · ${selectedCount} ausgewählt`;
  const noMemberButton = document.querySelector('#select-no-member-projects');
  if (noMemberButton) noMemberButton.textContent = `Select all No Member (${state.projects.filter((project) => project.ownerMissing).length})`;
  const deleteButton = document.querySelector('#delete-selected-projects');
  if (deleteButton) deleteButton.disabled = selectedCount === 0;
}

function updateProjectTable() {
  const tableHost = document.querySelector('#project-table');
  if (!tableHost) return;
  const { key, direction } = state.projectSort;
  const projects = filteredProjects().sort((left, right) => compareProjectValues(left, right, key) * (direction === 'asc' ? 1 : -1));
  const header = state.projectColumns.map((column) => {
    const active = column === key;
    const arrow = active ? (direction === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th aria-sort="${active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sort-button" type="button" data-column="${escapeHtml(column)}">${escapeHtml(projectColumnLabel(column))}${arrow}</button></th>`;
  }).join('');
  const body = projects.map((project) => `<tr><td class="selection"><input class="project-select" type="checkbox" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} auswählen" ${state.selectedProjectIds.has(String(project.id)) ? 'checked' : ''}></td>${state.projectColumns.map((column) => {
    const displayValue = projectDisplayValue(project, column);
    return `<td title="${escapeHtml(displayValue)}">${escapeHtml(displayValue)}</td>`;
  }).join('')}</tr>`).join('');
  tableHost.innerHTML = projects.length
    ? `<div class="table-wrap"><table class="project-table"><thead><tr><th class="selection"><input id="select-visible-projects" type="checkbox" aria-label="Alle gefilterten Projekte auswählen"></th>${header}</tr></thead><tbody>${body}</tbody></table></div>`
    : '<div class="empty">Keine Projekte entsprechen den aktuellen Filtern.</div>';
  const selectVisible = document.querySelector('#select-visible-projects');
  if (selectVisible) {
    const selectedVisible = projects.filter((project) => state.selectedProjectIds.has(String(project.id))).length;
    selectVisible.checked = projects.length > 0 && selectedVisible === projects.length;
    selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < projects.length;
    selectVisible.addEventListener('change', () => {
      for (const project of projects) {
        if (selectVisible.checked) state.selectedProjectIds.add(String(project.id));
        else state.selectedProjectIds.delete(String(project.id));
      }
      updateProjectTable();
    });
  }
  tableHost.querySelectorAll('.project-select').forEach((checkbox) => checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedProjectIds.add(checkbox.dataset.projectId);
    else state.selectedProjectIds.delete(checkbox.dataset.projectId);
    updateProjectTable();
  }));
  tableHost.querySelectorAll('.sort-button').forEach((button) => button.addEventListener('click', () => {
    const column = button.dataset.column;
    state.projectSort = state.projectSort.key === column
      ? { key: column, direction: state.projectSort.direction === 'asc' ? 'desc' : 'asc' }
      : { key: column, direction: 'asc' };
    updateProjectTable();
  }));
  updateProjectControls(projects);
}

function renderProjects(rows) {
  state.projects = rows;
  state.selectedProjectIds.clear();
  const deliveredColumns = [...new Set(rows.flatMap((project) => Object.keys(project)))].filter((key) => !projectTeamFields.includes(key) && !projectHiddenFields.includes(key));
  state.projectColumns = [...deliveredColumns, 'teamMembers'];
  const noMemberCount = rows.filter((project) => project.ownerMissing).length;
  document.querySelector('#count').textContent = `${rows.length} Projekte`;
  if (!rows.length) {
    content.innerHTML = '<div class="empty">Keine Projekte vorhanden.</div>';
    return;
  }
  content.innerHTML = `<div class="project-controls"><input id="project-search" type="search" placeholder="Projekte, Owner oder Teammitglieder suchen" aria-label="Projekte durchsuchen"><select id="project-owner-filter" aria-label="Owner-Status filtern"><option value="">Alle Owner</option><option value="member">Owner ist Member</option><option value="no-member">Owner ist No Member</option></select><button id="select-no-member-projects" type="button">Select all No Member (${noMemberCount})</button></div><div class="member-actions"><span id="project-results"></span><div><button id="clear-project-selection" type="button">Auswahl aufheben</button> <button id="delete-selected-projects" class="danger" type="button" disabled>Ausgewählte löschen</button></div></div><div id="project-table"></div>`;
  const search = document.querySelector('#project-search');
  const ownerFilter = document.querySelector('#project-owner-filter');
  search.value = state.projectFilters.query;
  ownerFilter.value = state.projectFilters.ownerStatus;
  search.addEventListener('input', () => { state.projectFilters.query = search.value; updateProjectTable(); });
  ownerFilter.addEventListener('change', () => { state.projectFilters.ownerStatus = ownerFilter.value; updateProjectTable(); });
  document.querySelector('#select-no-member-projects').addEventListener('click', () => {
    state.projectFilters.query = '';
    state.projectFilters.ownerStatus = 'no-member';
    search.value = '';
    ownerFilter.value = 'no-member';
    for (const project of state.projects.filter((item) => item.ownerMissing)) state.selectedProjectIds.add(String(project.id));
    updateProjectTable();
  });
  document.querySelector('#clear-project-selection').addEventListener('click', () => { state.selectedProjectIds.clear(); updateProjectTable(); });
  document.querySelector('#delete-selected-projects').addEventListener('click', openProjectDeleteDialog);
  updateProjectTable();
}

function openProjectDeleteDialog() {
  const projects = state.projects.filter((project) => state.selectedProjectIds.has(String(project.id)));
  if (!projects.length) return;
  const confirmation = `DELETE ${projects.length} PROJECTS`;
  projectDeletionFinished = false;
  projectDeleteDialog.dataset.projectIds = JSON.stringify(projects.map((project) => String(project.id)));
  projectDeleteDialog.dataset.confirmation = confirmation;
  projectDeleteConfirmation.value = '';
  projectDeleteConfirmation.disabled = false;
  projectDeleteConfirm.disabled = true;
  projectDeleteConfirm.textContent = 'Ausgewählte Projekte löschen';
  projectDeleteCancel.disabled = false;
  projectDeleteProgress.hidden = true;
  projectDeleteProgress.innerHTML = '';
  projectDeleteError.hidden = true;
  const names = projects.slice(0, 10).map((project) => escapeHtml(project.name)).join('<br>');
  const remainder = projects.length > 10 ? `<br>… und ${projects.length - 10} weitere` : '';
  projectDeleteSummary.innerHTML = `<strong>${projects.length} Web-Modeler-Projekte</strong> einschließlich aller darin enthaltenen BPMN-, DMN- und Form-Dateien werden unwiderruflich gelöscht.<small>${names}${remainder}</small><br>Gib <strong>${escapeHtml(confirmation)}</strong> ein:`;
  projectDeleteDialog.showModal();
  projectDeleteConfirmation.focus();
}

function renderProjectDeletionProgress(job) {
  projectDeleteProgress.hidden = false;
  const completedProjects = (job.deleted?.length || 0) + (job.alreadyMissing?.length || 0) + (job.failed?.length || 0);
  const position = job.status === 'running' ? (job.currentProject || Math.min(completedProjects + 1, job.totalProjects || 0)) : completedProjects;
  const summary = `Projekt ${position}/${job.totalProjects || 0} · ${job.deletedFiles || 0} Dateien · ${job.deletedFolders || 0} Ordner · ${job.failed?.length || 0} Fehler`;
  const allowedTypes = new Set(['info', 'project', 'folder', 'success', 'error']);
  const events = (job.events || []).map((event) => {
    const type = allowedTypes.has(event.type) ? event.type : 'info';
    const depth = Math.max(0, Math.min(Number(event.depth) || 0, 10));
    return `<div class="project-log-line ${type}" style="--indent:${depth * 18}px">${escapeHtml(event.message)}</div>`;
  }).join('');
  projectDeleteProgress.innerHTML = `<strong>${escapeHtml(summary)}</strong>${job.currentProjectName ? `<span>Aktuell: ${escapeHtml(job.currentProjectName)}</span>` : ''}<div class="project-delete-log">${events}</div>`;
  const log = projectDeleteProgress.querySelector('.project-delete-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function finishProjectDeletion(result) {
  if (projectDeletionFinished) return;
  projectDeletionFinished = true;
  const removed = new Set([...(result.deleted || []), ...(result.alreadyMissing || [])].map(String));
  state.projects = state.projects.filter((project) => !removed.has(String(project.id)));
  state.selectedProjectIds = new Set((result.failed || []).map((item) => String(item.projectId)).filter(Boolean));
  updateProjectTable();
  projectDeleteCancel.disabled = false;
  projectDeleteCancel.textContent = 'Schließen';
  projectDeleteConfirm.disabled = false;
  projectDeleteConfirm.textContent = 'Schließen';
  if (result.failed?.length) {
    showNotice(`${removed.size} Projekte gelöscht (${result.deletedFiles || 0} Dateien, ${result.deletedFolders || 0} Ordner entfernt), ${result.failed.length} fehlgeschlagen: ${result.failed.map((item) => item.error).join(' | ')}`);
  } else {
    showNotice(`${removed.size} Projekte endgültig gelöscht; ${result.deletedFiles || 0} Dateien und ${result.deletedFolders || 0} Ordner wurden zuvor entfernt.`, 'success');
  }
}

async function pollProjectDeletionStatus() {
  clearTimeout(projectDeletionPollTimer);
  try {
    const response = await fetch(`/api/${state.cluster}/projects/delete/status`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Löschstatus konnte nicht geladen werden.');
    if (result.status === 'idle') throw new Error('Der laufende Löschjob ist nicht mehr verfügbar.');
    renderProjectDeletionProgress(result);
    if (result.status === 'running') {
      projectDeletionPollTimer = setTimeout(pollProjectDeletionStatus, 750);
    } else {
      finishProjectDeletion(result);
    }
  } catch (error) {
    projectDeleteError.textContent = error.message;
    projectDeleteError.hidden = false;
    projectDeletionFinished = true;
    projectDeleteCancel.disabled = false;
    projectDeleteCancel.textContent = 'Schließen';
    projectDeleteConfirm.disabled = false;
    projectDeleteConfirm.textContent = 'Schließen';
  }
}

async function startProjectDeletion() {
  projectDeleteConfirm.disabled = true;
  projectDeleteCancel.disabled = true;
  projectDeleteConfirm.textContent = 'Projekte werden gelöscht …';
  projectDeleteConfirmation.disabled = true;
  projectDeleteError.hidden = true;
  try {
    const projectIds = JSON.parse(projectDeleteDialog.dataset.projectIds || '[]');
    const response = await fetch(`/api/${state.cluster}/projects/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectIds, confirmation: projectDeleteConfirmation.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Projekte konnten nicht gelöscht werden.');
    renderProjectDeletionProgress(result);
    projectDeletionPollTimer = setTimeout(pollProjectDeletionStatus, 500);
  } catch (error) {
    projectDeleteError.textContent = error.message;
    projectDeleteError.hidden = false;
    projectDeleteConfirmation.disabled = false;
    projectDeleteCancel.disabled = false;
    projectDeleteConfirm.disabled = false;
    projectDeleteConfirm.textContent = 'Ausgewählte Projekte löschen';
  }
}

function renderCleanupStatus(status) {
  const host = document.querySelector('#process-cleanup-status');
  const button = document.querySelector('#start-process-cleanup');
  if (!host || !button) return;
  const running = status.status === 'running';
  button.disabled = running;
  if (status.status === 'idle') {
    host.innerHTML = '';
    return;
  }
  const details = `Beendet: ${status.cancelled || 0}/${status.totalToCancel || 0} · Gelöscht: ${status.deleted || 0}/${status.totalToDelete || 0} · Fehler: ${status.failed || 0}`;
  const errors = status.errors?.length ? `<div class="cleanup-errors">${status.errors.map(escapeHtml).join('<br>')}</div>` : '';
  host.innerHTML = `<div class="cleanup-status ${escapeHtml(status.status)}"><strong>${escapeHtml(status.phaseLabel || status.status)}</strong><span>${escapeHtml(details)}</span>${errors}</div>`;
}

async function pollCleanupStatus() {
  clearTimeout(cleanupPollTimer);
  try {
    const response = await fetch(`/api/${state.cluster}/process-instances/cleanup`);
    const status = await response.json();
    renderCleanupStatus(status);
    if (status.status === 'running') cleanupPollTimer = setTimeout(pollCleanupStatus, 1000);
  } catch (error) {
    renderCleanupStatus({ status: 'failed', phaseLabel: error.message, failed: 1, errors: [] });
  }
}

async function openProcessCleanupDialog() {
  processCleanupDialogError.hidden = true;
  processCleanupSummary.textContent = 'Cleanup-Vorschau wird geladen …';
  processCleanupConfirmation.value = '';
  processCleanupConfirm.disabled = true;
  processCleanupDialog.showModal();
  try {
    const clusterId = state.cluster;
    const response = await fetch(`/api/${clusterId}/process-instances/cleanup-preview`);
    const preview = await response.json();
    if (!response.ok) throw new Error(preview.error || 'Cleanup-Vorschau konnte nicht geladen werden.');
    processCleanupDialog.dataset.cluster = clusterId;
    processCleanupDialog.dataset.confirmation = preview.confirmation;
    processCleanupDialog.dataset.rootCount = String(preview.rootCount);
    processCleanupSummary.innerHTML = `Es werden <strong>${preview.activeRootCount} laufende Root-Instanzen beendet</strong> und danach insgesamt <strong>${preview.rootCount} Root-Instanzen</strong> mit ${preview.childCount} abhängigen Child-Instanzen endgültig gelöscht.<br><small>Dieser Snapshot umfasst ${preview.total} sichtbare Prozessinstanzen. Die Daten können nicht wiederhergestellt werden.</small><br><br>Gib <strong>${escapeHtml(preview.confirmation)}</strong> ein:`;
    processCleanupConfirmation.focus();
  } catch (error) {
    processCleanupDialogError.textContent = error.message;
    processCleanupDialogError.hidden = false;
  }
}

async function startProcessCleanup() {
  processCleanupConfirm.disabled = true;
  processCleanupCancel.disabled = true;
  processCleanupDialogError.hidden = true;
  try {
    const clusterId = processCleanupDialog.dataset.cluster;
    const response = await fetch(`/api/${clusterId}/process-instances/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmation: processCleanupConfirmation.value,
        expectedRootCount: Number(processCleanupDialog.dataset.rootCount),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Cleanup konnte nicht gestartet werden.');
    processCleanupDialog.close();
    renderCleanupStatus(result);
    pollCleanupStatus();
  } catch (error) {
    processCleanupDialogError.textContent = error.message;
    processCleanupDialogError.hidden = false;
    processCleanupCancel.disabled = false;
    processCleanupConfirm.disabled = false;
  }
}

function renderProcessInstances(rows, metadata) {
  const columns = [
    ['key', 'Instanz-Key'],
    ['bpmnProcessId', 'Prozess'],
    ['processVersion', 'Version'],
    ['startDate', 'Gestartet'],
    ['state', 'Status'],
    ['incident', 'Incident'],
    ['processDefinitionKey', 'Definitions-Key'],
    ['tenantId', 'Tenant'],
  ];
  const total = Number(metadata.total) || rows.length;
  document.querySelector('#count').textContent = `${rows.length} von ${total} Instanzen`;
  if (!rows.length) {
    content.innerHTML = '<div class="empty">Keine Prozessinstanzen vorhanden.</div>';
    return;
  }
  const displayValue = (instance, key) => {
    if (key === 'startDate') return formatDate(instance[key]);
    if (key === 'incident') return instance[key] ? 'Ja' : 'Nein';
    return value(instance[key]);
  };
  const note = metadata.limited ? `<p class="activity-results">Es werden die neuesten ${rows.length} von ${total} Instanzen angezeigt.</p>` : '';
  content.innerHTML = `<div class="process-actions"><span>Cleanup wirkt auf einen bestätigten Snapshot aller Root-Instanzen.</span><button id="start-process-cleanup" class="danger" type="button">Clean Prozessinstanzen</button></div><div id="process-cleanup-status"></div>${note}<div class="table-wrap"><table class="process-table"><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map((instance) => `<tr>${columns.map(([key]) => `<td title="${escapeHtml(displayValue(instance, key))}">${escapeHtml(displayValue(instance, key))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  document.querySelector('#start-process-cleanup').addEventListener('click', openProcessCleanupDialog);
  pollCleanupStatus();
}

function renderDefinitionCleanupStatus(status) {
  const host = document.querySelector('#definition-cleanup-status');
  const button = document.querySelector('#start-definition-cleanup');
  if (!host || !button) return;
  const running = status.status === 'running';
  button.disabled = running;
  if (status.status === 'idle') {
    host.innerHTML = '';
    return;
  }
  const details = `Bearbeitet: ${status.processed || 0}/${status.total || 0} · Gelöscht: ${status.deleted || 0} · Bereits entfernt: ${status.alreadyMissing || 0} · Fehler: ${status.failed || 0}`;
  const errors = status.errors?.length ? `<div class="cleanup-errors">${status.errors.map(escapeHtml).join('<br>')}</div>` : '';
  host.innerHTML = `<div class="cleanup-status ${escapeHtml(status.status)}"><strong>${escapeHtml(status.phaseLabel || status.status)}</strong><span>${escapeHtml(details)}</span>${errors}</div>`;
}

async function pollDefinitionCleanupStatus() {
  clearTimeout(definitionCleanupPollTimer);
  try {
    const response = await fetch(`/api/${state.cluster}/definitions/cleanup`);
    const status = await response.json();
    renderDefinitionCleanupStatus(status);
    if (status.status === 'running') definitionCleanupPollTimer = setTimeout(pollDefinitionCleanupStatus, 1000);
  } catch (error) {
    renderDefinitionCleanupStatus({ status: 'failed', phaseLabel: error.message, failed: 1, errors: [] });
  }
}

async function openDefinitionCleanupDialog() {
  definitionCleanupDialogError.hidden = true;
  definitionCleanupSummary.textContent = 'Cleanup-Vorschau wird geladen …';
  definitionCleanupConfirmation.value = '';
  definitionCleanupConfirm.disabled = true;
  definitionCleanupDialog.showModal();
  try {
    const clusterId = state.cluster;
    const response = await fetch(`/api/${clusterId}/definitions/cleanup-preview`);
    const preview = await response.json();
    if (!response.ok) throw new Error(preview.error || 'Definitions-Vorschau konnte nicht geladen werden.');
    definitionCleanupDialog.dataset.cluster = clusterId;
    definitionCleanupDialog.dataset.confirmation = preview.confirmation;
    definitionCleanupDialog.dataset.count = String(preview.total);
    const activeWarning = preview.activeInstances
      ? `<br><strong>Der Cleanup ist noch gesperrt, weil ${preview.activeInstances} Prozessinstanzen aktiv sind.</strong>`
      : '';
    definitionCleanupSummary.innerHTML = `Es werden <strong>${preview.processCount} deployte Prozessversionen</strong> und <strong>${preview.drdCount} DMN-DRGs</strong> endgültig aus Zeebe gelöscht.${activeWarning}<br><small>Der Cluster läuft auf ${escapeHtml(preview.clusterVersion)}. Diese Version bietet keine API zum vollständigen Auflisten deployter Formulare; Formulare sind deshalb nicht Bestandteil dieses Löschlaufs.</small><br><br>Gib <strong>${escapeHtml(preview.confirmation)}</strong> ein:`;
    definitionCleanupConfirmation.focus();
  } catch (error) {
    definitionCleanupDialogError.textContent = error.message;
    definitionCleanupDialogError.hidden = false;
  }
}

async function startDefinitionCleanup() {
  definitionCleanupConfirm.disabled = true;
  definitionCleanupCancel.disabled = true;
  definitionCleanupDialogError.hidden = true;
  try {
    const clusterId = definitionCleanupDialog.dataset.cluster;
    const response = await fetch(`/api/${clusterId}/definitions/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmation: definitionCleanupConfirmation.value,
        expectedCount: Number(definitionCleanupDialog.dataset.count),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Definitions-Cleanup konnte nicht gestartet werden.');
    definitionCleanupDialog.close();
    renderDefinitionCleanupStatus(result);
    pollDefinitionCleanupStatus();
  } catch (error) {
    definitionCleanupDialogError.textContent = error.message;
    definitionCleanupDialogError.hidden = false;
    definitionCleanupCancel.disabled = false;
    definitionCleanupConfirm.disabled = false;
  }
}

function renderDefinitions(rows, metadata) {
  const columns = [
    ['type', 'Typ'],
    ['name', 'Name'],
    ['id', 'ID'],
    ['version', 'Version'],
    ['key', 'Definitions-Key'],
    ['tenantId', 'Tenant'],
  ];
  document.querySelector('#count').textContent = `${metadata.processCount || 0} Prozesse · ${metadata.drdCount || 0} DMNs`;
  const formWarning = metadata.formsSupported ? '' : `<div class="definition-warning"><strong>Formulare:</strong> Camunda ${escapeHtml(metadata.clusterVersion || '8.7')} bietet keine API, um alle deployten Formulare aufzulisten. Sie können mit diesem Lauf nicht garantiert gelöscht werden.</div>`;
  const table = rows.length
    ? `<div class="table-wrap"><table><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map(([key]) => `<td title="${escapeHtml(value(row[key]))}">${escapeHtml(value(row[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">Keine Prozess- oder DMN-Definitionen vorhanden.</div>';
  content.innerHTML = `<div class="process-actions"><span>Löscht alle deployten Prozessversionen und DMN-DRGs aus dem Cluster.</span><button id="start-definition-cleanup" class="danger" type="button">Clean Definitionen</button></div><div id="definition-cleanup-status"></div>${formWarning}${table}`;
  document.querySelector('#start-definition-cleanup').addEventListener('click', openDefinitionCleanupDialog);
  pollDefinitionCleanupStatus();
}

function clusterReadyStatus(cluster) {
  return cluster.status?.ready || cluster.status || 'Unbekannt';
}

function openClusterDeleteDialog(clusterUuid, clusterName) {
  const confirmation = `DELETE CLUSTER ${clusterName}`;
  clusterDeleteDialog.dataset.clusterUuid = clusterUuid;
  clusterDeleteDialog.dataset.confirmation = confirmation;
  clusterDeleteConfirmation.value = '';
  clusterDeleteConfirm.disabled = true;
  clusterDeleteError.hidden = true;
  clusterDeleteSummary.innerHTML = `Der Cluster <strong>${escapeHtml(clusterName)}</strong> und sämtliche deployten Definitionen, Instanzen und Laufzeitdaten werden unwiderruflich gelöscht.<br><br>Gib <strong>${escapeHtml(confirmation)}</strong> ein:`;
  clusterDeleteDialog.showModal();
  clusterDeleteConfirmation.focus();
}

async function startClusterDeletion() {
  clusterDeleteConfirm.disabled = true;
  clusterDeleteCancel.disabled = true;
  clusterDeleteConfirm.textContent = 'Cluster wird gelöscht …';
  clusterDeleteError.hidden = true;
  try {
    const response = await fetch(`/api/${state.cluster}/clusters/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clusterUuid: clusterDeleteDialog.dataset.clusterUuid,
        confirmation: clusterDeleteConfirmation.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Cluster konnte nicht gelöscht werden.');
    clusterDeleteDialog.close();
    showNotice(`Cluster ${result.name} wurde zur endgültigen Löschung übergeben.`, 'success');
    setTimeout(load, 1000);
  } catch (error) {
    clusterDeleteError.textContent = error.message;
    clusterDeleteError.hidden = false;
    clusterDeleteCancel.disabled = false;
    clusterDeleteConfirm.disabled = false;
    clusterDeleteConfirm.textContent = 'Cluster endgültig löschen';
  }
}

function renderClusterManagement(rows, metadata) {
  const parameters = metadata.parameters || {};
  const channels = parameters.channels || [];
  const plans = parameters.clusterPlanTypes || [];
  const regions = parameters.regions || [];
  const current = rows[0];
  const stableChannel = channels.find((channel) => channel.name === 'Stable') || channels[0];
  const initialGenerations = (stableChannel?.allowedGenerations || []).filter((generation) => generation.classification !== 'existingCluster');
  const defaultGenerationId = stableChannel?.defaultGeneration?.uuid || initialGenerations.at(-1)?.uuid;
  const defaultRegionId = regions.find((region) => region.name.includes('(europe-west1)'))?.uuid || regions[0]?.uuid;
  const secretRows = (metadata.envSecrets || []).map((secret) => `<li><code>${escapeHtml(secret.name)}</code><span class="secret-state ${secret.configured ? 'configured' : ''}">${secret.configured ? 'Wert vorhanden' : 'Wert fehlt'}</span></li>`).join('');
  const clusterRows = rows.map((cluster) => `<tr><td>${escapeHtml(cluster.name)}</td><td>${escapeHtml(cluster.generation?.name || '–')}</td><td>${escapeHtml(cluster.region?.name || '–')}</td><td>${escapeHtml(clusterReadyStatus(cluster))}</td><td>${escapeHtml((cluster.labels || []).join(', ') || '–')}</td><td class="cluster-actions"><button class="sync-cluster-secrets" type="button" data-cluster-id="${escapeHtml(cluster.uuid)}">Secrets aus .env</button><button class="danger delete-cluster" type="button" data-cluster-id="${escapeHtml(cluster.uuid)}" data-cluster-name="${escapeHtml(cluster.name)}">Cluster löschen</button></td></tr>`).join('');
  document.querySelector('#count').textContent = `${rows.length} Cluster`;
  content.innerHTML = `<section class="cluster-section"><h3>Vorhandene Cluster</h3>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Version</th><th>Region</th><th>Status</th><th>Tag</th><th>Aktionen</th></tr></thead><tbody>${clusterRows}</tbody></table></div>` : '<div class="empty">Kein Cluster vorhanden. Du kannst jetzt einen neuen anlegen.</div>'}</section><section class="cluster-section"><h3>Neuen Cluster anlegen</h3><form id="cluster-create-form" class="cluster-create-form"><label>Name<input name="name" required maxlength="100" value="${escapeHtml(current?.name || 'GPMPM Workflows')}"></label><label>Beschreibung<input name="description" maxlength="150" value="Cluster für die Workflows an der HSW im Modul Geschäftsprozess- &amp; Projektmanagement"></label><label>Plan<select name="planTypeId" required>${plans.map((plan) => `<option value="${escapeHtml(plan.uuid)}">${escapeHtml(plan.name)}</option>`).join('')}</select></label><label>Channel<select name="channelId" required>${channels.map((channel) => `<option value="${escapeHtml(channel.uuid)}" ${channel.uuid === stableChannel?.uuid ? 'selected' : ''}>${escapeHtml(channel.name)}</option>`).join('')}</select></label><label>Version<select name="generationId" required>${initialGenerations.map((generation) => `<option value="${escapeHtml(generation.uuid)}" ${generation.uuid === defaultGenerationId ? 'selected' : ''}>${escapeHtml(generation.name)}</option>`).join('')}</select></label><label>Region<select name="regionId" required>${regions.map((region) => `<option value="${escapeHtml(region.uuid)}" ${region.uuid === defaultRegionId ? 'selected' : ''}>${escapeHtml(region.name)}</option>`).join('')}</select></label><label>Umgebung<select name="stageLabel"><option value="dev">Development</option><option value="test">Test</option><option value="stage">Stage</option><option value="prod">Production</option></select></label><label class="cluster-checkbox"><input name="autoUpdate" type="checkbox"> Automatische Updates</label><label class="cluster-confirmation">Zum Anlegen <strong>CREATE CLUSTER</strong> eingeben<input name="confirmation" required autocomplete="off"></label><button class="danger" type="submit">Cluster anlegen</button></form></section><section class="cluster-section"><h3>Connector-Secrets aus .env</h3><p>Secret-Werte bleiben ausschließlich auf diesem Rechner und werden nicht im Browser angezeigt.</p><ul class="secret-list">${secretRows || '<li>Keine Variablen in .env gefunden.</li>'}</ul></section>`;

  const createForm = document.querySelector('#cluster-create-form');
  const channelSelect = createForm.elements.channelId;
  const generationSelect = createForm.elements.generationId;
  channelSelect.addEventListener('change', () => {
    const channel = channels.find((item) => item.uuid === channelSelect.value);
    const generations = (channel?.allowedGenerations || []).filter((generation) => generation.classification !== 'existingCluster');
    generationSelect.innerHTML = generations.map((generation) => `<option value="${escapeHtml(generation.uuid)}" ${generation.uuid === channel?.defaultGeneration?.uuid ? 'selected' : ''}>${escapeHtml(generation.name)}</option>`).join('');
  });
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = createForm.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Cluster wird angelegt …';
    try {
      const form = new FormData(createForm);
      const response = await fetch(`/api/${state.cluster}/clusters/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'), description: form.get('description'), planTypeId: form.get('planTypeId'),
          channelId: form.get('channelId'), generationId: form.get('generationId'), regionId: form.get('regionId'),
          stageLabel: form.get('stageLabel'), autoUpdate: form.get('autoUpdate') === 'on', confirmation: form.get('confirmation'),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Cluster konnte nicht angelegt werden.');
      showNotice(`Neuer Cluster ${result.clusterId} wird angelegt.`, 'success');
      setTimeout(load, 1000);
    } catch (error) {
      showNotice(error.message);
      button.disabled = false;
      button.textContent = 'Cluster anlegen';
    }
  });
  document.querySelectorAll('.delete-cluster').forEach((button) => button.addEventListener('click', () => openClusterDeleteDialog(button.dataset.clusterId, button.dataset.clusterName)));
  document.querySelectorAll('.sync-cluster-secrets').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Secrets werden angelegt …';
    try {
      const response = await fetch(`/api/${state.cluster}/clusters/${encodeURIComponent(button.dataset.clusterId)}/sync-secrets`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Secrets konnten nicht angelegt werden.');
      const message = `${result.created.length} Secrets angelegt, ${result.skipped.length} bereits vorhanden, ${result.failed.length} fehlgeschlagen.`;
      showNotice(result.failed.length ? `${message} ${result.failed.map((item) => item.error).join(' | ')}` : message, result.failed.length ? '' : 'success');
    } catch (error) {
      showNotice(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Secrets aus .env';
    }
  }));
}

function renderData(data, metadata = {}) {
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
  if (state.resource === 'projects') {
    renderProjects(rows);
    return;
  }
  if (state.resource === 'clusters') {
    renderClusterManagement(rows, metadata);
    return;
  }
  if (state.resource === 'process-instances') {
    renderProcessInstances(rows, metadata);
    return;
  }
  if (state.resource === 'definitions') {
    renderDefinitions(rows, metadata);
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
    renderData(result.data, result);
  } catch (error) {
    content.className = 'empty';
    content.textContent = 'Es liegen derzeit keine anzeigbaren Daten vor.';
    showNotice(error.message);
  }
}

processCleanupConfirmation.addEventListener('input', () => {
  processCleanupConfirm.disabled = processCleanupConfirmation.value !== processCleanupDialog.dataset.confirmation;
});
processCleanupCancel.addEventListener('click', () => processCleanupDialog.close());
processCleanupConfirm.addEventListener('click', startProcessCleanup);
processCleanupDialog.addEventListener('close', () => {
  processCleanupCancel.disabled = false;
  processCleanupConfirm.disabled = true;
});
definitionCleanupConfirmation.addEventListener('input', () => {
  definitionCleanupConfirm.disabled = definitionCleanupConfirmation.value !== definitionCleanupDialog.dataset.confirmation;
});
definitionCleanupCancel.addEventListener('click', () => definitionCleanupDialog.close());
definitionCleanupConfirm.addEventListener('click', startDefinitionCleanup);
definitionCleanupDialog.addEventListener('close', () => {
  definitionCleanupCancel.disabled = false;
  definitionCleanupConfirm.disabled = true;
});
projectDeleteConfirmation.addEventListener('input', () => {
  projectDeleteConfirm.disabled = projectDeleteConfirmation.value !== projectDeleteDialog.dataset.confirmation;
});
projectDeleteCancel.addEventListener('click', () => projectDeleteDialog.close());
projectDeleteConfirm.addEventListener('click', () => {
  if (projectDeletionFinished) projectDeleteDialog.close();
  else startProjectDeletion();
});
projectDeleteDialog.addEventListener('cancel', (event) => {
  if (projectDeleteCancel.disabled) event.preventDefault();
});
projectDeleteDialog.addEventListener('close', () => {
  clearTimeout(projectDeletionPollTimer);
  projectDeletionFinished = false;
  projectDeleteConfirmation.disabled = false;
  projectDeleteCancel.disabled = false;
  projectDeleteCancel.textContent = 'Abbrechen';
  projectDeleteConfirm.disabled = true;
  projectDeleteConfirm.textContent = 'Ausgewählte Projekte löschen';
  projectDeleteProgress.hidden = true;
  projectDeleteProgress.innerHTML = '';
});
clusterDeleteConfirmation.addEventListener('input', () => {
  clusterDeleteConfirm.disabled = clusterDeleteConfirmation.value !== clusterDeleteDialog.dataset.confirmation;
});
clusterDeleteCancel.addEventListener('click', () => clusterDeleteDialog.close());
clusterDeleteConfirm.addEventListener('click', startClusterDeletion);
clusterDeleteDialog.addEventListener('close', () => {
  clusterDeleteCancel.disabled = false;
  clusterDeleteConfirm.disabled = true;
  clusterDeleteConfirm.textContent = 'Cluster endgültig löschen';
});
document.querySelector('#refresh').addEventListener('click', load);
renderNavigation();
load();
