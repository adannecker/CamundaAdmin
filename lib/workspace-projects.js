const { searchAll } = require('./onboarding');
const PROJECT_NAMES = Object.freeze(['Projektarbeit 1', 'Projektarbeit 2']);

async function readProjects(api, workspaceKey) {
  const projects = await searchAll(api, '/projects/search', { workspaceKey: { $eq: workspaceKey } });
  if (projects.some(p => !p.projectKey || p.workspaceKey !== workspaceKey)) throw new Error('Projekte gehören nicht eindeutig zum Gruppen-Workspace.');
  for (const name of PROJECT_NAMES) if (projects.filter(p => p.name === name).length > 1) throw new Error('Projekt „' + name + '“ ist mehrfach vorhanden. Bitte manuell prüfen.');
  return projects;
}

async function ensureProjects({ api, group, save, write, verify }) {
  const result = [];
  for (const name of PROJECT_NAMES) {
    let project = (await readProjects(api, group.workspaceKey)).find(p => p.name === name);
    if (!project) {
      if (group.projectCreateAttempts?.[name]) throw new Error('Projektanlage „' + name + '“ ist noch unbestätigt. Keine erneute Anlage; Bestand zuerst prüfen.');
      group.projectCreateAttempts ||= {};
      group.projectCreateAttempts[name] = { status: 'reserved', at: new Date().toISOString() }; save();
      project = await write('Projekt „' + name + '“ anlegen', () => api.hub('/projects', { method: 'POST', body: { name, workspaceKey: group.workspaceKey } }));
      if (!project?.projectKey || project.workspaceKey !== group.workspaceKey || project.name !== name) throw new Error('Projektanlage nicht eindeutig bestätigt.');
      group.projectCreateAttempts[name] = { ...group.projectCreateAttempts[name], status: 'submitted', projectKey: project.projectKey }; save();
      if (!await verify(async () => (await readProjects(api, group.workspaceKey)).some(p => p.name === name && p.projectKey === project.projectKey))) throw new Error('Projekt „' + name + '“ noch nicht lesend bestätigt.');
    }
    result.push({ name, projectKey: project.projectKey });
  }
  group.projects = result;
  for (const project of result) if (group.projectCreateAttempts?.[project.name]) group.projectCreateAttempts[project.name].status = 'verified';
  save();
  return result;
}
module.exports = { PROJECT_NAMES, readProjects, ensureProjects };
