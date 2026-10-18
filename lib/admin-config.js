const fs = require('node:fs');
const crypto = require('node:crypto');

const SITE_IDS = ['basel', 'brugg', 'olten'];
const fail = message => { throw new Error(message); };
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('Unerwartete Felder in der Dozenten-Konfiguration.');
}
function person(value) {
  exactKeys(value, ['email', 'name', 'sites']);
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
  if (!/^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(email) || email.length > 254) fail('Ungültige Dozenten-E-Mail-Adresse.');
  if (typeof value.name !== 'string' || value.name.length > 200) fail('Ungültiger Dozentenname.');
  exactKeys(value.sites, SITE_IDS);
  if (SITE_IDS.some(site => typeof value.sites[site] !== 'boolean')) fail('Standortauswahl muss aus Checkbox-Werten bestehen.');
  return { email, name: value.name.trim(), sites: Object.fromEntries(SITE_IDS.map(site => [site, value.sites[site]])) };
}

function validateAdminConfig(input, current) {
  exactKeys(input, ['schemaVersion', 'organizations', 'organizationRole', 'removeOtherOrganizationRoles', 'unselectedSites', 'protectedOwners', 'lecturers']);
  if (input.schemaVersion !== 1 || input.organizationRole !== 'admin' || input.unselectedSites !== 'leave_unchanged' || typeof input.removeOtherOrganizationRoles !== 'boolean') fail('Ungültige Rollenrichtlinie.');
  exactKeys(input.organizations, SITE_IDS);
  if (SITE_IDS.some(site => !/^[a-f0-9-]{36}$/.test(input.organizations[site]))) fail('Ungültige Organisations-ID.');
  if (!Array.isArray(input.protectedOwners) || !input.protectedOwners.length || !Array.isArray(input.lecturers) || input.lecturers.length > 50) fail('Owner oder Dozentenliste ist ungültig (maximal 50 Dozenten).');
  const protectedOwners = input.protectedOwners.map(person).sort((a, b) => a.email.localeCompare(b.email));
  const lecturers = input.lecturers.map(person).sort((a, b) => a.email.localeCompare(b.email));
  const emails = [...protectedOwners, ...lecturers].map(p => p.email);
  if (new Set(emails).size !== emails.length) fail('Doppelte E-Mail-Adresse oder Owner als bearbeitbarer Dozent.');
  const result = { schemaVersion: 1, organizations: Object.fromEntries(SITE_IDS.map(site => [site, input.organizations[site]])), organizationRole: 'admin', removeOtherOrganizationRoles: input.removeOtherOrganizationRoles, unselectedSites: 'leave_unchanged', protectedOwners, lecturers };
  if (current && (JSON.stringify(result.protectedOwners) !== JSON.stringify(current.protectedOwners) || JSON.stringify(result.organizations) !== JSON.stringify(current.organizations))) fail('Owner und Organisations-IDs sind im Adminbereich nicht bearbeitbar.');
  return result;
}

function loadAdminConfig(filename) {
  const raw = fs.readFileSync(filename, 'utf8');
  return { config: validateAdminConfig(JSON.parse(raw.replace(/^\uFEFF/, ''))), revision: crypto.createHash('sha256').update(raw).digest('hex') };
}

function saveAdminConfig(filename, input, expectedRevision) {
  const current = loadAdminConfig(filename);
  if (typeof expectedRevision !== 'string' || expectedRevision !== current.revision) fail('Konfiguration wurde zwischenzeitlich geändert. Bitte neu laden.');
  const config = validateAdminConfig(input, current.config);
  const temporary = filename + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } catch (error) {
    if (error.code !== 'EEXIST') try { fs.unlinkSync(temporary); } catch {}
    throw new Error(`Konfiguration konnte nicht gespeichert werden (${error.code || 'Dateifehler'}).`);
  }
  return loadAdminConfig(filename);
}

async function readAdminInventory(config, apiForSite) {
  const entries = await Promise.all(SITE_IDS.map(async site => {
    try {
      const api = apiForSite(site);
      const info = await api.hub('/info');
      if (info.authorizedOrganization !== config.organizations[site]) fail('Credentials gehören nicht zur konfigurierten Organisation.');
      const members = await api.console('/members');
      if (!Array.isArray(members)) fail('Unerwartete Mitgliederantwort.');
      return [site, { ok: true, members: members.map(m => ({ email: String(m.email || '').toLowerCase(), name: m.name || '', roles: Array.isArray(m.roles) ? m.roles : [], pending: Boolean(m.invitePending) })) }];
    } catch (error) { return [site, { ok: false, error: error.message, members: null }]; }
  }));
  return { checkedAt: new Date().toISOString(), sites: Object.fromEntries(entries) };
}

function adminRolePreview(config, inventory) {
  return [...config.protectedOwners.map(p => ({ ...p, protected: true })), ...config.lecturers].flatMap(p => SITE_IDS.map(site => {
    const source = inventory.sites[site];
    const member = source?.ok ? source.members.find(m => m.email === p.email) : null;
    const currentRoles = member ? member.roles : source?.ok ? [] : null;
    const base = { email: p.email, site, currentRoles };
    if (p.protected || member?.roles.includes('owner')) return { ...base, action: 'protected', targetRoles: currentRoles, removeRoles: [] };
    if (!p.sites[site]) return { ...base, action: 'unmanaged', targetRoles: currentRoles, removeRoles: [] };
    if (!source?.ok) return { ...base, action: 'unknown', targetRoles: null, removeRoles: [] };
    const targetRoles = config.removeOtherOrganizationRoles ? ['admin'] : [...new Set([...currentRoles, 'admin'])].sort();
    return { ...base, targetRoles, removeRoles: currentRoles.filter(r => !targetRoles.includes(r)), action: !member ? 'invite' : JSON.stringify([...currentRoles].sort()) === JSON.stringify([...targetRoles].sort()) ? 'unchanged' : 'update' };
  }));
}

function allowLocalConfigWrite(request) {
  const host = request.headers.host || '';
  return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
    && (!request.headers.origin || request.headers.origin === `http://${host}`)
    && (request.headers['content-type'] || '').split(';')[0].trim() === 'application/json';
}

module.exports = { SITE_IDS, validateAdminConfig, loadAdminConfig, saveAdminConfig, readAdminInventory, adminRolePreview, allowLocalConfigWrite };
