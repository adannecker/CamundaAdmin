function compareAdminSite(person, site, source, removeOtherRoles) {
 if(!source)return {kind:'unread',label:'Noch nicht gelesen',different:false};
 if(!source.ok)return {kind:'unknown',label:'Nicht prüfbar',different:false};
 const member=source.members.find(m=>m.email===person.email);
 if(person.owner){
  return member?.roles.includes('owner')?{kind:'protected',label:'Owner geschützt',different:false}:{kind:'different',label:'Owner-Zugriff weicht ab',different:true};
 }
 if(!person.sites[site]){
  return member?.roles.includes('admin')?{kind:'different',label:'Admin im System · nicht verwaltet',different:true}:{kind:'unmanaged',label:'Nicht verwaltet',different:false};
 }
 if(!member)return {kind:'different',label:'Fehlt im System',different:true};
 if(!member.roles.includes('admin'))return {kind:'different',label:'Adminrolle fehlt',different:true};
 if(removeOtherRoles&&member.roles.some(role=>role!=='admin'))return {kind:'different',label:'Zusätzliche Rollen',different:true};
 if(member.pending)return {kind:'pending',label:'Einladung offen',different:true};
 return {kind:'match',label:'Stimmt überein',different:false};
}

if(typeof module==='object'&&module.exports){module.exports={compareAdminSite};}else{
(() => {
 const sites={basel:'Basel',brugg:'Brugg',olten:'Olten'};
 const el=id=>document.getElementById(id);
 const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
 const icons={info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',plus:'<path d="M12 5v14M5 12h14"/>',remove:'<path d="M10 17H5V7h5M14 8l4 4-4 4M8 12h10"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'};
 const icon=name=>'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icons[name]+'</svg>';
 const info=(text,label='Hinweise',kind='')=>'<button type="button" class="admin-info '+kind+'" data-admin-info="'+html(text)+'" aria-label="'+html(label)+'">'+icon('info')+'</button>';
 window.AdminUi={icon,info};
 const tooltip=document.createElement('div');tooltip.id='admin-tooltip';tooltip.className='admin-tooltip';tooltip.setAttribute('role','tooltip');tooltip.hidden=true;document.body.append(tooltip);
 let tooltipTarget=null,tooltipPinned=false;
 function hideInfo(){if(tooltipTarget)tooltipTarget.removeAttribute('aria-describedby');tooltipTarget=null;tooltipPinned=false;tooltip.hidden=true;}
 function showInfo(button,pinned=false){
  if(!button?.dataset.adminInfo)return;hideInfo();tooltipTarget=button;tooltipPinned=pinned;tooltip.textContent=button.dataset.adminInfo;tooltip.hidden=false;button.setAttribute('aria-describedby',tooltip.id);
  const box=button.getBoundingClientRect(),width=tooltip.offsetWidth,height=tooltip.offsetHeight;
  tooltip.style.left=Math.max(12,Math.min(innerWidth-width-12,box.left+box.width/2-width/2))+'px';
  tooltip.style.top=(box.bottom+height+16<innerHeight?box.bottom+8:Math.max(12,box.top-height-8))+'px';
 }
 document.addEventListener('pointerover',event=>{const b=event.target.closest('[data-admin-info]');if(b&&b!==tooltipTarget&&!tooltipPinned)showInfo(b);});
 document.addEventListener('pointerout',event=>{if(!tooltipPinned&&tooltipTarget&&!tooltipTarget.contains(event.relatedTarget)&&!tooltip.contains(event.relatedTarget))hideInfo();});
 document.addEventListener('focusin',event=>{const b=event.target.closest('[data-admin-info]');if(b)showInfo(b);});
 document.addEventListener('focusout',event=>{if(!tooltipPinned&&event.target===tooltipTarget)hideInfo();});
 document.addEventListener('click',event=>{const b=event.target.closest('[data-admin-info]');if(b){if(b===tooltipTarget&&tooltipPinned)hideInfo();else showInfo(b,true);}else if(!tooltip.contains(event.target))hideInfo();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')hideInfo();});
 document.addEventListener('scroll',hideInfo,true);window.addEventListener('resize',hideInfo);
 let config=null,revision=null,inventory=null,preview=[],dirty=false,busy=false,activePlan=null,planExpiryTimer=null;
 const status=text=>{el('admin-status').textContent=text;};
 function controls(){
  el('admin-load').disabled=busy;
  el('admin-read').disabled=busy||!config;
  el('admin-read').setAttribute('aria-busy',String(busy));
  el('admin-save').disabled=busy||!config||!dirty;
  el('admin-export').disabled=busy||!config||dirty;
  el('admin-reconcile').disabled=busy||!config;
  el('admin-reconcile-apply').disabled=busy||!activePlan||!activePlan.changes.length;
  el('admin-reconcile-close').disabled=busy;
  el('admin-remove-other').disabled=busy||!config;
  el('admin-add-button').disabled=busy||!config;
  el('admin-table').querySelectorAll('input[data-lecturer],input[data-name],button[data-remove]').forEach(input=>{input.disabled=busy;});
 }
 function invalidatePlan(){activePlan=null;clearTimeout(planExpiryTimer);}
 function markDirty(){dirty=true;invalidatePlan();controls();document.dispatchEvent(new Event('admin-config-dirty'));el('admin-role-preview').textContent='Ungespeicherte Änderungen. Nach dem Speichern kann die Vorschau für diese Konfiguration gelesen werden.';}
 function currentRoles(email,site){
  const source=inventory?.sites[site];
  if(!source)return 'Noch nicht gelesen';
  if(!source.ok)return 'Nicht ermittelt';
  const member=source.members.find(m=>m.email===email);
  return member?(member.roles.join(', ')+(member.pending?' · Einladung offen':'')):'Noch kein Mitglied';
 }
 function renderTable(){
  const people=[...config.protectedOwners.map(p=>({...p,owner:true})),...config.lecturers.map((p,index)=>({...p,index}))];
  let different=0,unknown=0;
  el('admin-table').innerHTML='<table><thead><tr><th>Dozent / E-Mail</th>'+Object.values(sites).map(s=>'<th class="admin-site">'+s+'</th>').join('')+'<th><span class="sr-only">Lokale Konfiguration</span></th></tr></thead><tbody>'+people.map(p=>'<tr'+(p.owner?' class="owner-row"':'')+'><td>'+(p.owner?'<strong>'+html(p.name||p.email)+'</strong>':'<input type="text" class="admin-name-input" data-name="'+p.index+'" aria-label="'+html('Name für '+p.email)+'" value="'+html(p.name)+'" maxlength="200">')+'<small class="admin-email">'+html(p.email)+'</small>'+(p.owner?'<span class="badge admin-owner-badge">Owner</span>':'')+'</td>'+Object.entries(sites).map(([site,label])=>{
   const comparison=compareAdminSite(p,site,inventory?.sites[site],config.removeOtherOrganizationRoles);
   if(comparison.different)different++;if(comparison.kind==='unknown')unknown++;
   const details='Ist: '+currentRoles(p.email,site)+'\n'+comparison.label+(p.owner?'\nOwner-Konto ist geschützt.':'');
   const memberPresent=Boolean(inventory?.sites[site]?.ok&&inventory.sites[site].members.some(m=>m.email===p.email));
   return '<td class="admin-site'+(comparison.different?' admin-difference':'')+'" data-resource-email="'+html(p.email)+'" data-resource-site="'+site+'" data-org-member="'+memberPresent+'" data-protected-owner="'+Boolean(p.owner)+'"><div class="admin-site-controls"><input type="checkbox" aria-label="'+html(p.email+' · '+label)+'" '+(p.sites[site]?'checked ':'')+(p.owner?'disabled':('data-lecturer="'+p.index+'" data-site="'+site+'"'))+'><span class="admin-role-info" data-role-info="'+html(details)+'">'+info(details,'Details für '+p.email+' in '+label,comparison.kind)+'</span><span class="lecturer-resource-state"></span></div></td>';
  }).join('')+'<td>'+(p.owner?'':'<button type="button" class="admin-icon-button admin-local-remove" data-remove="'+p.index+'" data-admin-info="Nur aus der lokalen Dozentenliste entfernen. Camunda-Mitgliedschaften und Ressourcen bleiben erhalten." aria-label="'+html(p.email+' aus Konfiguration entfernen')+'">'+icon('trash')+'</button>')+'</td></tr>').join('')+'</tbody></table>';
  el('admin-differences').textContent=inventory?(different?different+' Rollenabweichungen':'Keine Rollenabweichungen')+(unknown?' · '+unknown+' nicht prüfbar':''):'';
  controls();
  document.dispatchEvent(new Event('lecturer-resources-render'));
 }
 function renderPreview(){
  if(dirty){el('admin-role-preview').textContent='Vorschau nach dem Speichern aktualisieren.';return;}
  const changes=preview.filter(p=>['invite','update'].includes(p.action));
  el('admin-role-preview').textContent=changes.length?changes.length+' Änderungen geplant · Details unter „Mit Camunda abgleichen …“.':'';
 }
 async function getJson(url,options){const response=await fetch(url,{signal:AbortSignal.timeout(90000),...options});const result=await response.json();if(!response.ok)throw new Error(result.error||'HTTP '+response.status);return result;}
 async function readInventory(prefix='Aktuelle Rollen gelesen.',afterApply=false){
  const result=await getJson('/api/admin/inventory');inventory=result.inventory;preview=result.preview;
  const failures=Object.entries(inventory.sites).filter(([,s])=>!s.ok).map(([site])=>sites[site]);
  renderTable();renderPreview();
  const people=new Map();Object.values(inventory.sites).filter(s=>s.ok).forEach(s=>s.members.forEach(p=>{people.set(p.email,p);}));
  el('admin-known-members').innerHTML=[...people.values()].map(p=>'<option value="'+html(p.email)+'">'+html(p.name)+'</option>').join('');
  status(prefix+(failures.length?' Nicht vollständig: '+failures.join(', '):' Drei Standorte geprüft.'));
  document.dispatchEvent(new Event('lecturer-resources-refresh'));
 }
 async function load(){
  if(busy)return;
  if(dirty&&!window.confirm('Ungespeicherte Änderungen verwerfen und die Konfiguration neu laden?'))return;
  busy=true;invalidatePlan();controls();status('Konfiguration und aktuelle Rollen werden geladen …');
  try{const result=await getJson('/api/admin/config');config=result.config;revision=result.revision;dirty=false;inventory=null;document.dispatchEvent(new Event('admin-config-saved'));el('admin-remove-other').checked=config.removeOtherOrganizationRoles;renderTable();await readInventory('Konfiguration geladen.');}
  catch(error){status(error.message);}
  finally{busy=false;controls();}
 }
 el('admin-load').addEventListener('click',load);
 document.querySelector('[data-section="admin"]').addEventListener('click',()=>{if(!config)load();});
 el('admin-read').addEventListener('click',async()=>{if(busy)return;busy=true;invalidatePlan();controls();status('Organisationsrollen werden lesend geprüft …');try{await readInventory();}catch(error){status(error.message);}finally{busy=false;controls();}});
 el('admin-remove-other').addEventListener('change',()=>{config.removeOtherOrganizationRoles=el('admin-remove-other').checked;renderTable();markDirty();});
 el('admin-table').addEventListener('change',event=>{const input=event.target;if(input.dataset.lecturer!==undefined){config.lecturers[Number(input.dataset.lecturer)].sites[input.dataset.site]=input.checked;renderTable();markDirty();}});
 el('admin-table').addEventListener('input',event=>{const input=event.target;if(input.dataset.name!==undefined){config.lecturers[Number(input.dataset.name)].name=input.value;markDirty();}});
 let pendingLocalRemove=null;
 el('admin-table').addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(!button||busy)return;const person=config.lecturers[Number(button.dataset.remove)];pendingLocalRemove=person.email;el('admin-local-remove-person').textContent=(person.name||person.email)+' · '+person.email;el('admin-local-remove-dialog').showModal();});
 el('admin-local-remove-close').addEventListener('click',()=>{pendingLocalRemove=null;el('admin-local-remove-dialog').close();});
 el('admin-local-remove-dialog').addEventListener('cancel',()=>{pendingLocalRemove=null;});
 el('admin-local-remove-apply').addEventListener('click',()=>{if(busy||!pendingLocalRemove)return;config.lecturers=config.lecturers.filter(p=>p.email!==pendingLocalRemove);pendingLocalRemove=null;el('admin-local-remove-dialog').close();renderTable();markDirty();status('Aus lokalem Entwurf entfernt. Zum Übernehmen Konfiguration speichern.');});
 el('admin-add').addEventListener('submit',event=>{
  event.preventDefault();if(!config||busy)return;
  const email=el('admin-email').value.trim().toLowerCase(),name=el('admin-name').value.trim();
  if([...config.protectedOwners,...config.lecturers].some(p=>p.email===email)){status('Diese E-Mail ist bereits enthalten oder als Owner geschützt.');return;}
  if(config.lecturers.length>=50){status('Maximal 50 Dozenten möglich.');return;}
  config.lecturers.push({email,name,sites:{basel:false,brugg:false,olten:false}});el('admin-email').value='';el('admin-name').value='';renderTable();markDirty();status('Dozent ergänzt. Standorte auswählen und Konfiguration speichern.');
 });
 async function saveDraft(){
  const result=await getJson('/api/admin/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({config,revision})});config=result.config;revision=result.revision;dirty=false;document.dispatchEvent(new Event('admin-config-saved'));invalidatePlan();renderTable();
 }
 el('admin-export').addEventListener('click',()=>{if(!config||dirty||busy)return;const url=URL.createObjectURL(new Blob([JSON.stringify(config,null,2)+'\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='admin-config.json';link.click();URL.revokeObjectURL(url);});
 el('admin-save').addEventListener('click',async()=>{
  if(busy||!dirty)return;busy=true;controls();status('Konfiguration wird gespeichert …');
  try{await saveDraft();await readInventory('Konfiguration gespeichert.');}
  catch(error){status(error.message);}
  finally{busy=false;controls();}
 });
 el('admin-reconcile').addEventListener('click',async()=>{
  if(busy||!config)return;busy=true;invalidatePlan();controls();status('Abgleich wird vorbereitet; noch keine Camunda-Änderungen …');
  try{
   if(dirty)await saveDraft();
   const result=await getJson('/api/admin/reconcile/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision})});
   activePlan=result.preview;inventory=result.inventory;preview=activePlan.rows;renderTable();renderPreview();
   el('admin-reconcile-summary').textContent=activePlan.changes.length+' geplante '+(activePlan.changes.length===1?'Änderung':'Änderungen')+'. Noch nichts angewendet. Vorschau gültig bis '+new Date(activePlan.expiresAt).toLocaleTimeString('de-CH')+'.';
   el('admin-reconcile-changes').innerHTML=activePlan.changes.length?'<table><thead><tr><th>Konto / Standort</th><th>Aktion</th><th>Aktuelle Rollen</th><th>Zielrollen</th><th>Entfällt</th></tr></thead><tbody>'+activePlan.changes.map(p=>'<tr><td>'+html(p.email)+'<br>'+sites[p.site]+'</td><td>'+(p.action==='invite'?'Einladung versenden':'Rollen ändern')+'</td><td>'+html(p.currentRoles.join(', ')||'Noch kein Mitglied')+'</td><td>'+html(p.targetRoles.join(', '))+'</td><td>'+html(p.removeRoles.join(', ')||'–')+'</td></tr>').join('')+'</tbody></table>':'<p>Die ausgewählten Dozentenrollen stimmen bereits überein.</p>';
   el('admin-reconcile-result').hidden=true;el('admin-reconcile-result').textContent='';el('admin-reconcile-dialog').showModal();
   planExpiryTimer=setTimeout(()=>{invalidatePlan();controls();el('admin-reconcile-summary').textContent='Vorschau abgelaufen. Bitte schließen und neu vorbereiten.';},Math.max(0,Date.parse(activePlan.expiresAt)-Date.now()));
   status('Vorschau vorbereitet. Camunda bleibt bis zum letzten Klick unverändert.');
  }catch(error){invalidatePlan();status(error.message);}
  finally{busy=false;controls();}
 });
 el('admin-reconcile-close').addEventListener('click',()=>{if(!busy){invalidatePlan();el('admin-reconcile-dialog').close();controls();}});
 el('admin-reconcile-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();else{invalidatePlan();controls();}});
 el('admin-reconcile-apply').addEventListener('click',async()=>{
  if(busy||!activePlan)return;
  const id=activePlan.id;busy=true;invalidatePlan();controls();
  const output=el('admin-reconcile-result');output.hidden=false;output.textContent='Abgleich läuft. Jede Änderung wird anschließend lesend geprüft …';
  try{
   const result=await getJson('/api/admin/reconcile/apply',{method:'POST',signal:AbortSignal.timeout(20*60*1000),headers:{'content-type':'application/json'},body:JSON.stringify({previewId:id})});
   el('admin-reconcile-summary').textContent=result.status==='completed'?'Die angezeigten Änderungen wurden angewendet und einzeln lesend bestätigt.':'Der Lauf wurde beendet. Bitte die einzelnen Ergebnisse und nicht versuchten Änderungen prüfen.';
   const labels={verified:'Bestätigt',pending:'Nachprüfung offen',uncertain:'Ergebnis unklar',failed:'Nicht ausgeführt'};
   output.innerHTML='<strong>'+(result.status==='completed'?'Abgleich abgeschlossen.':'Abgleich nicht vollständig; vor weiteren Änderungen neu prüfen.')+'</strong><ul>'+result.results.map(row=>'<li>'+html(row.email)+' · '+sites[row.site]+': '+labels[row.status]+'. '+html(row.message)+(row.invitationPending?' Einladung muss noch angenommen werden.':'')+'</li>').join('')+'</ul>'+(result.notAttempted.length?'<p>'+result.notAttempted.length+' weitere Änderungen wurden nicht versucht.</p>':'');
   await readInventory('Abgleich beendet; aktuellen Stand gelesen.',true);
  }catch(error){el('admin-reconcile-summary').textContent='Das Ergebnis konnte nicht vollständig bestätigt werden.';output.textContent=error.message+' Bitte schließen und eine neue Vorschau erstellen. Es wird nichts automatisch wiederholt.';status('Abgleich konnte nicht vollständig bestätigt werden.');}
  finally{busy=false;controls();}
 });
})();
}
