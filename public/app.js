let state={};
const $=s=>document.querySelector(s);
const fmt=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(n||0);
async function load(){ state=await fetch('/api/state').then(r=>r.json()); renderAll(); }
function renderAll(){ renderCards(); renderMembers(); renderPayments(); renderActivities(); renderKnowledge(); renderDocuments(); renderConversations(); renderPending(); renderRegistrations(); renderSurveys(); }
const TAB_META={
  bot:{title:'Panchito',icon:'/allboys-escudo.jfif',desc:'Asistente virtual del Club All Boys para consultas, actividades, cuotas, inscripciones y derivaciones.'},
  activities:{title:'Actividades',emoji:'⚽',desc:'Administrá disciplinas, categorías, días, horarios, precios y responsables.'},
  members:{title:'Socios',emoji:'👥',desc:'Gestión de socios, teléfonos, estado de cuota y actividades.'},
  payments:{title:'Cuotas / Pagos',emoji:'💳',desc:'Registro e historial de pagos del club.'},
  registrations:{title:'Inscripciones',emoji:'📝',desc:'Solicitudes tomadas por Panchito para confirmar por administración.'},
  pending:{title:'Consultas / Reclamos',emoji:'📋',desc:'Consultas derivadas, reclamos y respuestas por WhatsApp.'},
  surveys:{title:'Encuestas',emoji:'⭐',desc:'Valoraciones y satisfacción de atención.'},
  whatsapp:{title:'Conexión WhatsApp',emoji:'🟢',desc:'Preparación para conectar Panchito con WhatsApp Business.'}
};
function setPageHeader(tab){
  const meta=TAB_META[tab]||{title:'Panchito',emoji:'💬',desc:'Asistente virtual del Club All Boys.'};
  const titleEl=$('#pageTitle'); if(titleEl) titleEl.textContent=meta.title;
  const p=document.querySelector('.pageHead p'); if(p) p.textContent=meta.desc;
  const icon=$('#pageIcon');
  if(icon){
    if(meta.icon){ icon.src=meta.icon; icon.style.display='block'; icon.nextElementSibling?.classList?.remove('emojiIconText'); }
    else{ icon.removeAttribute('src'); icon.style.display='none'; }
  }
  const old=document.querySelector('.pageEmojiIcon'); if(old) old.remove();
  if(meta.emoji && document.querySelector('.pageHead')){
    const e=document.createElement('div'); e.className='pageEmojiIcon'; e.textContent=meta.emoji;
    document.querySelector('.pageHead')?.prepend(e);
  }

  // Encabezado principal superior fijo: siempre queda Panchito con escudo All Boys
  const topTitle=$('#topSectionTitle');
  if(topTitle) topTitle.textContent = 'Panchito 🤖';
  const topSub=$('#topSectionSub');
  if(topSub) topSub.innerHTML = 'All Boys · Asistente oficial · <i></i> En línea';
  const topIcon=$('#topSectionIcon');
  if(topIcon){
    topIcon.src='/allboys-escudo.jfif';
    topIcon.style.display='block';
    topIcon.classList.remove('emojiTopLogo');
    topIcon.textContent='';
  }
}
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('.tab').forEach(x=>x.classList.remove('show'));$('#'+b.dataset.tab).classList.add('show');setPageHeader(b.dataset.tab);const main=document.querySelector('.main'); if(main) main.scrollTo({top:0,behavior:'smooth'});});
setPageHeader('bot');
function renderCards(){const s=state.stats;$('#cards').innerHTML=`<div class="card"><span>Socios</span><b>${s.total}</b></div><div class="card"><span>Activos</span><b>${s.active}</b></div><div class="card"><span>Morosos</span><b>${s.debtors}</b></div><div class="card"><span>Deuda</span><b>${fmt(s.debt)}</b></div><div class="card"><span>Recaudado mes</span><b>${fmt(s.monthlyRevenue)}</b></div><div class="card"><span>Chats hoy</span><b>${s.todayChats}</b></div><div class="card"><span>Consultas pendientes</span><b>${s.pending||0}</b></div><div class="card"><span>Reclamos pendientes</span><b>${s.claimsPending||0}</b></div><div class="card"><span>Inscripciones</span><b>${s.registrationsPending||0}</b></div><div class="card"><span>Satisfacción</span><b>${s.satisfactionAvg||0} ⭐</b></div>`;const pct=s.total?Math.round((s.debtors/s.total)*100):0;$('#debtBar').style.width=pct+'%';$('#debtText').textContent=`${pct}% de socios registra deuda pendiente.`;const counts={};(state.conversations||[]).forEach(c=>counts[c.intent]=(counts[c.intent]||0)+1);$('#intentList').innerHTML=Object.entries(counts).slice(0,6).map(([k,v])=>`<p><b>${k}</b> — ${v} consultas</p>`).join('')||'<p>Sin consultas todavía.</p>';$('#lastPayments').innerHTML=(state.payments||[]).slice(0,5).map(p=>`<p><b>${p.memberName}</b> · ${fmt(p.amount)} · ${p.method}</p>`).join('')||'<p>Sin pagos registrados.</p>';$('#docSummary').textContent=`${s.documents} documento(s) cargado(s) para que la IA responda.`;}
function renderMembers(){let q=($('#memberSearch')?.value||'').toLowerCase();let rows=(state.members||[]).filter(m=>(m.name+m.dni+m.memberNo+m.phone).toLowerCase().includes(q)).map(m=>`<tr><td><b>${m.name}</b><br><small>DNI ${m.dni} · Socio ${m.memberNo}</small></td><td>${m.phone}</td><td><span class="badge ${m.debt>0?'bad':'ok'}">${m.feeStatus}</span></td><td>${fmt(m.debt)}</td><td>${(m.activities||[]).join(', ')}</td></tr>`).join('');$('#membersTable').innerHTML=`<table><thead><tr><th>Socio</th><th>Teléfono</th><th>Cuota</th><th>Deuda</th><th>Actividades</th></tr></thead><tbody>${rows}</tbody></table>`;$('#payMember').innerHTML=(state.members||[]).map(m=>`<option value="${m.id}">${m.name} · DNI ${m.dni} · deuda ${fmt(m.debt)}</option>`).join('');}
$('#memberSearch')?.addEventListener('input',renderMembers);
function renderPayments(){ $('#paymentsTable').innerHTML=`<table><thead><tr><th>Fecha</th><th>Socio</th><th>Importe</th><th>Medio</th><th>Período</th></tr></thead><tbody>${(state.payments||[]).map(p=>`<tr><td>${p.date}</td><td>${p.memberName}</td><td><b>${fmt(p.amount)}</b></td><td>${p.method}</td><td>${p.period||''}</td></tr>`).join('')}</tbody></table>`; }
function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
function renderActivities(){
  const q=($('#activitySearch')?.value||'').toLowerCase();
  const list=(state.activities||[]).filter(a=>`${a.name} ${a.category} ${a.days} ${a.time} ${a.teacher} ${a.contact}`.toLowerCase().includes(q));
  $('#activityGrid').innerHTML=list.map(a=>`<div class="act">
    <div class="row"><h3>${esc(a.name)}</h3><span class="badge ${a.active===false?'bad':'ok'}">${a.active===false?'Inactiva':'Activa'}</span></div>
    <p><b>${esc(a.category||'Sin categoría')}</b></p>
    <p>${esc(a.days)} · ${esc(a.time)}</p>
    <p>Precio/cuota: <b>${a.cost?fmt(a.cost):'A confirmar'}</b></p>
    <p>Contacto: <b>${esc(a.contact||'Administración')}</b></p>
    ${a.teacher?`<p>Responsable: ${esc(a.teacher)}</p>`:''}
    ${a.notes?`<p>${esc(a.notes)}</p>`:''}
    <div class="row"><button onclick="editActivity(${a.id})">✏️ Modificar</button><button class="secondary" onclick="deleteActivity(${a.id})">Eliminar</button></div>
  </div>`).join('')||'<p>No hay actividades cargadas.</p>';
}
$('#activitySearch')?.addEventListener('input',renderActivities);
function clearActivityForm(){ ['actId','actName','actCategory','actDays','actTime','actCost','actTeacher','actContact','actNotes'].forEach(id=>{const el=$('#'+id); if(el) el.value='';}); if($('#actActive')) $('#actActive').checked=true; const title=document.querySelector('#activities h2'); if(title) title.textContent='Gestionar actividades'; const btn=document.querySelector('#activities button[onclick="saveActivity()"]'); if(btn) btn.textContent='Guardar actividad'; }
function editActivity(id){ const a=(state.activities||[]).find(x=>Number(x.id)===Number(id)); if(!a)return; $('#actId').value=a.id; $('#actName').value=a.name||''; $('#actCategory').value=a.category||''; $('#actDays').value=a.days||''; $('#actTime').value=a.time||''; $('#actCost').value=a.cost||''; $('#actTeacher').value=a.teacher||''; $('#actContact').value=a.contact||''; $('#actNotes').value=a.notes||''; $('#actActive').checked=a.active!==false; document.querySelector('[data-tab="activities"]').click(); const title=document.querySelector('#activities h2'); if(title) title.textContent='Modificar actividad cargada'; const btn=document.querySelector('#activities button[onclick="saveActivity()"]'); if(btn) btn.textContent='Guardar cambios'; window.scrollTo({top:0,behavior:'smooth'}); }
async function saveActivity(){ const id=$('#actId').value; const body={name:$('#actName').value,category:$('#actCategory').value,days:$('#actDays').value,time:$('#actTime').value,cost:Number($('#actCost').value||0),teacher:$('#actTeacher').value,contact:$('#actContact').value,notes:$('#actNotes').value,active:$('#actActive').checked}; const url=id?`/api/activities/${id}`:'/api/activities'; const method=id?'PUT':'POST'; const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(!r.ok){ alert('No se pudo guardar la actividad'); return; } alert(id?'Actividad modificada ✅':'Actividad agregada ✅'); clearActivityForm(); await load(); document.querySelector('[data-tab="activities"]').click(); }
async function deleteActivity(id){ if(!confirm('¿Eliminar esta actividad?'))return; await fetch(`/api/activities/${id}`,{method:'DELETE'}); await load(); document.querySelector('[data-tab="activities"]').click(); }

function renderKnowledge(){ $('#knowledgeList').innerHTML=(state.knowledge||[]).map(k=>`<div class="act"><b>${k.q}</b><p>${k.a}</p></div>`).join(''); }
function renderDocuments(){ $('#documentList').innerHTML=(state.documents||[]).map(d=>`<div class="act"><b>${d.title}</b><p>${(d.content||'').slice(0,220)}${(d.content||'').length>220?'...':''}</p></div>`).join(''); }
function renderConversations(){ $('#conversationTable').innerHTML=`<table><thead><tr><th>Fecha</th><th>Teléfono</th><th>Mensaje</th><th>Respuesta</th><th>Intención</th><th>Conf.</th></tr></thead><tbody>${(state.conversations||[]).map(c=>`<tr><td>${new Date(c.createdAt).toLocaleString()}</td><td>${c.phone}</td><td>${c.text}</td><td>${c.reply}</td><td><span class="badge ${c.confidence<.6?'warn':'ok'}">${c.intent}</span></td><td>${Math.round((c.confidence||0)*100)}%</td></tr>`).join('')}</tbody></table>`; }


function normalizeWhatsappPhone(value){
  let raw=String(value||'').replace(/\D/g,'');
  if(!raw) return '';

  // Soporta formatos argentinos comunes:
  // 2954218753 -> 5492954218753
  // 02954218753 -> 5492954218753
  // 295415218753 -> 5492954218753
  // 5492954218753 -> 5492954218753
  raw=raw.replace(/^0+/, '');

  if(raw.startsWith('549')) return raw;
  if(raw.startsWith('54')){
    const rest=raw.slice(2);
    return rest.startsWith('9') ? raw : `549${rest}`;
  }

  // Si viene con 15 después del código de área 2954, lo sacamos para WhatsApp.
  raw=raw.replace(/^(2954)15/, '$1');
  return `549${raw}`;
}

function registrationWhatsappLink(r){
  const phone=normalizeWhatsappPhone(r.phone);
  if(!phone) return '';
  const msg=`Hola ${r.name||''}, te escribimos desde Administración de All Boys por tu solicitud de inscripción.\n\nActividad: ${r.activity||''}\nCategoría: ${r.category||''}\n\nQueríamos confirmar cupo, documentación requerida, valor actualizado y forma de pago.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}


function pendingWhatsappLink(p){
  const phone=normalizeWhatsappPhone(p.contactPhone || p.phone || '');
  if(!phone) return '';
  const msg=`Hola ${p.name||''}, te escribimos desde Administración de All Boys por tu consulta.\n\nTema: ${p.topic||p.category||''}\nMensaje: ${p.message||p.text||''}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}
function isInscriptionPending(p){
  const txt=`${p.priority||''} ${p.category||''} ${p.topic||''} ${p.note||''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  return Boolean(p.registrationId) || txt.includes('inscripcion') || txt.includes('solicitud de inscripcion');
}

function renderRegistrations(){
  const all=(state.registrations||[]).slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const active=document.querySelector('.regFilterBtn.active')?.dataset.regFilter || 'Todas';
  const q=($('#registrationSearch')?.value||'').toLowerCase();
  const list=all.filter(r=>{
    const status=r.status||'Pendiente';
    if(active!=='Todas' && status!==active) return false;
    return `${r.name||''} ${r.phone||''} ${r.activity||''} ${r.category||''} ${r.age||''}`.toLowerCase().includes(q);
  });
  const box=$('#registrationsGrid');
  if(!box) return;
  const pending=all.filter(r=>(r.status||'Pendiente')==='Pendiente').length;
  const count=$('#registrationCount');
  if(count) count.textContent=`🟡 Pendientes: ${pending} · Total: ${all.length}`;
  const badgeClass=status=>status==='Confirmada'?'ok':status==='Sin cupo'?'bad':status==='Finalizada'?'':'warn';
  box.innerHTML=list.map(r=>{
    const status=r.status||'Pendiente';
    const date=r.createdAt?new Date(r.createdAt).toLocaleString('es-AR'):'';
    const wa=registrationWhatsappLink(r);
    return `<div class="act">
      <div class="row">
        <h3>📝 ${esc(r.name||'Sin nombre')}</h3>
        <span class="badge ${badgeClass(status)}">${esc(status)}</span>
      </div>
      <p><b>Fecha:</b> ${esc(date)}</p>
      <p><b>Edad / nacimiento:</b> ${esc(r.age||'-')}</p>
      <p><b>Teléfono:</b> ${esc(r.phone||'-')}</p>
      <p><b>Actividad:</b> ${esc(r.activity||'-')}</p>
      <p><b>Categoría:</b> ${esc(r.category||'-')}</p>
      ${r.notes?`<p><b>Nota:</b> ${esc(r.notes)}</p>`:''}
      <div class="row">
        ${wa?`<a class="button" target="_blank" rel="noopener" href="${esc(wa)}">📲 Abrir WhatsApp al solicitante</a>`:`<span class="badge warn">Sin teléfono válido</span>`}
        <button onclick="setRegistrationStatus(${r.id},'Confirmada')">✅ Confirmada</button>
        <button class="secondary" onclick="setRegistrationStatus(${r.id},'Pendiente')">↩️ Pendiente</button>
        <button class="secondary" onclick="setRegistrationStatus(${r.id},'Sin cupo')">🚫 Sin cupo</button>
        <button class="secondary" onclick="setRegistrationStatus(${r.id},'Finalizada')">🏁 Finalizada</button>
        <button class="secondary" onclick="deleteRegistration(${r.id})">🗑️ Eliminar</button>
      </div>
    </div>`;
  }).join('')||'<p>No hay solicitudes de inscripción para este filtro.</p>';
}

document.addEventListener('click',e=>{
  const btn=e.target.closest('[data-reg-filter]');
  if(!btn) return;
  document.querySelectorAll('[data-reg-filter]').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderRegistrations();
});
$('#registrationSearch')?.addEventListener('input',renderRegistrations);

async function setRegistrationStatus(id,status){
  await fetch('/api/registrations/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  await load();
}
async function deleteRegistration(id){
  if(!confirm('¿Eliminar esta solicitud de inscripción?')) return;
  await fetch('/api/registrations/'+id,{method:'DELETE'});
  await load();
}


function renderSurveys(){
  const list=(state.surveys||[]).slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const avg=list.length ? (list.reduce((s,x)=>s+Number(x.score||0),0)/list.length).toFixed(1) : '0';
  const avgBox=$('#surveyAvg'); if(avgBox) avgBox.textContent=`Promedio: ${avg} ⭐ · Total: ${list.length}`;
  const grid=$('#surveyGrid'); if(!grid) return;
  grid.innerHTML=list.map(x=>`<div class="act"><div class="row"><h3>${'⭐'.repeat(Number(x.score||0))}</h3><span class="badge ok">${Number(x.score||0)}/5</span></div><p><b>Tema:</b> ${esc(x.topic||'consulta')}</p><p><b>Teléfono:</b> ${esc(x.phone||'-')}</p><p><b>Fecha:</b> ${x.createdAt?new Date(x.createdAt).toLocaleString('es-AR'):''}</p>${x.comment?`<p><b>Comentario:</b> ${esc(x.comment)}</p>`:''}</div>`).join('') || '<p>Todavía no hay valoraciones.</p>';
}

function renderPending(){
  const all=(state.pendingQueries||[]).filter(p=>!isInscriptionPending(p)).slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const active=document.querySelector('.filterBtn.active')?.dataset.pendingFilter || 'Todas';
  const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const list=all.filter(p=>{
    if(active==='Todas') return true;
    if(active==='Pendiente' || active==='Respondida') return (p.status||'Pendiente')===active;
    const cat=norm(p.priority||p.category||p.topic||'');
    return cat.includes(norm(active));
  });
  const box=$('#pendingGrid');
  if(!box) return;
  const pendingCount=all.filter(p=>(p.status||'Pendiente')==='Pendiente').length;
  const answeredCount=all.filter(p=>(p.status||'Pendiente')==='Respondida').length;
  const claimsCount=all.filter(p=>norm(p.priority||p.category||p.topic||'').includes('reclamo')).length;
  const count=$('#pendingCount');
  if(count){
    count.innerHTML=`<span>📋 Total: <b>${all.length}</b></span><span>🟡 Pendientes: <b>${pendingCount}</b></span><span>🟢 Respondidas: <b>${answeredCount}</b></span><span>🔴 Reclamos: <b>${claimsCount}</b></span>`;
  }
  box.innerHTML=list.map(p=>{
    const status=p.status||'Pendiente';
    const wa=pendingWhatsappLink(p) || p.whatsappLink || '';
    const rawPriority=p.priority || (String(p.category||'').includes('reclamo')?'Reclamo':'Consulta');
    const priorityLabel=String(rawPriority).replace(/[🔴🟡🟢🔵]/g,'').trim() || 'Consulta';
    const dotClass=status==='Respondida'?'okDot':(norm(priorityLabel).includes('reclamo')?'redDot':norm(priorityLabel).includes('inscripcion')?'blueDot':'');
    const date=p.createdAt?new Date(p.createdAt).toLocaleString('es-AR'):'';
    const message=esc(p.message||p.text||'-');
    const note=p.note?`<div class="pendingNote"><b>Nota</b><span>${esc(p.note)}</span></div>`:'';
    return `<article class="act pendingCard">
      <div class="pendingCardTop">
        <div class="pendingTitle"><span class="statusDot ${dotClass}"></span><h3>${esc(priorityLabel)} · ${esc(p.topic||p.category||'Consulta')}</h3></div>
        <span class="badge ${status==='Respondida'?'ok':'warn'}">${esc(status)}</span>
      </div>
      <div class="pendingMeta">${esc(date)}</div>
      <div class="pendingInfo">
        <div><small>Nombre</small><strong>${esc(p.name||'-')}</strong></div>
        <div><small>Teléfono</small><strong>${esc(p.contactPhone||p.phone||'-')}</strong></div>
        <div><small>Área / Tema</small><strong>${esc(p.topic||p.category||'-')}</strong></div>
      </div>
      <div class="pendingMessage"><b>Mensaje</b><span>${message}</span></div>
      ${note}
      <div class="pendingActions">
        ${wa?`<a class="button waBtn" target="_blank" rel="noopener" href="${esc(wa)}">💬 WhatsApp</a>`:''}
        <button class="okBtn" onclick="markPending(${p.id},'Respondida')">✅ Resolver</button>
        <button class="secondary" onclick="markPending(${p.id},'Pendiente')">↩️ Pendiente</button>
        <button class="secondary dangerBtn" onclick="deletePending(${p.id})">🗑️ Eliminar</button>
      </div>
    </article>`;
  }).join('')||'<div class="emptyState">No hay derivaciones para este filtro.</div>';
}
document.addEventListener('click',e=>{
  const btn=e.target.closest('[data-pending-filter]');
  if(!btn) return;
  document.querySelectorAll('[data-pending-filter]').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderPending();
});

async function markPending(id,status){ await fetch(`/api/pending/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); await load(); document.querySelector('[data-tab="pending"]')?.click(); }
async function deletePending(id){ if(!confirm('¿Eliminar esta derivación?'))return; await fetch(`/api/pending/${id}`,{method:'DELETE'}); await load(); document.querySelector('[data-tab="pending"]')?.click(); }

function scrollChatToBottom(){
  const chat=$('#chat');
  if(!chat) return;
  chat.scrollTo({top:chat.scrollHeight,behavior:'smooth'});
}
function nowChatTime(){
  return new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
}
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
function setChatBusy(busy){
  const input=$('#chatInput');
  const btn=document.querySelector('#chatForm button');
  if(input) input.disabled=!!busy;
  if(btn) btn.disabled=!!busy;
}
function addTyping(){
  const chat=$('#chat');
  if(!chat) return null;
  const row=document.createElement('div');
  row.className='msgRow botRow typingRow';
  const avatar=document.createElement('img');
  avatar.className='bubbleAvatar robotBubbleAvatar';
  avatar.src='/clubbot-robot-allboys.png';
  avatar.alt='Panchito';
  const d=document.createElement('div');
  d.className='msg bot typingBubble';
  d.innerHTML = `<span>Panchito está escribiendo</span><b></b><b></b><b></b>`;
  row.appendChild(avatar);
  row.appendChild(d);
  chat.appendChild(row);
  scrollChatToBottom();
  return row;
}
const PANCHITO_PERSONALITY={
  ok:['Dale 👍','Perfecto 😊','Claro 😄','Excelente, te cuento.','Sin problema.'],
  thanks:['¡Un placer! 💙💛','Gracias a vos 😊','Para eso estoy, papá 🙌','Me alegra poder ayudarte.'],
  wait:['Un segundo y te lo paso...','Dame un instante...','Ahí lo reviso...','Te lo preparo...']
};
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function splitBotReply(text){
  const raw=String(text||'').trim();
  if(!raw) return [''];
  const lines=raw.split(/\r?\n/);
  const chunks=[];
  let current=[];
  let optionBlock=[];
  const isOption=l=>/^\s*[A-H]\.\s+/i.test(l) || /^\s*(Respond[eé]|Tambi[eé]n pod[eé]s|Pod[eé]s responder)/i.test(l);
  for(const line of lines){
    if(isOption(line)){
      if(current.length){ chunks.push(current.join('\n').trim()); current=[]; }
      optionBlock.push(line);
      continue;
    }
    if(optionBlock.length){ chunks.push(optionBlock.join('\n').trim()); optionBlock=[]; }
    if(line.trim()===''){
      if(current.length){ chunks.push(current.join('\n').trim()); current=[]; }
    }else{
      current.push(line);
      if(current.join(' ').length>230){ chunks.push(current.join('\n').trim()); current=[]; }
    }
  }
  if(current.length) chunks.push(current.join('\n').trim());
  if(optionBlock.length) chunks.push(optionBlock.join('\n').trim());
  return chunks.filter(Boolean);
}
function softenBotChunk(chunk,index,total){
  let t=String(chunk||'').trim();
  if(!t) return t;
  // Humaniza respuestas cortas sin tocar menús ni links.
  const hasOptions=/^\s*[A-H]\.\s+/mi.test(t);
  const hasLink=/wa\.me|https?:\/\//i.test(t);
  if(index===0 && total>1 && !hasOptions && !hasLink && t.length<90 && !/[😊😄👍🙌💙💛]/.test(t)){
    if(/^(perfecto|claro|dale|bien|ok)\b/i.test(t)) return t;
  }
  return t;
}
async function addBotHuman(text){
  setChatBusy(true);
  const chunks=splitBotReply(text);
  for(let i=0;i<chunks.length;i++){
    const typing=addTyping();
    const chars=String(chunks[i]||'').length;
    const delay=Math.min(1600, Math.max(520, 420 + chars * 5));
    await sleep(delay);
    if(typing) typing.remove();
    addMsg(softenBotChunk(chunks[i],i,chunks.length),'bot');
    if(i<chunks.length-1) await sleep(280);
  }
  setChatBusy(false);
}
function addMsg(text,type){
  const chat=$('#chat');
  const time=nowChatTime();
  if(type==='bot'){
    const row=document.createElement('div');
    row.className='msgRow botRow';
    const avatar=document.createElement('img');
    avatar.className='bubbleAvatar robotBubbleAvatar';
    avatar.src='/clubbot-robot-allboys.png';
    avatar.alt='Panchito';
    const d=document.createElement('div');
    d.className='msg bot';
    d.innerHTML = `<div class="msgText">${formatBotReply(text)}</div><div class="msgMeta">${time}</div>`;
    row.appendChild(avatar);
    row.appendChild(d);
    chat.appendChild(row);
  } else {
    const d=document.createElement('div');
    d.className='msg me';
    d.innerHTML = `<div class="msgText">${escapeHtml(text)}</div><div class="msgMeta">${time} ✓✓</div>`;
    chat.appendChild(d);
  }
  scrollChatToBottom();
}

function formatBotReply(text){
  const original = String(text ?? '');
  const adminWaUrl = 'https://wa.me/5492954592313?text=' + encodeURIComponent('Hola, vengo derivado desde Panchito IA. Quiero consultar con Administración.');
  const adminButton = `<a class="waChatLink" target="_blank" rel="noopener" href="${adminWaUrl}">📲 Abrir WhatsApp Administración</a>`;
  const isAdminReply = /Administraci[oó]n All Boys|Responsables:\s*Carolina|Carolina\s*\/\s*M[oó]nica/i.test(original);

  if(isAdminReply){
    let lines = original.split(/\r?\n/)
      .map(l=>l.trimEnd())
      // Eliminamos cualquier línea vieja o duplicada de WhatsApp.
      .filter(l=>!/Abrir WhatsApp|wa\.me|whatsapp administraci[oó]n/i.test(l));

    let html = lines.map(escapeHtml).join('<br>');
    if(/Responsables:\s*Carolina y M[oó]nica/i.test(html)){
      html = html.replace(/Responsables:\s*Carolina y M[oó]nica/i, m => `${m}<br>${adminButton}`);
    } else if(/Carolina\s*\/\s*M[oó]nica/i.test(html)){
      html = html.replace(/Carolina\s*\/\s*M[oó]nica/i, m => `${m}<br>${adminButton}`);
    } else {
      html += `<br>${adminButton}`;
    }
    return addQuickReplies(html);
  }

  let html = escapeHtml(original).replace(/\r?\n/g,'<br>');
  // Convierte líneas tipo "📲 Abrir WhatsApp Natatorio: https://wa.me/..." en un botón limpio.
  html = html.replace(/📲\s*Abrir WhatsApp\s*([^:<]*)?:\s*(https:\/\/wa\.me\/[^<\s]+)/g, (_,label,url)=>{
    const cleanLabel = String(label||'').trim();
    return `<a class="waChatLink" target="_blank" rel="noopener" href="${url}">📲 Abrir WhatsApp${cleanLabel?' '+cleanLabel:''}</a>`;
  });
  html = html.replace(/(^|<br>|\s)(https:\/\/wa\.me\/[^<\s]+)/g, '$1<a class="waChatLink" target="_blank" rel="noopener" href="$2">📲 Abrir WhatsApp</a>');
  return addQuickReplies(html);
}

function addQuickReplies(html){
  // Estilo WhatsApp real: opciones como texto simple, sin botones grandes.
  return html;
}

function escapeHtml(text){
  return String(text)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;")
    .replace(/\n/g,'<br>');
}

async function sendChatText(text){
  const value=String(text||'').trim();
  if(!value) return;
  addMsg(value,'me');
  const normalized=value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  // La encuesta y los cierres los maneja el servidor para no repetir "gracias" ni enganchar submenús.
  try{
    const r=await fetch('/api/bot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:value,from:'5492954000000'})}).then(r=>r.json());
    await addBotHuman(r.reply);
    await load();
  }catch(err){
    console.error(err);
    await addBotHuman('No pude conectar con el servidor del bot. Revisá que esté corriendo npm run dev.');
  }
}
$('#chatForm').addEventListener('submit',async e=>{e.preventDefault();const input=$('#chatInput');const text=input.value.trim(); input.value=''; await sendChatText(text);});
document.addEventListener('click',async e=>{
  const btn=e.target.closest('.chatOption[data-send]');
  if(!btn) return;
  await sendChatText(btn.dataset.send);
});
fetch('/api/reset-demo-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:'5492954000000'})}).catch(()=>{});
const PANCHITO_SALUDOS=[
  `¡Hola! Soy Panchito, el asistente virtual de All Boys.`,
  `¡Buenas! Soy Panchito 🤖`,
  `¡Hola, bienvenido a All Boys! Soy Panchito.`,
  `¡Qué tal! Acá Panchito, listo para ayudarte.`
];
setTimeout(()=>addBotHuman(`${pick(PANCHITO_SALUDOS)}

Estoy para ayudarte con actividades, horarios, inscripciones, cuotas y consultas del club.

A. Actividades, días y horarios 🏀⚽🤸
B. Precios e inscripción 📝
C. Cuotas y pagos 💳
D. Natatorio / pileta 🏊
E. Hablar con administración 📞
F. Reclamos o sugerencias 💬
G. Prensa, CV, proveedores o propuestas 📩
H. Otra consulta 🔎

Podés responder con la letra o escribir el tema.`), 450);
function quickSend(text){ $('#chatInput').value=text; $('#chatForm').requestSubmit(); }
function openMemberForm(){$('#modal').classList.add('show')} function closeMemberForm(){$('#modal').classList.remove('show')}
async function saveMember(){await fetch('/api/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#mName').value,dni:$('#mDni').value,memberNo:$('#mNo').value,phone:$('#mPhone').value,email:'',feeStatus:$('#mFee').value,debt:Number($('#mDebt').value||0),nextDue:'10/07/2026',lastPayment:''})});closeMemberForm();load();}
async function savePayment(){await fetch('/api/payments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberId:$('#payMember').value,amount:$('#payAmount').value,method:$('#payMethod').value,period:$('#payPeriod').value})});$('#payAmount').value='';$('#payPeriod').value='';load();}
async function addKnowledge(){await fetch('/api/knowledge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:$('#kq').value,a:$('#ka').value})});$('#kq').value='';$('#ka').value='';load();}
async function addDocument(){await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:$('#docTitle').value,content:$('#docContent').value})});$('#docTitle').value='';$('#docContent').value='';load();}
async function importCSV(){const r=await fetch('/api/import/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv:$('#csvBox').value})}).then(r=>r.json());$('#importMsg').textContent=`Importados: ${r.added}`;load();}
async function memberLogin(){try{const r=await fetch('/api/member-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dni:$('#loginDni').value,password:$('#loginPass').value})});if(!r.ok) throw new Error(); const d=await r.json(); $('#portalResult').innerHTML=`<h3>${d.member.name}</h3><p>DNI ${d.member.dni} · Socio ${d.member.memberNo}</p><p><span class="badge ${d.member.debt>0?'bad':'ok'}">${d.member.feeStatus}</span></p><p>Deuda: <b>${fmt(d.member.debt)}</b></p><p>Actividades: ${(d.member.activities||[]).join(', ')||'Sin actividades'}</p><h4>Pagos</h4>${(d.payments||[]).map(p=>`<p>${p.date} · ${fmt(p.amount)} · ${p.method}</p>`).join('')||'<p>Sin pagos</p>'}`;}catch(e){$('#portalResult').textContent='Datos incorrectos';}}

// ===== Importar / Exportar Socios y Actividades =====
function csvEscape(value){
  const v=String(value??'');
  return /[",;\n]/.test(v) ? '"'+v.replaceAll('"','""')+'"' : v;
}
function downloadCSV(filename, rows){
  const csv=rows.map(r=>r.map(csvEscape).join(';')).join('\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function downloadTemplate(type){
  if(type==='members'){
    downloadCSV('plantilla_socios_allboys.csv', [["dni","memberNo","name","phone","email","feeStatus","debt","activities"],["12345678","1001","Juan Perez","5492954000001","mail@ejemplo.com","Al día","0","Fútbol Infantil | Natación"]]);
  }else{
    downloadCSV('plantilla_actividades_allboys.csv', [["name","category","days","time","cost","teacher","contact","active","slots","notes"],["Básquet","Sub 13","Lunes y miércoles","16:30 a 18:00","12000","Profe Ejemplo","Administración","SI","25","Traer apto físico"]]);
  }
}
function exportData(type){
  if(type==='members'){
    const rows=[["dni","memberNo","name","phone","email","feeStatus","debt","activities"]].concat((state.members||[]).map(m=>[m.dni,m.memberNo,m.name,m.phone,m.email,m.feeStatus,m.debt,(m.activities||[]).join(' | ')]));
    downloadCSV('socios_allboys_export.csv', rows);
  }else{
    const rows=[["name","category","days","time","cost","teacher","contact","active","slots","notes"]].concat((state.activities||[]).map(a=>[a.name,a.category,a.days,a.time,a.cost,a.teacher,a.contact,a.active===false?'NO':'SI',a.slots||'',a.notes||'']));
    downloadCSV('actividades_allboys_export.csv', rows);
  }
}
function pickImport(type){
  const input= type==='members' ? $('#memberImportFile') : $('#activityImportFile');
  if(input){ input.value=''; input.click(); }
}
function parseCSV(text){
  const delimiter=(text.split('\n')[0].match(/;/g)||[]).length >= (text.split('\n')[0].match(/,/g)||[]).length ? ';' : ',';
  const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(c==='"' && q && n==='"'){ cell+='"'; i++; }
    else if(c==='"'){ q=!q; }
    else if(c===delimiter && !q){ row.push(cell.trim()); cell=''; }
    else if((c==='\n' || c==='\r') && !q){ if(c==='\r' && n==='\n') i++; row.push(cell.trim()); if(row.some(x=>x!=='')) rows.push(row); row=[]; cell=''; }
    else cell+=c;
  }
  row.push(cell.trim()); if(row.some(x=>x!=='')) rows.push(row);
  return rows;
}
async function handleImportFile(ev,type){
  const file=ev.target.files?.[0]; if(!file) return;
  const msg= type==='members' ? $('#memberImportMsg') : $('#activityImportMsg');
  if(!file.name.toLowerCase().match(/\.(csv|txt)$/)) { alert('Por ahora importá la plantilla CSV. Excel la abre y la guarda como CSV.'); return; }
  const text=await file.text();
  const rows=parseCSV(text);
  if(rows.length<2){ alert('El archivo no tiene datos para importar.'); return; }
  const headers=rows[0].map(h=>h.trim());
  const items=rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));
  const res=await fetch('/api/import/'+type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})}).then(r=>r.json());
  if(msg) msg.textContent=`✅ Importados: ${res.added||0} · Actualizados: ${res.updated||0} · Omitidos: ${res.skipped||0}`;
  await load();
  document.querySelector(`[data-tab="${type==='members'?'members':'activities'}"]`)?.click();
}

load();

// FIX: las 3 rayitas esconden/muestran el menú izquierdo y agrandan el contenido
(function(){
  const hamb=document.querySelector('.hamb');
  const body=document.body;
  if(!hamb) return;
  hamb.setAttribute('role','button');
  hamb.setAttribute('tabindex','0');
  hamb.setAttribute('title','Mostrar / ocultar menú izquierdo');
  function toggleMenu(){
    body.classList.toggle('menu-collapsed');
    try{ localStorage.setItem('panchitoMenuCollapsed', body.classList.contains('menu-collapsed') ? '1' : '0'); }catch(e){}
  }
  hamb.addEventListener('click', toggleMenu);
  hamb.addEventListener('keydown', function(e){
    if(e.key==='Enter' || e.key===' '){ e.preventDefault(); toggleMenu(); }
  });
  try{
    if(localStorage.getItem('panchitoMenuCollapsed')==='1') body.classList.add('menu-collapsed');
  }catch(e){}
})();
