const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readExcel, analyzeRoster, extractRoster, pythonExecutable } = require('../lib/roster-import');

const workbook = { sheets: [{ name: 'Klasse', rows: [
  { row: 1, cells: ['Vorname', 'Nachname', 'E-Mail', 'Gruppe'] },
  { row: 2, cells: ['Ada', 'Example', 'ada@example.org', 'Gruppe 1'] },
  { row: 3, cells: ['Ben', 'Example', 'ben@example.org', ''] },
  { row: 4, cells: ['Cy', 'Example', 'cy@example.org', 'Gruppe 2'] },
] }] };
const mapping = { mappings: [{ sheetIndex: 0, headerRow: 1, emailColumn: 2, fullNameColumn: null, firstNameColumn: 0, lastNameColumn: 1, groupColumn: 3 }], warnings: [] };
const analysis = { ...mapping, students: [
  { sheetIndex: 0, row: 2, name: 'Ada Example', email: 'ada@example.org', group: 'Gruppe 1' },
  { sheetIndex: 0, row: 3, name: 'Ben Example', email: 'ben@example.org', group: 'Gruppe 1' },
  { sheetIndex: 0, row: 4, name: 'Cy Example', email: 'cy@example.org', group: 'Gruppe 2' },
] };
const response = data => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] }) });
test('roster extraction preserves source emails, detects blank groups and never invents addresses', () => {
  const r = extractRoster(workbook, mapping); assert.equal(r.students.length, 3); assert.equal(r.students[0].name, 'Ada Example'); assert.equal(r.students[1].group, 'Gruppe 1'); assert.ok(r.warnings.some(w => w.includes('vorheriger Zeile')));
  const missing = structuredClone(workbook); missing.sheets[0].rows[1].cells[2] = ''; assert.equal(extractRoster(missing, mapping).students.length, 2);
});
test('ambiguous duplicate emails and hallucinated mapping coordinates are rejected', () => {
  const copy = structuredClone(workbook); copy.sheets[0].rows[3].cells[2] = 'ada@example.org'; assert.throws(() => extractRoster(copy, mapping), /mehreren Gruppen/);
  for (const change of [m => { m.mappings[0].sheetIndex = 5; }, m => { m.mappings[0].emailColumn = 100; }, m => { m.mappings[0].headerRow = 99; }]) { const m = structuredClone(mapping); change(m); assert.throws(() => extractRoster(workbook, m)); }
});
test('OpenAI call requests a strict roster JSON and validates every returned student against source cells', async () => {
  let request;
  const result = await analyzeRoster(workbook, { config: { apiKey: 'test-key', model: 'test-model' }, fetchImpl: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return response(analysis); } });
  assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(request.body.store, false); assert.equal(request.body.text.format.strict, true); assert.equal(result.students.length, 3); assert.ok(!request.body.input.includes('test-key'));
  assert.equal(result.structuredRoster.groups.length, 2); assert.equal(result.transmittedRows, 4); assert.equal(result.transmittedSheets, 1);
  await assert.rejects(analyzeRoster(workbook, { config: { apiKey: 'test-key', model: 'test-model' }, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ apiKey: 'test-key' }) }) }), /HTTP 401/);
});

test('full workbook transmission includes later rows, extra sheets and long cells without sampling', async () => {
  const full = structuredClone(workbook);
  full.sheets[0].rows.push({ row: 200, cells: ['x'.repeat(900), 'later@example.org'] });
  full.sheets.push({ name: 'Weiteres Blatt', rows: [{ row: 1, cells: ['Auch dieser Inhalt'] }] });
  await assert.rejects(analyzeRoster(full, { config: { apiKey: 'key', model: 'model' }, fetchImpl: async (url, options) => {
    assert.deepEqual(JSON.parse(options.body).input, JSON.stringify(full.sheets.map((s, sheetIndex) => ({ sheetIndex, ...s }))));
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }) };
  } }), /abgelehnt/);
  await assert.rejects(analyzeRoster({ sheets: [{ name: 'Gross', rows: [{ row: 1, cells: ['x'.repeat(500001)] }] }] }, { config: {}, fetchImpl: async () => assert.fail('No truncated request') }), /nichts an OpenAI/);
});

test('invented names, groups, emails, sources and missing people reject the entire AI result', async () => {
  for (const change of [a => a.students.pop(), a => a.students[0].name = 'Erfunden', a => a.students[0].email = 'invented@example.org', a => a.students[0].group = 'Admin', a => a.students[0].row = 99, a => a.students[0].sheetIndex = 99, a => a.students[1] = a.students[0]]) {
    const modified = structuredClone(analysis); change(modified);
    await assert.rejects(analyzeRoster(workbook, { config: { apiKey: 'key', model: 'model' }, fetchImpl: async () => response(modified) }), /KI-/);
  }
});
test('bounded XLSX reader extracts Unicode text and rejects dangerous XML and unsupported files', async t => {
  assert.equal(pythonExecutable({ filename: 'does-not-exist.env', env: { PYTHON_BIN: 'configured-python' } }), 'configured-python');
  const python = pythonExecutable(), check = spawnSync(python, ['--version'], { windowsHide: true }); if (check.status !== 0) return t.skip('Python 3 nicht installiert.');
  const make = files => { const result = spawnSync(python, ['-c', "import sys,json,io,zipfile,base64\nf=json.loads(sys.stdin.buffer.read().decode('utf-8')); b=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n for k,v in f.items(): z.writestr(k,v)\nprint(base64.b64encode(b.getvalue()).decode())"], { input: JSON.stringify(files), encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0); return result.stdout.trim(); };
  const files = {
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Klasse" sheetId="1" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>E-Mail</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>test@example.org</t></is></c><c r="B2" t="inlineStr"><is><t>Änne</t></is></c></row></sheetData></worksheet>',
  };
  const result = await readExcel(make(files), 'liste.xlsx'); assert.equal(result.sheets[0].rows[1].cells[1], 'Änne');
  await assert.rejects(readExcel(make({ ...files, 'xl/worksheets/sheet1.xml': '<!DOCTYPE x [<!ENTITY x "xx">]><x/>' }), 'liste.xlsx'), /Entitäten/);
  await assert.rejects(readExcel(make(files), 'liste.xls'), /xlsx/);
});
