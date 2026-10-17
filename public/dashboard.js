const cards = document.querySelector('#cards');
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let checking = false;
async function checkLive() {
 if(checking) return; checking=true; document.querySelector('#refresh').disabled=true;
 cards.innerHTML=['Basel','Brugg','Olten'].map(name=>'<article class="card" id="card-'+name.toLowerCase()+'"><h3>'+name+'</h3><p role="status">Verbindung wird geprüft …</p></article>').join('');
 await Promise.all(['basel','brugg','olten'].map(async id=>{
 const card=document.querySelector('#card-'+id);
 try { const response=await fetch('/api/'+id+'/live',{signal:AbortSignal.timeout(55000)}); if(!response.ok) throw new Error('HTTP '+response.status); const result=await response.json();
 card.innerHTML='<h3>'+id[0].toUpperCase()+id.slice(1)+'</h3><span class="badge '+(result.ok?'ok':'bad')+'">'+(result.ok?'Console erreichbar':'Zugriff fehlgeschlagen')+'</span><p class="muted">'+escapeHtml(result.error||'Authentifizierung und Clusterabfrage erfolgreich.')+'</p>'+(result.runtime?'<p><strong>Runtime:</strong> '+escapeHtml(result.runtime.message)+'</p>':'')+(result.clusters||[]).map(c=>'<div class="muted"><strong>'+escapeHtml(c.name)+'</strong><br>'+escapeHtml(c.status)+' · '+escapeHtml(c.version)+' · '+escapeHtml(c.region)+'</div>').join('')+'<p class="muted">Geprüft: '+new Date(result.checkedAt).toLocaleString('de-CH')+'</p>';
 } catch(error){card.innerHTML='<h3>'+escapeHtml(id)+'</h3><span class="badge bad">Prüfung fehlgeschlagen</span><p>'+escapeHtml(error.message)+'</p>';}
 })); checking=false;document.querySelector('#refresh').disabled=false;
}
document.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>{const live=button.dataset.section==='live';document.querySelector('#live').hidden=!live;document.querySelector('#students').hidden=live;document.querySelector('#title').textContent=button.textContent;document.querySelector('#refresh').hidden=!live;document.querySelectorAll('[data-section]').forEach(b=>b.classList.toggle('active',b===button));}));
document.querySelector('#refresh').addEventListener('click',checkLive);
document.querySelector('#validate').addEventListener('click',()=>{const entries=document.querySelector('#emails').value.split(/[;\r\n]+/).map(s=>s.trim()).filter(Boolean);const unique=[...new Set(entries.map(s=>s.toLowerCase()))];const invalid=unique.filter(s=>! /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(s));document.querySelector('#preview').textContent=entries.length ? unique.length+' eindeutige Adressen für '+document.querySelector('#org').value+'. '+(entries.length-unique.length)+' Duplikate entfernt. '+(invalid.length?'Ungültig: '+invalid.join('; '):'Alle Adressen sind formal gültig. Noch keine Einladungen versendet.'):'Bitte mindestens eine E-Mail-Adresse eingeben.';});
checkLive();
