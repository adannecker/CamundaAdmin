const test = require('node:test');
const assert = require('node:assert/strict');
const { compareAdminSite } = require('../public/admin');
const person = { email: 'teacher@example.org', sites: { basel: true, brugg: false, olten: false } };
const source = roles => ({ ok: true, members: [{ email: person.email, roles }] });

test('a missing server account is highlighted without clearing its configured site', () => {
 const before = structuredClone(person);
 assert.equal(compareAdminSite(person,'basel',{ok:true,members:[]},true).label,'Fehlt im System');
 assert.deepEqual(person,before);
 assert.equal(person.sites.basel,true);
});
test('extra roles are marked only when the configured policy removes them', () => {
 assert.equal(compareAdminSite(person,'basel',source(['admin','analyst']),true).label,'Zusätzliche Rollen');
 assert.equal(compareAdminSite(person,'basel',source(['admin','analyst']),false).kind,'match');
 assert.equal(compareAdminSite(person,'basel',source(['modeler']),true).label,'Adminrolle fehlt');
});
test('an unchecked configured site stays unchecked even if the server grants admin', () => {
 const result=compareAdminSite(person,'brugg',source(['admin']),true);
 assert.equal(result.different,true);
 assert.equal(result.label,'Admin im System · nicht verwaltet');
 assert.equal(person.sites.brugg,false);
});
test('unknown server state is never marked as a missing account', () => {
 assert.equal(compareAdminSite(person,'basel',{ok:false,members:null},true).kind,'unknown');
 assert.equal(compareAdminSite(person,'basel',undefined,true).kind,'unread');
});
test('owner comparison retains protection and marks unexpected owner loss for review', () => {
 const owner={...person,owner:true};
 assert.equal(compareAdminSite(owner,'basel',source(['owner','admin']),true).kind,'protected');
 assert.equal(compareAdminSite(owner,'basel',source(['admin']),true).different,true);
});
