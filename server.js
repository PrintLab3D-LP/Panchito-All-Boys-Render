require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');

app.use(cors());
app.use(express.json({ limit: '15mb' }));
// Twilio WhatsApp envía los mensajes como application/x-www-form-urlencoded.
// Esta línea permite leer req.body.Body, req.body.From, etc.
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
// Evita que el panel pueda abrirse directamente como /admin.html sin autenticación.
app.use((req,res,next)=>{
  if(req.path === '/admin.html') return res.redirect('/admin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// V105 - Usuarios separados y permisos por rol para el panel de Administración.
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'administracion');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '2416');

function normalizeScope(value=''){
  return clean(String(value)).replace(/[^a-z0-9]+/g,' ').trim();
}
function loadAdminUsers(){
  const raw=String(process.env.ADMIN_USERS_JSON||'').trim();
  if(raw){
    try{
      const parsed=JSON.parse(raw);
      if(Array.isArray(parsed)){
        const users=parsed.map((u,i)=>({
          username:String(u.username||u.user||'').trim(),
          password:String(u.password||''),
          displayName:String(u.displayName||u.name||u.username||`Usuario ${i+1}`).trim(),
          role:String(u.role||'secretaria').toLowerCase().trim(),
          scopes:Array.isArray(u.scopes)?u.scopes.map(normalizeScope).filter(Boolean):[]
        })).filter(u=>u.username&&u.password);
        if(users.length) return users;
      }
    }catch(e){ console.error('ADMIN_USERS_JSON inválido:',e.message); }
  }
  return [{username:ADMIN_USERNAME,password:ADMIN_PASSWORD,displayName:'Administración',role:'admin',scopes:[]}];
}
const ADMIN_USERS=loadAdminUsers();
const ADMIN_SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_API_KEY || 'cambiar-esta-clave-en-render');
const ADMIN_COOKIE = 'panchito_admin';
const ADMIN_SESSION_HOURS = Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 12));

function parseCookies(req){
  const out={};
  const raw=String(req.headers.cookie||'');
  for(const part of raw.split(';')){
    const i=part.indexOf('=');
    if(i<0) continue;
    const k=part.slice(0,i).trim();
    const v=part.slice(i+1).trim();
    try{ out[k]=decodeURIComponent(v); }catch{ out[k]=v; }
  }
  return out;
}
function safeEqual(a,b){
  const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function signAdminPayload(payload){
  return crypto.createHmac('sha256',ADMIN_SESSION_SECRET).update(payload).digest('base64url');
}
function createAdminToken(user){
  const payload=Buffer.from(JSON.stringify({u:user.username,n:user.displayName,r:user.role,s:user.scopes||[],exp:Date.now()+ADMIN_SESSION_HOURS*3600000})).toString('base64url');
  return `${payload}.${signAdminPayload(payload)}`;
}
function readAdminSession(req){
  const token=parseCookies(req)[ADMIN_COOKIE];
  if(!token || !token.includes('.')) return null;
  const [payload,sig]=token.split('.',2);
  if(!safeEqual(sig,signAdminPayload(payload))) return null;
  try{
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!data?.u || !data?.exp || Date.now()>Number(data.exp)) return null;
    data.r=String(data.r||'secretaria'); data.s=Array.isArray(data.s)?data.s:[]; data.n=String(data.n||data.u);
    return data;
  }catch{return null;}
}
function setAdminCookie(res,token){
  const secure=String(process.env.NODE_ENV||'').toLowerCase()==='production' || String(process.env.RENDER||'').toLowerCase()==='true';
  res.setHeader('Set-Cookie',`${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_HOURS*3600}${secure?'; Secure':''}`);
}
function clearAdminCookie(res){
  res.setHeader('Set-Cookie',`${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
function requireAdminPage(req,res,next){
  const session=readAdminSession(req);
  if(!session) return res.redirect('/admin/login');
  req.admin=session; next();
}
function requireAdminApi(req,res,next){
  const session=readAdminSession(req);
  if(!session) return res.status(401).json({ok:false,error:'Sesión de Administración vencida o no iniciada'});
  req.admin=session; next();
}

function adminCanSeeAll(admin){ return ['admin','secretaria'].includes(String(admin?.r||'')); }
function handoffSearchText(item={}){
  return normalizeScope(`${item.topic||''} ${item.reason||''} ${item.message||''} ${item.name||''}`);
}
function adminCanAccessItem(admin,item={}){
  if(adminCanSeeAll(admin)) return true;
  const scopes=(admin?.s||[]).map(normalizeScope).filter(Boolean);
  if(!scopes.length) return false;
  const text=handoffSearchText(item);
  return scopes.some(scope=>text.includes(scope));
}
function requireRole(...roles){
  return (req,res,next)=> roles.includes(String(req.admin?.r||'')) ? next() : res.status(403).json({ok:false,error:'No tenés permiso para realizar esta acción'});
}

const DEFAULT_DB = {
  club: { name: 'Club All Boys', whatsapp: '2954592313' },
  members: [], activities: [], payments: [], knowledge: [], documents: [],
  sessions: [], conversations: [], pendingQueries: [], registrations: [],
  surveys: [], handoffHistory: []
};
function ensureDb(){
  const dir=path.dirname(DB_PATH);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB,null,2));
}
function db(){
  ensureDb();
  const parsed=JSON.parse(fs.readFileSync(DB_PATH,'utf8'));
  return { ...DEFAULT_DB, ...parsed };
}
function save(data){
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(data,null,2));
}
ensureDb();
function clean(t=''){ return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
function money(n){ return new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(n)||0); }
function containsAny(text, words){ return words.some(w => text.includes(clean(w))); }


// V63 - IA controlada: solo se usa cuando los menús/reglas no entienden la consulta.
// Importante: ChatGPT Plus no habilita la API. Render necesita OPENAI_API_KEY con facturación/crédito API.
function buildClubContext(data){
  const acts = (data.activities||[])
    .filter(a => a && a.active !== false)
    .slice(0, 40)
    .map(a => `- ${a.name||'Actividad'} ${a.category?`(${a.category})`:''}: ${a.days||'días a confirmar'} ${a.time||''}. Profesor: ${a.teacher||'a confirmar'}. Costo: ${a.cost ? money(a.cost) : 'consultar'}`)
    .join('\n');
  const knowledge = (data.knowledge||[])
    .slice(0, 20)
    .map(k => `- ${k.title||k.question||'Info'}: ${String(k.content||k.answer||k.text||'').slice(0,350)}`)
    .join('\n');
  return [acts ? `Actividades cargadas:\n${acts}` : '', knowledge ? `Conocimiento cargado:\n${knowledge}` : ''].filter(Boolean).join('\n\n');
}

async function responderConIAControlada(rawText, data, session){
  const apiKey = process.env.OPENAI_API_KEY;
  if(!apiKey || !String(apiKey).startsWith('sk-')) return null;
  const clubContext = buildClubContext(data);
  const system = `Sos Panchito, asistente de WhatsApp del Club All Boys de Santa Rosa, La Pampa.
Respondé en español argentino, breve, humano y claro.
Reglas obligatorias:
- No inventes horarios, precios, profesores, teléfonos ni requisitos.
- Si no estás seguro, ofrecé derivar a administración.
- Si el usuario quiere inscribirse, pedí actividad, nombre, edad y teléfono, o sugerí escribir MENÚ > Precios e inscripción.
- Si pregunta por algo sensible, urgente o reclamo importante, derivá a administración.
- No digas que sos ChatGPT ni menciones OpenAI.
- Máximo 6 líneas.

${clubContext || 'No hay datos adicionales confiables cargados.'}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try{
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        input: [
          { role: 'system', content: system },
          { role: 'user', content: String(rawText||'') }
        ],
        max_output_tokens: 220
      }),
      signal: controller.signal
    });
    const json = await r.json().catch(()=>({}));
    if(!r.ok){
      console.error('OPENAI_ERROR_STATUS:', r.status);
      console.error('OPENAI_ERROR_BODY:', JSON.stringify(json).slice(0,1200));
      return null;
    }
    const out = json.output_text || (json.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').join('\n').trim();
    return out ? out.trim() : null;
  }catch(e){
    console.error('OPENAI_ERROR_EXCEPTION:', e?.message || e);
    return null;
  }finally{
    clearTimeout(timer);
  }
}

// V43 - Motor simple de interpretación humana.
// Corrige errores comunes de escritura antes de pasar por menús y estados.
// Ejemplos: natacoin -> natacion, bascket -> basquet, volei -> voley.
const TYPO_ALIASES = {
  natacion: ['natacion','natacionn','natacio','natacoin','natacon','nataciona','natacionnn','natacino','natacoinn','natacion infantil','natasion','nataccion','natacionpileta','nata','pile','pileta','piscina','nadar','natatorio','acuagym','aquagym'],
  basquet: ['basquet','basquett','bascket','basket','basq','basquetbol','basquetball','basketball','básquet','baske','baquet','basquetbol'],
  futbol: ['futbol','fútbol','futbool','fulbo','fulbol','fubol','fut','futbol5','futbol 5','futbol infantil','escuelita futbol','escuela futbol','inferiores'],
  gimnasia: ['gimnasia','gimnacia','ginasia','gym','artistica','artística','gimnasia artistica','gimnasia artística','gimnasiaartistica'],
  softbol: ['softbol','sóftbol','sofbol','softboll','softball','sofball'],
  paleta: ['paleta','pelota paleta','pelota a paleta','pelotapaleta','pelota-paleta'],
  inscripcion: ['inscripcion','inscripción','inscribirme','inscribirte','inscribir','incripcion','inscripsion','inscricion','inscrivir','icribrte','icribirte','incribirte','inscribrte','insripcion','insripciones','incripcion','incripciones','incripsion','inscripion','anotarme','anotarte','anotarlo','anotarla','anotar','alta','sumarme'],
  cuota: ['cuota','cuotas','cutoa','cuotaa','deuda','pago','pagos','pagar','vencimiento','saldo'],
  precio: ['precio','precios','costo','costos','valor','valores','cuanto','cuánto','sale','cuanto sale','cuánto sale'],
  administracion: ['administracion','administración','admin','administrador','persona','humano','telefono','teléfono','whatsapp','wasap','wsp'],
  horarios: ['horario','horarios','orario','orarios','hario','harios','haris','horis','horaro','horaios','horarioss','dias','días','cuando','clases'],
  ubicacion: ['direccion','dirección','ubicacion','ubicación','domicilio','donde queda','dónde queda','como llego','cómo llego']
};

function levenshtein(a='', b=''){
  a = String(a); b = String(b);
  const dp = Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) dp[i][0]=i;
  for(let j=0;j<=b.length;j++) dp[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[a.length][b.length];
}

function correctWordToken(token=''){
  const w = clean(token);
  if(!w || w.length < 3) return w;
  for(const [canonical, aliases] of Object.entries(TYPO_ALIASES)){
    if(aliases.map(clean).includes(w)) return canonical;
  }
  let best = w, bestDist = 99;
  for(const [canonical, aliases] of Object.entries(TYPO_ALIASES)){
    for(const alias of aliases.map(clean)){
      if(alias.includes(' ')) continue;
      const limit = alias.length <= 5 ? 1 : 2;
      const d = levenshtein(w, alias);
      if(d < bestDist && d <= limit){
        best = canonical;
        bestDist = d;
      }
    }
  }
  return best;
}

function normalizeUserText(text=''){
  let t = clean(text);
  const phraseMap = [
    ['donde queda','ubicacion'], ['dónde queda','ubicacion'], ['como llego','ubicacion'], ['cómo llego','ubicacion'],
    ['pelota a paleta','paleta'], ['pelota paleta','paleta'],
    ['gimnasia artistica','gimnasia'], ['gimnasia artística','gimnasia'],
    ['futbol infantil','futbol'], ['fútbol infantil','futbol'], ['escuelita de futbol','futbol'],
    ['clases de natacion','natacion'], ['clases de natación','natacion'], ['natatorio ismael amit','natacion'],
    ['mercado pago','cuota'], ['medio de pago','cuota'], ['medios de pago','cuota']
  ];
  for(const [from,to] of phraseMap){
    t = t.replaceAll(clean(from), clean(to));
  }
  return t.split(/\s+/).map(correctWordToken).join(' ').replace(/\s+/g,' ').trim();
}

function correctionHint(rawText=''){
  const raw = clean(rawText);
  const fixed = normalizeUserText(rawText);
  return raw && fixed && raw !== fixed ? fixed : '';
}

function today(){ return new Date().toISOString().slice(0,10); }
function phoneDigits(value=''){ return String(value||'').replace(/\D/g,''); }
function findSessionByPhone(data, phone){
  const exact=String(phone||'');
  const digits=phoneDigits(phone);
  return (data.sessions||[]).find(x => x.phone===exact || (digits && phoneDigits(x.phone)===digits));
}
function getSession(data, phone){
  let s=findSessionByPhone(data, phone);
  if(!s){ s={phone,state:'idle',data:{},updatedAt:new Date().toISOString()}; data.sessions.unshift(s); }
  return s;
}
function setSession(s,state,extra={}){ s.state=state; s.data={...(s.data||{}),...extra}; s.updatedAt=new Date().toISOString(); }
const SESSION_TIMEOUT_MS = Math.max(1, Number(process.env.SESSION_TIMEOUT_HOURS || 6)) * 60 * 60 * 1000;
function sessionExpired(session, now=Date.now()){
  if(!session?.updatedAt) return true;
  const t=Date.parse(session.updatedAt);
  return !Number.isFinite(t) || (now-t)>SESSION_TIMEOUT_MS;
}
function resetForNewConversation(session){
  session.state='idle';
  session.data={ attentionMode:'bot', seenPanchitoIntro:false, menu:'', topic:'' };
  session.updatedAt=new Date().toISOString();
}

// V93 - Pase de atención automática a atención humana.
function isHumanMode(session){ return session?.data?.attentionMode === 'human'; }
function setAttentionMode(session, mode='bot', extra={}){
  session.data = { ...(session.data||{}), ...extra, attentionMode: mode };
  session.updatedAt = new Date().toISOString();
}
function humanModeMessage(){
  return `✅ Listo. La conversación quedó en manos de Administración.

Panchito queda pausado en este chat para no interrumpir mientras te atiende una persona.`;
}
function adminControlPin(){ return String(process.env.ADMIN_CONTROL_PIN || '2416').trim(); }
function isAdminControlCommand(rawText='', command='bot'){
  const t=String(rawText||'').trim().toLowerCase().replace(/\s+/g,' ');
  const pin=adminControlPin();
  return t===`/${command} ${pin}` || t===`${command} ${pin}`;
}
function addHandoffHistory(data, session, action, extra={}){
  data.handoffHistory = data.handoffHistory || [];
  const item={
    id:Date.now(), phone:session?.phone||'', action,
    at:new Date().toISOString(), handoffId:session?.data?.handoffId||null,
    reason:session?.data?.handoffReason||'', ...extra
  };
  data.handoffHistory.unshift(item);
  data.handoffHistory=data.handoffHistory.slice(0,1000);
  return item;
}
function botReturnedMessage(){
  return `✅ Administración finalizó la atención.

🤖 Panchito vuelve a estar disponible para ayudarte.

Escribí *MENÚ* para ver todas las opciones.`;
}
function findMember(data, value){ return (data.members||[]).find(m => m.dni === value || m.memberNo === value || clean(m.phone||'').endsWith(clean(value||''))); }

function friendlyLead(kind='general'){
  const banks = {
    general: ['Dale, te ayudo 😊', 'Perfecto, te cuento.', 'Buenísimo, vamos por partes.'],
    minor: ['Perfecto 😊 Para menores conviene ver edad, cupo y grupo disponible.', 'Dale, te oriento con las opciones para chicos/as.'],
    carnet: ['Listo, reviso la ficha de socio 🎫', 'Dale, busco el carnet digital.'],
    survey: ['Gracias por la ayuda 😊', 'Genial, me sirve para mejorar.']
  };
  const arr = banks[kind] || banks.general;
  return arr[Math.floor(Math.random()*arr.length)];
}
function askSatisfaction(s, topic='consulta'){
  s.data = { ...(s.data||{}), surveyTopic: topic };
  s.state = 'waiting_satisfaction';
  s.updatedAt = new Date().toISOString();
  return `\n\n¿Te sirvió la información?\n\nA. Sí, me sirvió\nB. Más o menos\nC. No me sirvió\n\nRespondé con A, B o C.`;
}
function saveSurvey(data, phone, score, topic='consulta', comment=''){
  data.surveys = data.surveys || [];
  const item = { id: Date.now(), phone, score:Number(score), topic, comment, createdAt:new Date().toISOString() };
  data.surveys.unshift(item);
  return item;
}
function whatsappLabelForActivity(activity=''){
  const a=clean(activity);
  if(a.includes('natatorio') || a.includes('pileta') || a.includes('natacion')) return 'Natatorio';
  if(a.includes('futbol')) return 'Fútbol';
  if(a.includes('basquet') || a.includes('basket')) return 'Básquet';
  if(a.includes('gimnasia')) return 'Gimnasia';
  return 'Administración';
}
function activityWhatsAppLine(data, activity=''){
  const label = whatsappLabelForActivity(activity);
  const raw = String(data.club?.whatsapp || '2954592313').replace(/\D/g,'');
  const phone = raw.startsWith('54') ? raw : `549${raw}`;
  const msg = `Hola, vengo derivado desde Panchito IA. Quiero consultar por ${label}.`;
  return `📲 Abrir WhatsApp ${label}: https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

function detectActivityFreeText(text=''){
  const t = normalizeUserText(text);
  if(containsAny(t,['natatorio','pileta','natacion','natación','natacoin','natacionn','nadar','clases de natacion'])) return {key:'natatorio', label:'Natatorio / pileta'};
  if(containsAny(t,['gimnasia artistica','gimnasia artística','gimnasia','artistica','artística'])) return {key:'gymnastics', label:'Gimnasia Artística'};
  if(containsAny(t,['futbol','fútbol','fubol','futbool','fulbol','inferiores','femenino sub','escuelita de futbol'])) return {key:'football', label:'Fútbol'};
  if(containsAny(t,['basquet','básquet','bascket','basquett','basket','básket','basquetbol','básquetbol'])) return {key:'basket', label:'Básquet'};
  if(containsAny(t,['softbol','sóftbol'])) return {key:'softbol', label:'Sóftbol'};
  if(containsAny(t,['pelota paleta','paleta'])) return {key:'paleta', label:'Pelota a Paleta'};
  return null;
}

function directActivityReply(data, activity, rawText='', session=null){
  const age = extractAge(rawText || '');
  if(age && session){ session.data = { ...(session.data||{}), userAge: age }; }
  const hint = ageSmartHint(age || session?.data?.userAge, activity.label);
  const t = normalizeUserText(rawText || '');
  const askingSchedule = containsAny(t,['horario','horarios','orario','orarios','dias','días','cuando','clases']);
  const askingSignup = containsAny(t,['inscripcion','inscripción','inscribir','inscribirme','anotar','anotarme','anotarlo','anotarla']);
  const askingPrice = containsAny(t,['precio','precios','costo','costos','valor','valores','cuanto','cuánto','cuanto sale','cuánto sale','cuota']);
  const askingWhatsapp = containsAny(t,['whatsapp','wasap','wsp','telefono','teléfono','administracion','administración','hablar']);
  const isOnlyFollowUp = (askingSchedule || askingSignup || askingPrice || askingWhatsapp) && !detectActivityFreeText(rawText || '');
  const intro = isOnlyFollowUp
    ? panchitoMicroPhrase()
    : `${pickRandom(['¡Buenísimo!', 'Qué buena elección', 'Perfecto', 'Dale, vamos con eso'])} Te interesa ${activity.label} 😊${hint ? `

${hint}` : ''}`;
  let body = '';
  let handledSpecificNatatorio = false;
  if(activity.key === 'natatorio') {
    if(askingSchedule){ handledSpecificNatatorio = true; if(session){ setMenuContext(session,'natatorio_after'); session.data.lastNatatorioAnswer='horarios'; } body = responseNatatorioOption(data,'horarios'); }
    else if(askingSignup){ handledSpecificNatatorio = true; if(session){ setMenuContext(session,'natatorio_after'); session.data.lastNatatorioAnswer='inscripcion'; } body = responseNatatorioOption(data,'inscripcion'); }
    else if(askingPrice){ handledSpecificNatatorio = true; if(session){ setMenuContext(session,'natatorio_after'); session.data.lastNatatorioAnswer='costos'; } body = `💲 Costos de natatorio / pileta

Para evitar pasarte un valor desactualizado, los precios y cuotas vigentes los confirma Administración o el área de Natatorio.

Puedo abrirte el WhatsApp para consultar el valor actualizado.

${adminContact(data)}${responseNatatorioNextMenu('costos')}`; }
    else if(containsAny(t,['cupo','cupos','disponible','disponibilidad'])){ handledSpecificNatatorio = true; if(session){ setMenuContext(session,'natatorio_after'); session.data.lastNatatorioAnswer='cupos'; } body = responseNatatorioOption(data,'cupos'); }
    else if(containsAny(t,['edad','edades','nivel','niveles'])){ handledSpecificNatatorio = true; if(session){ setMenuContext(session,'natatorio_after'); session.data.lastNatatorioAnswer='edades'; } body = responseNatatorioOption(data,'edades'); }
    else if(askingWhatsapp){ handledSpecificNatatorio = true; if(session){ setMenuContext(session,'natatorio_after'); session.data.lastNatatorioAnswer='whatsapp'; } body = `📲 Te dejo el contacto para consultar directo por Natatorio / pileta.

${activityWhatsAppLine(data, activity.label)}${responseNatatorioNextMenu('whatsapp')}`; }
    else body = responseNatatorioMenu(true);
  }
  else if(activity.key === 'gymnastics') body = responseGymnastics();
  else if(activity.key === 'football') { if(session){ setMenuContext(session,'football_all'); session.data.currentActivity='Fútbol'; } body = responseFootballAll(); }
  else if(activity.key === 'basket') { if(session){ setMenuContext(session,'basket_all'); session.data.currentActivity='Básquet'; } body = responseBasketAll(); }
  else if(activity.key === 'softbol') body = responseSoftbol();
  else if(activity.key === 'paleta') body = responsePaleta();
  else body = responseActivityMenu();
  let footer = '';
  // No repetimos opciones genéricas cuando todavía estamos pidiendo rama/categoría.
  // Las opciones útiles se muestran después de elegir una categoría concreta.
  if(!askingWhatsapp && handledSpecificNatatorio){
    footer = '';
  }
  return `${intro}

${body}${footer}`;
}
function carnetReply(member, data){
  const deuda = Number(member.debt||0);
  const estado = deuda > 0 ? `Pendiente - deuda ${money(deuda)}` : (member.feeStatus || 'Al día');
  const qrText = `ALLBOYS|SOCIO:${member.memberNo||member.id}|DNI:${member.dni||''}`;
  return `${friendlyLead('carnet')}\n\n🎫 Carnet digital All Boys\n\nNombre: ${member.name || '-'}\nSocio Nº: ${member.memberNo || '-'}\nDNI: ${member.dni || '-'}\nEstado de cuota: ${estado}\nActividades: ${(member.activities||[]).join(', ') || 'Sin actividades cargadas'}\n\nQR demo:\n${qrText}\n\nEste carnet queda listo para conectarlo después con una base real, foto y QR gráfico.`;
}

function addPending(data, phone, text, category='otra', note=''){
  data.pendingQueries = data.pendingQueries || [];
  const item = {
    id: Date.now(),
    phone,
    text,
    category,
    note,
    status:'Pendiente',
    assignedTo:'Administración',
    createdAt:new Date().toISOString()
  };
  data.pendingQueries.unshift(item);
  return item;
}

const FRIENDLY_WORDS = ['gracias','muchas gracias','mil gracias','perfecto gracias','listo gracias','no gracias','nada mas','nada más'];
const GREETINGS = ['hola','buen dia','buen día','buenos dias','buenos días','buenas','buenas tardes','buenas noches','que tal','qué tal','como estas','cómo estás'];
const BYE_WORDS = ['chau','hasta luego','nos vemos','adios','adiós','hasta pronto'];

function isGreetingText(t){
  const v = clean(t || '').replace(/[!¡?¿.,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(!v) return false;
  if(GREETINGS.map(clean).includes(v)) return true;
  return /^(hola|buen dia|buenos dias|buenas|buenas tardes|buenas noches|que tal|como estas)(\s+panchito|\s+bot)?$/.test(v);
}
function isSoftSocialText(t){
  const v = clean(t || '').replace(/[!¡?¿.,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(!v) return false;
  return /^(ok|okay|dale|genial|perfecto|bueno|listo|joya|barbaro|bárbaro|excelente)$/.test(v);
}
function pickRandom(arr=[]){
  if(!arr.length) return '';
  return arr[Math.floor(Math.random()*arr.length)];
}
function getArgentinaHour(){
  try{
    const parts = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const hourPart = parts.find(p => p.type === 'hour');
    let h = parseInt(hourPart?.value || '0', 10);
    if(h === 24) h = 0;
    return h;
  }catch(e){
    // Fallback: Argentina es UTC-3. Evita que Render/servidor UTC salude mal.
    return (new Date().getUTCHours() + 21) % 24;
  }
}

function timeGreeting(){
  const h = getArgentinaHour();
  if(h >= 5 && h < 12) return '¡Buen día!';
  if(h >= 12 && h < 20) return '¡Buenas tardes!';
  return '¡Buenas noches!';
}
function panchitoMicroPhrase(kind='general'){
  const banks = {
    general: [
      'Dale, te ayudo 😊','Perfecto, vamos por partes.','Buenísimo, lo vemos.','Listo, te oriento.','De una, Panchito al rescate 😄','Vamos con eso 💙','Joya, sigo atento.',
      'Tranqui, bajamos la consulta al piso y salimos jugando ⚽','Ahí voy, con la camiseta bien puesta 💙','Dale que esta consulta la sacamos jugando 😄','Estoy para darte una mano, como buen asistidor 🏟️',
      'Recibido, la paro de pecho y te respondo ⚽','Dale, hacemos dos pases y lo ordenamos 😄','Vamos con calma, sin pelotazos largos.','Te sigo la jugada 💙','Estoy en modo asistidor, mandame la consulta.',
      'Vamos a resolverlo como equipo 🏟️','Dale, buena consulta.','Joya, lo encaramos.','Perfecto, vamos al grano.','De una, te acompaño.','Listo, sale pase corto y claro ⚽'
    ],
    actividades: [
      'Vamos a mirar las actividades, como fixture de fin de semana 🏟️','Dale, abrimos la lista de disciplinas.','Te muestro las opciones cargadas del club 💙','Vamos con el menú deportivo ⚽🏀🏊',
      'Elegí la disciplina y te tiro el pase con horarios o inscripción.','Acá Panchito juega de coordinador de actividades 😄','Acomodamos las actividades en cancha y seguimos.'
    ],
    inscripcion: [
      'Dale, arrancamos la inscripción sin vueltas 📝','Vamos con los datos, pase a pase 😄','Perfecto, armamos la solicitud prolija.','Empezamos tranqui: te voy pidiendo solo lo necesario.',
      'Golazo, vamos a cargar la inscripción.','No te preocupes, si algo sale mal lo corregimos sin empezar de cero.','Panchito de mesa de entrada: cargamos los datos y seguimos 💙'
    ],
    cuotas: [
      'Vamos con cuotas y pagos 💳','Revisamos esa parte sin hacer fulbito financiero 😄','Dale, vemos el tema pagos.','Te oriento con cuotas, deuda o medios de pago.',
      'Abrimos la planilla mental de Panchito 💳','Vamos a dejar claro el tema plata, sin marearte.'
    ],
    natatorio: [
      'Nos tiramos al agua 🏊','Vamos con Natatorio / pileta.','Dale, modo antiparras activado 😄','Te cuento lo que haya cargado de pileta.',
      'Vamos a nadar entre horarios, cupos e inscripción 🏊','Panchito se pone la malla y te ayuda 😄'
    ],
    administracion: [
      'Dale, te acerco con administración 👨‍💼','Esto lo puede confirmar mejor una persona del club.','Te hago el pase a administración como un 10 😄','Vamos directo con el contacto correcto.',
      'Cuando hace falta humano, Panchito no gambetea: deriva 💙'
    ],
    reclamos: [
      'Te escucho, lo cargamos con respeto 💬','Dale, contame qué pasó y lo dejamos registrado.','Vamos a tomar el reclamo sin vueltas.','Lo importante es que quede claro para que el club pueda revisarlo.',
      'Panchito toma nota, sin silbato pero atento 😄'
    ],
    prensa: [
      'Dale, vamos con prensa, CV, proveedores o propuestas 📩','Te ayudo a dejar esa propuesta bien encaminada.','Mandame la idea y la ordenamos.','Vamos con esa consulta especial.'
    ],
    gracias: [
      'De nada, crack 😄','Para eso estoy 💙','Un gusto ayudarte.','Golazo que sirvió ⚽','Cuando necesites, Panchito vuelve a la cancha.','Joya, abrazo de club 💙'
    ]
  };
  const arr = banks[kind] || banks.general;
  return pickRandom(arr);
}

function panchitoIntroFunny(){
  const frases = [
    'Prometo ayudarte más rápido que un contraataque ⚽😄','No soy Messi, pero con las consultas me defiendo bastante bien 😄','Vos preguntá tranquilo, yo hago el precalentamiento de respuestas 🏃‍♂️',
    'En All Boys no prometo goles, pero sí buena información 💙','Estoy más atento que arquero en penal 🥅','Acá no cobramos offside por preguntar ⚽','Preguntá sin miedo, que yo juego de asistidor 😄',
    'Mientras vos escribís, yo ya estoy buscando la respuesta 🔎','Hoy vengo con botines nuevos para responder mejor 😄','Si la consulta viene complicada, la bajamos al piso y salimos jugando ⚽',
    'No tengo camiseta transpirada, pero sí muchas ganas de ayudar 💙','Estoy listo para darte una mano, como buen 10 armador 🏟️','No prometo gambetas, pero sí orientarte lo mejor posible 😄',
    'Preguntame tranquilo: acá el VAR no anula consultas 😂','Vamos paso a paso, sin pelotazos largos ⚽','Yo te acompaño; los goles los hacen ustedes 💙','Estoy en modo club: información, buena onda y respuesta rápida 😄',
    'Arrancamos cuando quieras, yo ya hice entrada en calor 🏃‍♂️','Si querés horarios, cuotas o inscripción, te tiro un pase filtrado 😄','Consultame lo que necesites, que para eso entré a la cancha ⚽',
    'Hoy Panchito está titular: preguntá nomás 😄','Te atiendo con más ganas que tribuna en clásico 💙','La consulta que venga, la paramos de pecho y respondemos claro ⚽',
    'Acá la buena onda juega de local 🏟️','Si hace falta, te hago el pase a administración como un 10 😄','No vendo humo: te oriento y, si hace falta, te derivo al club 💙',
    'Soy suplente de lujo para las dudas del club 😄','Vengo sin silbato, pero con respuestas claras.','No prometo campeonato, prometo orientarte bien 🏆','La consulta entra por derecha y sale respondida por izquierda ⚽',
    'Panchito no se lesiona: responde todo el día 😄','Si no sé algo, no invento: te paso con administración.','Acá jugamos simple: preguntás y te oriento.','Buena onda, información y cero vueltas 💙'
  ];
  return pickRandom(frases);
}

function panchitoMenuBackFunny(){
  return pickRandom([
    'Volvimos al menú principal, sin hacer conferencia de prensa 😄','De nuevo al banco de suplentes del menú. ¿Qué jugada hacemos ahora? ⚽','Menú principal otra vez, pero sin presentación repetida: ya somos conocidos 💙',
    'Volvemos al inicio de la cancha. Elegí la próxima jugada 🏟️','Listo, reseteamos la jugada y salimos jugando.','Otra vez en el menú, como saque del medio 😄','Dale, volvemos al menú. Panchito sigue atento.',
    'Menú principal listo. No me presento de nuevo porque ya entré en calor 😄','Volvemos al tablero táctico. ¿Qué opción querés?','Joya, volvimos al menú. Elegí y seguimos.',
    'Pausa técnica y menú principal. ¿Para dónde encaramos?','Volvimos a foja cero, pero sin perder la buena onda 💙','Menú principal en cancha. Tirame una letra o consulta.',
    'Rearmamos la jugada desde el menú principal ⚽','Dale, otra jugada. ¿Qué necesitás ahora?','Volvimos al menú como buen pase atrás para ordenar 😄'
  ]);
}

function greetingMessage(){
  return panchitoMenu('inicio');
}

function finalCloseMessage(){
  return `🔵🟡 ¡Muchas gracias por comunicarte con el Club All Boys! 🟡🔵

Fue un gusto poder ayudarte.

Estoy para ayudarte siempre que lo necesites.

📩 Escribí MENÚ para volver al inicio o enviame tu consulta cuando quieras.

💙💛 ¡Te esperamos en el club!`;
}
function softSocialMessage(s){
  const topic = (currentTopic(s) || s.data?.currentActivity || '').trim();
  if(topic){
    return `${panchitoMicroPhrase()}

Seguimos con ${topic}. Podés pedirme horarios, inscripción, costos, profesor o WhatsApp.`;
  }
  return panchitoMenu('volver');
}
function isThanksText(t){
  const v = clean(t || '');
  if(!v) return false;
  // Solo cierra conversación con agradecimientos/despedidas reales.
  // No cerramos con "ok", "dale", "genial" o "perfecto" porque pueden ser respuestas de avance.
  return FRIENDLY_WORDS.map(clean).includes(v)
    || /(^|\b)(gracias|muchas gracias|mil gracias|no gracias|listo gracias|perfecto gracias|nada mas)(\b|$)/.test(v);
}
function isByeText(t){
  const v = clean(t || '');
  if(!v) return false;
  return BYE_WORDS.map(clean).includes(v) || /(^|\b)(chau|hasta luego|nos vemos|adios|hasta pronto)(\b|$)/.test(v);
}
function thanksCloseMessage(){
  return `⭐ ${panchitoMicroPhrase('gracias')}

¿Te sirvió la información?

A. ✅ Sí, me sirvió
B. 🟡 Más o menos
C. ❌ No me sirvió

Respondé con A, B o C.
También podés escribir OMITIR.`;
}
function panchitoMenu(mode='volver'){ return v103MainMenu(mode); }
function adminContact(data){ return V103_CONTACTS.secretaria; }


function outsideHoursMessage(){
  return `📨 Tu consulta quedó registrada.

Apenas Administración esté disponible, se pondrá en contacto con vos.

Mientras tanto, si necesitás otra información, escribí MENÚ y con gusto voy a ayudarte.

${adminContact({})}`;
}

function signupStepPrompt(step, draft={}){
  const title = draft.category || draft.activity || 'la actividad';
  const prompts = {
    name: `Para iniciar la inscripción en ${title}, necesito algunos datos.\n\n1/8 ¿Cuál es el nombre y apellido de la persona que desea inscribirse?`,
    age: `2/8 ¿Qué edad tiene o cuál es su fecha de nacimiento?`,
    dni: `3/8 Pasame el DNI de la persona que se quiere inscribir.\n\nSi no lo tenés ahora, escribí OMITIR.`,
    socio: `4/8 ¿Ya es socio/a del club?\n\nA. Sí\nB. No\nC. No sé`,
    phone: `5/8 Pasame un teléfono de contacto para que administración pueda confirmar cupo y requisitos.`,
    email: `6/8 ¿Tenés un mail de contacto?\n\nSi no querés cargarlo, escribí OMITIR.`,
    notes: `7/8 ¿Querés agregar alguna observación?\n\nEjemplos: turno preferido, experiencia previa, apto médico, lesión, consulta especial.\n\nSi no hay observaciones, escribí NO.`,
    confirm: `8/8 Revisá los datos.\n\n${signupSummary(draft)}\n\n¿Confirmás la solicitud?\n\nA. Confirmar\nB. Modificar nombre\nC. Modificar edad\nD. Modificar teléfono\nE. Cancelar`
  };
  return prompts[step] || prompts.dni;
}

function startSignupFlow(data, s, activity='', category=''){
  const detail = s.data?.disciplineDetail || {};
  const draft = {
    ...(s.data?.signupDraft || {}),
    activity: activity || detail.activity || s.data?.currentActivity || 'Actividad',
    category: category || detail.title || s.data?.currentCategory || 'Categoría a confirmar',
    source: 'Panchito'
  };

  if(s.data?.userAge && !draft.age) draft.age = `${s.data.userAge} años`;
  if(s.data?.userBirthYear && !draft.birthYear) draft.birthYear = s.data.userBirthYear;
  if(s.data?.userBranch && !draft.branch) draft.branch = s.data.userBranch;

  s.data.signupDraft = draft;

  // Si ya tenemos la edad por conversación inteligente, saltamos directo al DNI.
  setMenuContext(s, draft.name ? (draft.age ? 'signup_dni' : 'signup_age') : 'signup_name');

  return `Perfecto. Vamos a iniciar una solicitud de inscripción 📝

Actividad: ${s.data.signupDraft.activity}
Categoría: ${s.data.signupDraft.category}${s.data.signupDraft.age ? `\nEdad detectada: ${s.data.signupDraft.age}` : ''}

${signupStepPrompt(getMenuContext(s).replace('signup_',''), s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
}

function signupSummary(draft={}){
  return `📋 Solicitud de inscripción

Nombre: ${draft.name || '-'}
Edad / fecha de nacimiento: ${draft.age || '-'}
DNI: ${draft.dni || '-'}
Socio/a: ${draft.memberStatus || '-'}
Teléfono: ${draft.phone || '-'}
Mail: ${draft.email || '-'}
Actividad: ${draft.activity || '-'}
Categoría recomendada: ${draft.category || '-'}
Observaciones: ${draft.notes || '-'}`;
}


function normalizePhoneForDuplicate(value=''){
  return String(value||'').replace(/\D/g,'').replace(/^549?/,'');
}

function normalizeActivityForDuplicate(value=''){
  return clean(value||'').replace(/\s+/g,' ');
}

function findDuplicateRegistration(data, phone, draft={}){
  const regs = data.registrations || [];
  const draftActivity = normalizeActivityForDuplicate(draft.activity || '');
  const draftPhone = normalizePhoneForDuplicate(draft.phone || phone || '');
  const draftDni = String(draft.dni || '').replace(/\D/g,'');
  const draftName = clean(draft.name || '');
  return regs.find(r => {
    const st = clean(r.status || 'Pendiente');
    if(st === 'cancelada' || st === 'anulada') return false;
    const sameActivity = normalizeActivityForDuplicate(r.activity || '') === draftActivity;
    if(!sameActivity) return false;
    const rPhone = normalizePhoneForDuplicate(r.phone || '');
    const rDni = String(r.dni || '').replace(/\D/g,'');
    const rName = clean(r.name || '');
    return (draftDni && rDni && draftDni === rDni) ||
           (draftPhone && rPhone && (draftPhone.endsWith(rPhone) || rPhone.endsWith(draftPhone))) ||
           (draftName && rName && draftName === rName);
  });
}

function updateDuplicateRegistration(existing, draft={}){
  if(!existing) return null;
  existing.updatedAt = new Date().toISOString();
  existing.status = existing.status === 'Confirmada' ? 'Confirmada' : 'Pendiente actualización';
  existing.name = draft.name || existing.name || '';
  existing.age = draft.age || existing.age || '';
  existing.birthYear = draft.birthYear || existing.birthYear || '';
  existing.dni = draft.dni || existing.dni || '';
  existing.memberStatus = draft.memberStatus || existing.memberStatus || '';
  existing.phone = draft.phone || existing.phone || '';
  existing.email = draft.email || existing.email || '';
  existing.activity = draft.activity || existing.activity || '';
  existing.category = draft.category || existing.category || '';
  existing.branch = draft.branch || existing.branch || '';
  existing.notes = draft.notes || existing.notes || 'Datos actualizados desde Panchito';
  existing.lastUpdateSource = 'Panchito';
  return existing;
}

function isSignupSideQuestion(text=''){
  const t = normalizeUserText(text);
  return containsAny(t, [
    'horario','horarios','dias','días','dia','día','cuando','clases',
    'precio','precios','cuota','cuotas','valor','valores','cuanto sale','cuánto sale','costo','costos',
    'profesor','profesora','profe','entrenador','entrenadora',
    'requisito','requisitos','documentacion','documentación','apto medico','apto médico','cupos','cupo',
    'whatsapp','wasap','wsp','telefono','teléfono','administracion','administración'
  ]);
}

function signupSideAnswer(data, s, rawText=''){
  const draft = s.data?.signupDraft || {};
  const activity = draft.activity || s.data?.currentActivity || 'la actividad';
  const category = draft.category || s.data?.currentCategory || '';
  const t = normalizeUserText(rawText);
  const matches = (data.activities||[]).filter(a =>
    a && a.active !== false && clean(a.name||'') === clean(activity||'') && (!category || clean(a.category||'') === clean(category||''))
  );
  const anyActivity = (data.activities||[]).filter(a => a && a.active !== false && clean(a.name||'') === clean(activity||''));
  const rows = (matches.length ? matches : anyActivity).slice(0,3);

  if(containsAny(t,['precio','precios','cuota','cuotas','valor','valores','cuanto sale','cuánto sale','costo','costos'])){
    const withCost = rows.find(a => Number(a.cost||0) > 0);
    if(withCost) return `💰 Para ${activity}${category ? ` (${category})` : ''}, el valor cargado es ${money(withCost.cost)}. Igual administración confirma el valor vigente.`;
    return `💰 Para ${activity}, el valor lo confirma administración para evitar pasarte un precio desactualizado.`;
  }
  if(containsAny(t,['horario','horarios','dias','dia','cuando','clases'])){
    if(rows.length){
      return `🕒 Horarios cargados para ${activity}:\n` + rows.map(a => `• ${a.category||'Categoría'}: ${a.days||'días a confirmar'} ${a.time||''}`.trim()).join('\n');
    }
    return `🕒 Los horarios de ${activity} los confirma administración según categoría, cupo y temporada.`;
  }
  if(containsAny(t,['profesor','profesora','profe','entrenador','entrenadora'])){
    const withTeacher = rows.find(a => a.teacher);
    if(withTeacher) return `👨‍🏫 Profesor/a de ${activity}: ${withTeacher.teacher}.`;
    return `👨‍🏫 El profesor/a de ${activity} lo confirma administración.`;
  }
  if(containsAny(t,['requisito','requisitos','documentacion','documentación','apto medico','apto médico','cupos','cupo'])){
    return `📌 Para ${activity}, administración confirma cupo, documentación y requisitos finales. Si corresponde, pueden pedir apto médico o datos del responsable.`;
  }
  if(containsAny(t,['whatsapp','wasap','wsp','telefono','teléfono','administracion','administración'])){
    return adminSignupWhatsAppLine(data, draft);
  }
  return `Te contesto eso y seguimos con la inscripción: para ${activity}, administración confirma la información vigente.`;
}

function signupPromptForCurrentMenu(menu, draft={}){
  const map = {
    signup_name:'name', signup_age:'age', signup_dni:'dni', signup_socio:'socio', signup_phone:'phone', signup_email:'email', signup_notes:'notes', signup_confirm:'confirm',
    signup_edit_name:'edit_name', signup_edit_age:'edit_age', signup_edit_phone:'edit_phone', signup_edit_dni:'edit_dni', signup_edit_email:'edit_email', signup_edit_activity:'edit_activity', signup_edit_notes:'edit_notes'
  };
  const prompts = {
    edit_name:'Escribime únicamente el nuevo nombre y apellido.',
    edit_age:'Escribime la nueva edad o fecha de nacimiento.',
    edit_phone:'Escribime el nuevo teléfono de contacto.',
    edit_dni:'Escribime el nuevo DNI, o poné OMITIR.',
    edit_email:'Escribime el nuevo mail, o poné OMITIR.',
    edit_activity:'Escribime el nuevo deporte o actividad. Ejemplo: Softbol, Fútbol, Básquet, Natatorio.',
    edit_notes:'Escribime la nueva observación, o poné NO.'
  };
  const key = map[menu] || 'confirm';
  return prompts[key] || signupStepPrompt(key, draft);
}

function signupWhatsAppLink(data, draft={}){
  const rawPhone = String(draft.phone || '').replace(/\D/g,'');
  const phone = rawPhone.startsWith('54') ? rawPhone : `549${rawPhone}`;
  const msg = `Hola ${draft.name || ''}, te escribimos desde All Boys por tu solicitud de inscripción.\nActividad: ${draft.activity || ''}\nCategoría: ${draft.category || ''}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

function adminSignupWhatsAppLine(data, draft={}){
  const raw = String(data.club?.whatsapp || '2954592313').replace(/\D/g,'');
  const phone = raw.startsWith('54') ? raw : `549${raw}`;
  const msg = `Hola, vengo desde Panchito IA. Quiero confirmar una solicitud de inscripción.\n\n${signupSummary(draft).replace(/📋 /g,'')}`;
  return `📲 Enviar solicitud por WhatsApp: https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

function addRegistration(data, phone, draft={}){
  data.registrations = data.registrations || [];
  const item = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    status: 'Pendiente',
    name: draft.name || '',
    age: draft.age || '',
    birthYear: draft.birthYear || '',
    dni: draft.dni || '',
    memberStatus: draft.memberStatus || '',
    phone: draft.phone || phone || '',
    email: draft.email || '',
    activity: draft.activity || '',
    category: draft.category || '',
    branch: draft.branch || '',
    source: draft.source || 'Panchito',
    notes: draft.notes || 'Solicitud cargada desde el asistente virtual'
  };
  data.registrations.unshift(item);
  return item;
}

function registrationStatusLabel(status='Pendiente'){
  return ['Pendiente','Confirmada','Sin cupo','Finalizada'].includes(status) ? status : 'Pendiente';
}

function afterResultMenu(){
  return `

¿Qué querés hacer ahora?
A. 🔙 Volver a categorías
B. 🏅 Volver a actividades
C. 🏠 Menú principal
D. 💬 Realizar otra consulta`;
}

function disciplineFollowUpKind(text=''){
  const t = normalizeUserText(text);
  if(containsAny(t,['horario','horarios','dias','dia','cuando','clases'])) return 'schedule';
  if(containsAny(t,['profesor','profesora','profe','entrenador','entrenadora','docente'])) return 'teacher';
  if(containsAny(t,['precio','precios','cuota','cuotas','valor','valores','sale','costo','costos','cuanto sale'])) return 'price';
  if(containsAny(t,['inscripcion','inscripciones','inscribir','inscribirme','inscribirte','anotar','anotarme','anotarte','alta','sumarme'])) return 'inscription';
  if(containsAny(t,['whatsapp','wasap','wsp','telefono','administracion','administración','hablar','persona'])) return 'admin';
  if(containsAny(t,['volver','categoria','categorias','categoría','categorías','atras','atrás'])) return 'back';
  if(containsAny(t,['menu','menú','inicio','principal'])) return 'menu';
  if(containsAny(t,['otra consulta','consultar otra','nuevo tema'])) return 'free';
  return '';
}

function disciplineNextOptions(lastKind=''){
  const opts = [];
  if(lastKind !== 'schedule') opts.push(['schedule','📅 Horarios']);
  if(lastKind !== 'teacher') opts.push(['teacher','👨‍🏫 Profesor/a']);
  if(lastKind !== 'price') opts.push(['price','💰 Precio/cuota']);
  if(lastKind !== 'inscription') opts.push(['inscription','📝 Inscripción']);
  opts.push(['admin','📲 WhatsApp / Administración']);
  opts.push(['back','🔙 Volver a categorías']);
  opts.push(['menu','🏠 Menú principal']);
  return opts;
}

function disciplineNextMenu(lastKind=''){
  const letters = 'ABCDEFGH'.split('');
  const opts = disciplineNextOptions(lastKind);
  return `

¿Qué más querés consultar de esta categoría?
${opts.map((o,i)=>`${letters[i]}. ${o[1]}`).join('\n')}`;
}

function disciplineAfterOptionByLetter(lastKind='', letter=''){
  const idx = 'ABCDEFGH'.indexOf(String(letter||'').toUpperCase());
  if(idx < 0) return '';
  const opt = disciplineNextOptions(lastKind)[idx];
  return opt ? opt[0] : '';
}


function afterGeneralMenu(){
  return `

¿Qué querés hacer ahora?
A. 🔙 Volver
B. 🏠 Menú principal
C. 💬 Otra consulta`;
}

function backMenuReply(back){
  return back === 'gymnastics' ? responseGymnastics('back')
    : back === 'softbol' ? responseSoftbol('back')
    : back === 'paleta' ? responsePaleta('back')
    : back === 'basket_fem' ? responseBasketFemenino('back')
    : back === 'basket_masc' ? responseBasketMasculino('back')
    : back === 'basket_init' ? responseBasketInicial('back')
    : back === 'basket' ? responseBasketMenu('back')
    : back === 'football_years' ? responseFootballMenu('back')
    : back === 'football' ? responseFootballMenu('back')
    : responseActivityMenu();
}

function documentSearch(data, text){
  const words = clean(text).split(/\s+/).filter(w=>w.length>3);
  let best=null, score=0;
  for(const d of (data.documents||[])){
    const body = clean((d.title||'')+' '+(d.content||''));
    const s = words.reduce((acc,w)=>acc+(body.includes(w)?1:0),0);
    if(s>score){ best=d; score=s; }
  }
  return score ? best : null;
}


function onlyDigits(t=''){ return String(t).replace(/\D/g,''); }
function looksLikeDniOrSocio(raw=''){
  const d = onlyDigits(raw);
  return d.length >= 4 && d.length <= 12;
}
function notFoundMemberReply(value){
  return `No encontré una ficha asociada a ${value}.

Puede ser que el DNI o número de socio esté mal escrito, o que todavía no esté cargado en el sistema.

Podés pasarme otro número y lo reviso, o escribir “administración” para hablar con una persona del club.`;
}

function isAffirmative(text){ return containsAny(text,['si','sí','dale','ok','bueno','quiero','me interesa','claro','por favor']); }
function isMinorQuery(text){ return containsAny(text,['hijo','hija','nene','nena','niño','niña','chico','chica','menor','8 años','9 años','10 años','para mi hijo','para mi hija']); }
function extractAge(text=''){
  const t = clean(text);
  const m = t.match(/(\d{1,2})\s*(años|anos|añs|ans|año|ano)/i) || t.match(/tiene\s*(\d{1,2})/i);
  if(!m) return null;
  const age = Number(m[1]);
  return age > 0 && age < 100 ? age : null;
}


// V49 - Recomendador de categoría por edad/año de nacimiento.
function extractAgeOrBirthYear(text=''){
  const t = clean(text);
  const yearMatch = t.match(/\b(20\d{2}|19\d{2})\b/);
  const nowYear = new Date().getFullYear();
  if(yearMatch){
    const y = Number(yearMatch[1]);
    const age = nowYear - y;
    if(age > 0 && age < 100) return { age, birthYear:y, source:'year' };
  }
  const age = extractAge(text);
  if(age) return { age, birthYear: nowYear - age, source:'age' };
  const only = t.match(/^\d{1,2}$/);
  if(only){
    const a = Number(only[0]);
    if(a > 0 && a < 100) return { age:a, birthYear: nowYear - a, source:'age' };
  }
  return null;
}


// V67 - Detecta edición natural dentro de una inscripción.
function detectSignupEditIntent(rawText=''){
  const t = normalizeUserText(rawText);
  const out = { field:'', value:'' };
  if(containsAny(t,['edad','años','anos','año','ano','nacio','nació','nacimiento'])) out.field = 'age';
  else if(containsAny(t,['telefono','teléfono','celular','wsp','whatsapp','wasap'])) out.field = 'phone';
  else if(containsAny(t,['dni','documento'])) out.field = 'dni';
  else if(containsAny(t,['mail','email','correo'])) out.field = 'email';
  else if(containsAny(t,['deporte','actividad','disciplina'])) out.field = 'activity';
  else if(containsAny(t,['observacion','observación','nota','comentario'])) out.field = 'notes';
  else if(containsAny(t,['nombre','apellido','se llama'])) out.field = 'name';
  const wantsEdit = containsAny(t,['me equivoque','me equivoqué','equivocado','equivocada','corregi','corregí','corregime','cambia','cambiá','cambiar','modifica','modificá','editar','edita','editá','actualiza','actualizá','esta mal','está mal','no era','quise poner','puse mal','es ']);
  if(!out.field || !wantsEdit) return null;
  let value = String(rawText || '').trim()
    .replace(/^(me\s+)?(equivoque|equivoqué|equivocado|equivocada|corregi|corregí|corregime|cambia|cambiá|cambiar|modifica|modificá|editar|edita|editá|actualiza|actualizá)\s*(el|la|los|las)?\s*/i,'')
    .replace(/^(nombre|apellido|edad|telefono|teléfono|celular|dni|documento|mail|email|correo|deporte|actividad|disciplina|observacion|observación|nota|comentario)\s*(es|era|:|-)?\s*/i,'')
    .replace(/^(no\s+era|quise\s+poner|puse\s+mal)\s*/i,'')
    .trim();
  if(out.field === 'age'){
    const info = extractAgeOrBirthYear(rawText);
    if(info) value = String(info.source === 'year' ? info.birthYear : info.age);
  }
  if(out.field === 'phone' || out.field === 'dni'){
    const nums = String(rawText).match(/\d{4,15}/g);
    if(nums && nums.length) value = nums[nums.length-1];
  }
  if(!value || value.length > 120) value = String(rawText || '').trim();
  out.value = value;
  return out;
}

function applySignupEditIntent(data, s, edit){
  if(!edit || !edit.field) return '';
  s.data.signupDraft = s.data.signupDraft || {};
  const draft = s.data.signupDraft;
  const v = edit.value || '';
  if(edit.field === 'name'){ draft.name = v; return '✅ Listo, actualicé el nombre.'; }
  if(edit.field === 'phone'){ draft.phone = v; return '✅ Listo, actualicé el teléfono.'; }
  if(edit.field === 'dni'){ draft.dni = String(v).replace(/\D/g,'') || v; return '✅ Listo, actualicé el DNI.'; }
  if(edit.field === 'email'){ draft.email = v; return '✅ Listo, actualicé el mail.'; }
  if(edit.field === 'notes'){ draft.notes = containsAny(normalizeUserText(v),['no','ninguna','sin observaciones','omitir']) ? '' : v; return '✅ Listo, actualicé las observaciones.'; }
  if(edit.field === 'age'){
    draft.age = v;
    const advice = validateAndApplySignupAge(data, s, v || edit.value || '');
    return `✅ Listo, actualicé la edad.${advice || (draft.category ? `

Categoría recomendada ahora: **${draft.category}**.` : '')}`;
  }
  if(edit.field === 'activity'){
    const act = detectActivityFreeText(v) || detectActivityFreeText(edit.value || '');
    if(!act) return 'No pude ubicar esa actividad. Escribime por ejemplo: Softbol, Fútbol, Básquet, Natatorio o Gimnasia.';
    draft.activity = act.label; s.data.currentActivity = act.label;
    const info = extractAgeOrBirthYear(draft.age || '');
    if(info){ const rec = phase6RecommendRule(data, act.label, info, draft.branch || s.data.userBranch || ''); draft.category = rec?.label || 'Categoría a confirmar'; draft.branch = rec?.branch || draft.branch || ''; }
    else draft.category = 'Categoría a confirmar';
    return `✅ Listo, actualicé la actividad a ${draft.activity}.`;
  }
  return '';
}

function contextFollowUpReply(data, s, rawText=''){
  const activity = s.data?.currentActivity || s.data?.signupDraft?.activity || '';
  const detail = s.data?.disciplineDetail || {};
  const menu = getMenuContext(s);
  if(!activity || String(menu||'').startsWith('signup_')) return '';
  const t = normalizeUserText(rawText);
  const asksSomething = containsAny(t,['horario','horarios','dias','dia','cuando','precio','cuota','cuanto','costo','profesor','profe','inscripcion','inscribir','anotar','telefono','whatsapp','administracion']);
  const mentionsNewActivity = !!detectActivityFreeText(rawText);
  if(!asksSomething || mentionsNewActivity) return '';
  if(detail && detail.activity){
    const kind = disciplineFollowUpKind(rawText);
    if(kind && !['back','menu'].includes(kind)) return disciplineAnswer(data, s, kind);
  }
  if(containsAny(t,['precio','precios','cuota','cuotas','valor','valores','cuanto','costo'])){
    const rows = (data.activities||[]).filter(a => a.active !== false && activityMatchesName(a, activity));
    const costs = [...new Set(rows.map(a => Number(a.cost||0)).filter(n => n>0).map(n => money(n)))];
    if(costs.length) return `💰 Para ${activity}, los valores cargados son: ${costs.slice(0,4).join(' / ')}.\n\nPuede variar según categoría o temporada, así que administración confirma el valor vigente.`;
    return `💰 Para ${activity}, el valor puede depender de la categoría o cupo. Administración confirma el precio vigente.`;
  }
  if(containsAny(t,['horario','horarios','dias','dia','cuando','clases'])){
    const rows = (data.activities||[]).filter(a => a.active !== false && activityMatchesName(a, activity)).slice(0,6);
    if(rows.length) return `🕒 Horarios cargados para ${activity}:\n` + rows.map(a => `• ${a.category||'Categoría'}: ${a.days||'días a confirmar'} ${a.time||''}`.trim()).join('\n');
    return `🕒 Para ${activity}, los horarios dependen de la categoría. Administración confirma los días y cupos vigentes.`;
  }
  const fakeSession = { data:{ currentActivity: activity, currentCategory: s.data?.currentCategory || '' } };
  const detected = detectActivityFreeText(activity) || { label: activity, key: '' };
  return directActivityReply(data, detected, rawText, fakeSession);
}

function categoryRule(activity='', category=''){
  const a = clean(activity);
  const c = clean(category);
  if(a.includes('gimnasia')){
    if(c.includes('pulga') || c.includes('pulguita')) return {label:'Pulguitas (3 y 4 años)', minAge:3, maxAge:4, branch:'mixto'};
    if(c.includes('escuela')) return {label:'Escuela (5 a 7 años)', minAge:5, maxAge:7, branch:'mixto'};
    if(c.includes('promocional')) return {label:'Promocional (8 a 10 años)', minAge:8, maxAge:10, branch:'mixto'};
    if(c.includes('pre feder')) return {label:'Pre federadas (11 años en adelante)', minAge:11, maxAge:99, branch:'mixto'};
    if(c.includes('federad')) return {label:'Federadas', minAge:8, maxAge:99, branch:'mixto'};
  }
  if(a.includes('basquet')){
    const branch = c.includes('femenino') ? 'femenino' : c.includes('masculino') ? 'masculino' : 'mixto';
    if(c.includes('sub 17') && c.includes('primera')) return {label: branch === 'femenino' ? 'Básquet Femenino Sub 17 / Primera' : 'Básquet Sub 17 / Primera', minAge:16, maxAge:99, branch};
    if(c.includes('sub 13') && c.includes('sub 15')) return {label: branch === 'femenino' ? 'Básquet Femenino Sub 13 / Sub 15' : 'Básquet Sub 13 / Sub 15', minAge:12, maxAge:15, branch};
    if(c.includes('sub 9')) return {label: branch === 'mixto' ? 'Básquet Sub 9' : `Básquet ${branch === 'masculino' ? 'Masculino' : 'Femenino'} Sub 9`, minAge:6, maxAge:9, branch};
    if(c.includes('sub 11')) return {label: branch === 'mixto' ? 'Básquet Sub 11' : `Básquet ${branch === 'masculino' ? 'Masculino' : 'Femenino'} Sub 11`, minAge:10, maxAge:11, branch};
    if(c.includes('sub 13')) return {label: branch === 'mixto' ? 'Básquet Sub 13' : `Básquet ${branch === 'masculino' ? 'Masculino' : 'Femenino'} Sub 13`, minAge:12, maxAge:13, branch};
    if(c.includes('sub 15')) return {label: branch === 'mixto' ? 'Básquet Sub 15' : `Básquet ${branch === 'masculino' ? 'Masculino' : 'Femenino'} Sub 15`, minAge:14, maxAge:15, branch};
    if(c.includes('sub 17')) return {label: branch === 'mixto' ? 'Básquet Sub 17' : `Básquet ${branch === 'masculino' ? 'Masculino' : 'Femenino'} Sub 17`, minAge:16, maxAge:17, branch};
    if(c.includes('primera')) return {label: branch === 'femenino' ? 'Básquet Femenino Primera' : 'Primera división', minAge:18, maxAge:99, branch};
    if(c.includes('asociativo')) return {label:'Básquet Asociativo', minAge:15, maxAge:99, branch:'mixto'};
    if(c.includes('escuelita') || c.includes('mosquito')) return {label:'Escuelita / Mosquitos', minAge:4, maxAge:8, branch:'mixto'};
  }
  if(a.includes('futbol')){
    if(c.includes('femenino')) return {label:'Femenino Sub 12 y Sub 14', minAge:11, maxAge:14, branch:'femenino'};
    // En fútbol, las categorías sin la palabra femenino corresponden al recorrido masculino/infantiles.
    if(c.includes('cuarta') || c.includes('quinta') || c.includes('sexta')) return {label:'Cuarta, Quinta y Sexta División', minAge:15, maxAge:18, branch:'masculino'};
    if(c.includes('septima') || c.includes('octava')) return {label:'Séptima y Octava División', minAge:13, maxAge:14, branch:'masculino'};
    if(c.includes('novena') || c.includes('decima')) return {label:'Novena y Décima División', minAge:11, maxAge:12, branch:'masculino'};
    if(c.includes('2017')) return {label:'Categoría 2017', years:[2017], branch:'masculino'};
    if(c.includes('2018')) return {label:'Categoría 2018', years:[2018], branch:'masculino'};
    if(c.includes('2019')) return {label:'Categoría 2019', years:[2019], branch:'masculino'};
    if(c.includes('2020') || c.includes('2021')) return {label:'Categorías 2020-2021', years:[2020,2021], branch:'masculino'};
  }
  if(a.includes('softbol')){
    if(c.includes('pre infantil')) return {label:'Pre infantil mixto', minAge:6, maxAge:10, branch:'mixto'};
    if(c.includes('infantil') || c.includes('cadete')) return {label:'Infantil cadete mixto', minAge:11, maxAge:15, branch:'mixto'};
    if(c.includes('femenino')) return {label:'Femenino', minAge:14, maxAge:99, branch:'femenino'};
  }
  if(a.includes('paleta')){
    if(c.includes('niños') || c.includes('ninas') || c.includes('6 a 12')) return {label:'Niños y niñas de 6 a 12 años', minAge:6, maxAge:12, branch:'mixto'};
    if(c.includes('adultos')) return {label:'Adultos', minAge:13, maxAge:99, branch:'mixto'};
  }
  return null;
}

function categoryBranch(category='', activity=''){
  const c = clean(category);
  const a = clean(activity);
  if(c.includes('masculino')) return 'masculino';
  if(c.includes('femenino')) return 'femenino';
  if(c.includes('fisico') || c.includes('físico')) return 'fisico';
  // En fútbol, si no dice femenino, viene del recorrido masculino/infantiles.
  if(a.includes('futbol') && c && !c.includes('femenino')) return 'masculino';
  return '';
}

function sameCategoryBranch(candidate='', selected='', activity=''){
  const selectedBranch = categoryBranch(selected, activity);
  const candBranch = categoryBranch(candidate, activity);
  if(selectedBranch === 'masculino') return candBranch === 'masculino';
  if(selectedBranch === 'femenino') return candBranch === 'femenino';
  if(selectedBranch === 'fisico') return candBranch === 'fisico';
  // Si el usuario no eligió rama, evitamos recomendar preparación física como categoría deportiva.
  return candBranch !== 'fisico';
}

function tooYoungMessage(activity='', ageInfo=null){
  if(!ageInfo) return null;
  const a = clean(activity);
  const age = Number(ageInfo.age || 0);
  if(a.includes('futbol') && age < 5) return `Por ${age} año${age===1?'':'s'}, todavía no corresponde una categoría de fútbol disponible. Te recomiendo consultar con coordinación o administración para saber desde qué edad puede empezar.`;
  if(a.includes('basquet') && age < 4) return `Por ${age} año${age===1?'':'s'}, todavía no corresponde una categoría de básquet disponible. Te recomiendo consultar con coordinación o administración para saber desde qué edad puede empezar.`;
  if(a.includes('gimnasia') && age < 3) return `Por ${age} año${age===1?'':'s'}, todavía no corresponde una categoría de gimnasia disponible. Te recomiendo consultar con administración.`;
  if(a.includes('softbol') && age < 6) return `Por ${age} año${age===1?'':'s'}, todavía no corresponde una categoría de sóftbol disponible. Te recomiendo consultar con coordinación.`;
  if(a.includes('paleta') && age < 6) return `Por ${age} año${age===1?'':'s'}, todavía no corresponde una categoría de pelota a paleta disponible. Te recomiendo consultar con administración.`;
  return null;
}

function availableCategoryRules(data, activity='', selectedCategory=''){
  const items = (data?.activities || [])
    .filter(a => a.active !== false && activityMatchesName(a, activity))
    .filter(a => sameCategoryBranch(a.category || '', selectedCategory, activity));

  const byLabel = new Map();
  for(const item of items){
    const rule = categoryRule(activity, item.category || '');
    if(!rule) continue;
    const label = rule.label || item.category;
    if(!byLabel.has(label)){
      byLabel.set(label, { ...rule, label, rawCategory:item.category || label });
    }
  }

  return [...byLabel.values()].sort((a,b)=>{
    const amin = a.years ? Math.min(...a.years) : (a.minAge ?? 999);
    const bmin = b.years ? Math.min(...b.years) : (b.minAge ?? 999);
    return amin - bmin;
  });
}

function ruleMatchesAgeInfo(rule, info){
  if(!rule || !info) return false;
  if(rule.years){
    if(info.birthYear) return rule.years.includes(info.birthYear);
    // Aproximado para cuando el usuario pone edad, no año. Sirve solo para orientar.
    const approxYear = new Date().getFullYear() - Number(info.age || 0);
    return rule.years.includes(approxYear) || rule.years.includes(approxYear - 1);
  }
  return Number(info.age) >= Number(rule.minAge ?? 0) && Number(info.age) <= Number(rule.maxAge ?? 99);
}

function chooseNearestExistingRule(rules=[], info=null){
  if(!info || !rules.length) return null;

  const exact = rules.find(r => ruleMatchesAgeInfo(r, info));
  if(exact) return exact;

  const age = Number(info.age || 0);
  const ageRules = rules.filter(r => !r.years && r.minAge != null && r.maxAge != null);
  if(ageRules.length){
    // Primero buscamos la categoría real que sigue hacia arriba.
    const upper = ageRules.find(r => age < Number(r.minAge));
    if(upper) return upper;
    // Si se pasó de todas, recomendamos la última real disponible.
    return ageRules[ageRules.length - 1];
  }

  const year = info.birthYear || (new Date().getFullYear() - age);
  const yearRules = rules.filter(r => r.years);
  if(yearRules.length){
    const exactYear = yearRules.find(r => r.years.includes(year));
    if(exactYear) return exactYear;
    const ordered = yearRules.sort((a,b)=>Math.min(...a.years)-Math.min(...b.years));
    const upper = ordered.find(r => Math.min(...r.years) >= year);
    return upper || ordered[ordered.length - 1];
  }

  return null;
}

function fallbackRecommendedCategory(activity='', ageInfo=null){
  if(!ageInfo) return null;
  const a = clean(activity);
  const age = ageInfo.age;
  const y = ageInfo.birthYear;
  if(a.includes('gimnasia')){
    if(age >= 3 && age <= 4) return 'Pulguitas (3 y 4 años)';
    if(age >= 5 && age <= 7) return 'Escuela (5 a 7 años)';
    if(age >= 8 && age <= 10) return 'Promocional (8 a 10 años)';
    if(age >= 11) return 'Pre federadas (11 años en adelante)';
  }
  if(a.includes('basquet')){
    if(age <= 8) return 'Escuelita / Mosquitos';
    if(age <= 9) return 'Básquet Sub 9';
    if(age <= 11) return 'Básquet Sub 11';
    if(age <= 13) return 'Básquet Sub 13';
    if(age <= 15) return 'Básquet Sub 15';
    if(age <= 17) return 'Básquet Sub 17';
    return 'Primera división / Asociativo';
  }
  if(a.includes('futbol')){
    if(y === 2017) return 'Categoría 2017';
    if(y === 2018) return 'Categoría 2018';
    if(y === 2019) return 'Categoría 2019';
    if(y === 2020 || y === 2021) return 'Categorías 2020-2021';
    if(age <= 11) return 'categoría por año de nacimiento; conviene confirmar con administración';
    if(age <= 13) return 'Novena y Décima División';
    if(age <= 15) return 'Séptima y Octava División';
    if(age <= 20) return 'Cuarta, Quinta y Sexta División';
    return 'Primera / categoría a confirmar con administración';
  }
  if(a.includes('softbol')){
    if(age <= 10) return 'Pre infantil mixto';
    if(age <= 15) return 'Infantil cadete mixto';
    return 'Femenino / categoría a confirmar';
  }
  if(a.includes('paleta')){
    if(age >= 6 && age <= 12) return 'Niños y niñas de 6 a 12 años';
    if(age >= 13) return 'Adultos';
  }
  if(a.includes('natatorio') || a.includes('pileta') || a.includes('natacion')) return 'grupo por edad y nivel; conviene confirmar cupo con Natatorio';
  return null;
}

function recommendCategory(data, activity='', ageInfo=null, selectedCategory=''){
  const rules = availableCategoryRules(data, activity, selectedCategory);
  const nearest = chooseNearestExistingRule(rules, ageInfo);
  if(nearest) return nearest.label;
  return fallbackRecommendedCategory(activity, ageInfo);
}



// V68 - Validación fuerte de edad/categoría en inscripción.
// Antes el bot recalculaba la categoría silenciosamente y después decía
// "corresponde" aunque el usuario hubiera elegido otra división.
function validateAndApplySignupAge(data, s, rawAgeText=''){
  s.data.signupDraft = s.data.signupDraft || {};
  const draft = s.data.signupDraft;
  const previousCategory = draft.category || s.data.currentCategory || '';
  const info = extractAgeOrBirthYear(rawAgeText);
  if(!info) return '';

  draft.birthYear = info.birthYear || '';
  s.data.userAge = info.age;
  if(info.birthYear) s.data.userBirthYear = info.birthYear;

  const dataLabel = info.source === 'year' ? `año ${info.birthYear}` : `${info.age} años`;
  const activity = draft.activity || s.data.currentActivity || '';
  const tooYoung = tooYoungMessage(activity, info);
  if(tooYoung){
    return `\n\n⚠️ ${tooYoung}`;
  }

  const oldRule = categoryRule(activity, previousCategory);
  const oldWasOk = oldRule ? ruleMatchesAgeInfo(oldRule, info) : false;
  const rec = phase6RecommendRule(data, activity, info, draft.branch || s.data.userBranch || '');

  if(rec){
    draft.category = rec.label || draft.category;
    draft.branch = rec.branch || draft.branch || '';
    s.data.currentCategory = rec.label || s.data.currentCategory;
  }

  if(oldRule && !oldWasOk){
    return `\n\n⚠️ Por ${dataLabel}, la categoría elegida (**${previousCategory}**) no corresponde.\n\n✅ Te la acomodé a: **${draft.category || rec?.label || 'Categoría a confirmar'}**.\n\nIgual administración confirma cupo, documentación y categoría final.`;
  }

  if(oldRule && oldWasOk){
    return `\n\n✅ Por ${dataLabel}, esa categoría corresponde de forma orientativa. Igual administración confirma cupo, documentación y categoría final.`;
  }

  if(rec){
    return `\n\n📌 Por ${dataLabel}, te recomiendo: **${rec.label}**. Igual administración confirma la categoría final.`;
  }

  return `\n\n📌 Por ${dataLabel}, administración confirma la categoría final según cupo y reglamento.`;
}


function signupAgeTooYoungInfo(data, s, rawAgeText=''){
  const info = extractAgeOrBirthYear(rawAgeText);
  if(!info) return null;
  const draft = s.data?.signupDraft || {};
  const activity = draft.activity || s.data?.currentActivity || '';
  const msg = tooYoungMessage(activity, info);
  if(!msg) return null;
  return { info, activity, message: msg };
}

function signupAgeBlockedReply(data, s, rawAgeText=''){
  const blocked = signupAgeTooYoungInfo(data, s, rawAgeText);
  if(!blocked) return '';
  const draft = s.data.signupDraft || {};
  const activity = draft.activity || blocked.activity || 'la actividad elegida';
  return `⚠️ ${blocked.message}

Por eso no sigo pidiendo DNI todavía, así evitamos cargar una inscripción que después no corresponda.

¿Qué querés hacer?

A. 📞 Hablar con administración
B. 🏟️ Elegir otro deporte
C. 🔄 Cambiar la edad
D. 🏠 Menú principal`;
}

function categoryAgeAdvice(data, activity='', category='', ageText=''){
  const info = extractAgeOrBirthYear(ageText);
  if(!info) return '';
  const dataLabel = info.source === 'year' ? `año ${info.birthYear}` : `${info.age} años`;
  const tooYoung = tooYoungMessage(activity, info);
  if(tooYoung){
    return `\n\n⚠️ ${tooYoung}\n\nNo te recomiendo otra categoría porque por la edad todavía no hay una opción deportiva real cargada para ese caso.`;
  }
  const rule = categoryRule(activity, category);
  const rec = recommendCategory(data, activity, info, category);
  if(!rule){
    return rec ? `\n\n📌 Por ${dataLabel}, te recomiendo consultar: ${rec}.` : '';
  }
  let ok = true;
  if(rule.years) ok = rule.years.includes(info.birthYear);
  else ok = info.age >= rule.minAge && info.age <= rule.maxAge;
  if(ok){
    return `\n\n✅ Por ${dataLabel}, esa categoría parece corresponder. Igual administración confirma cupo, documentación y categoría final.`;
  }
  return `\n\n⚠️ Por ${dataLabel}, esa categoría no parece corresponder.\nTe aconsejo consultar: ${rec || 'la categoría que indique administración según edad/año de nacimiento'}.\n\nSi querés, seguimos igual con la solicitud y administración confirma la categoría final.`;
}


// FASE 6 - Conversación inteligente: entiende deporte + edad + intención en una misma frase,
// mantiene memoria y recomienda categorías reales sin mezclar ramas.
function phase6BranchFromText(text='', activity=''){
  const t = normalizeUserText(text);
  if(containsAny(t,['hija','nena','niña','chica','mujer','femenino','femenina','para ella'])) return 'femenino';
  if(containsAny(t,['hijo','nene','niño','chico','varon','varón','masculino','masculina','para el','para él'])) return 'masculino';
  const a = clean(activity);
  if(a.includes('futbol')) return 'masculino';
  return '';
}
function phase6SelectedCategoryFromBranch(activity='', branch=''){
  const a = clean(activity);
  if(branch === 'femenino') return 'Femenino';
  if(branch === 'masculino') return a.includes('futbol') ? 'Masculino' : 'Masculino';
  return '';
}

// V69 - Categoría precisa por edad/año, usando la categoría real cargada para horarios.
function preciseCategoryByAge(activity='', ageInfo=null, branch=''){
  if(!ageInfo) return null;
  const a = clean(activity);
  const age = Number(ageInfo.age || 0);
  const y = Number(ageInfo.birthYear || (new Date().getFullYear() - age));

  if(a.includes('futbol')){
    if(branch === 'femenino'){
      if(age >= 11 && age <= 12) return {label:'Femenino Sub 12', rawCategory:'Femenino Sub 12 y Sub 14', branch:'femenino'};
      if(age >= 13 && age <= 14) return {label:'Femenino Sub 14', rawCategory:'Femenino Sub 12 y Sub 14', branch:'femenino'};
      return null;
    }
    if(y === 2017) return {label:'Categoría 2017', rawCategory:'Categoría 2017', branch:'masculino'};
    if(y === 2018) return {label:'Categoría 2018', rawCategory:'Categoría 2018', branch:'masculino'};
    if(y === 2019) return {label:'Categoría 2019', rawCategory:'Categoría 2019', branch:'masculino'};
    if(y === 2020 || y === 2021) return {label:'Categorías 2020-2021', rawCategory:'Categorías 2020-2021', branch:'masculino'};
    if(y === 2015) return {label:'Décima División', rawCategory:'Novena y Décima División', branch:'masculino'};
    if(y === 2014) return {label:'Novena División', rawCategory:'Novena y Décima División', branch:'masculino'};
    if(y === 2013) return {label:'Octava División', rawCategory:'Séptima y Octava División', branch:'masculino'};
    if(y === 2012) return {label:'Séptima División', rawCategory:'Séptima y Octava División', branch:'masculino'};
    if(y === 2011) return {label:'Sexta División', rawCategory:'Cuarta, Quinta y Sexta División', branch:'masculino'};
    if(y === 2010) return {label:'Quinta División', rawCategory:'Cuarta, Quinta y Sexta División', branch:'masculino'};
    if(y === 2009 || y === 2008) return {label:'Cuarta División', rawCategory:'Cuarta, Quinta y Sexta División', branch:'masculino'};
    return null;
  }

  if(a.includes('basquet')){
    const b = branch === 'femenino' ? 'femenino' : branch === 'masculino' ? 'masculino' : '';
    if(age >= 4 && age <= 6) return {label:'Escuelita', rawCategory:'Escuelita', branch:b||'mixto'};
    if(age >= 7 && age <= 8) return {label:'Mosquitos / Sub 9', rawCategory:'Sub 9', branch:b||'mixto'};
    if(age >= 9) {
      const sub = age <= 9 ? 'Sub 9' : age <= 11 ? 'Sub 11' : age <= 13 ? 'Sub 13' : age <= 15 ? 'Sub 15' : age <= 17 ? 'Sub 17' : 'Primera división';
      if(b === 'femenino'){
        const raw = sub === 'Primera división' ? 'Femenino Sub 17 y Primera' : `Femenino ${sub}`;
        return {label:`Básquet Femenino ${sub}`, rawCategory:raw, branch:'femenino'};
      }
      if(b === 'masculino'){
        const raw = sub === 'Primera división' ? 'Primera división' : `Masculino ${sub}`;
        return {label: sub === 'Primera división' ? 'Primera división' : `Básquet Masculino ${sub}`, rawCategory:raw, branch:'masculino'};
      }
      return {label:`Básquet ${sub}`, rawCategory:sub, branch:'mixto'};
    }
  }

  if(a.includes('gimnasia')){
    if(age >= 3 && age <= 4) return {label:'Pulguitas (3 y 4 años)', rawCategory:'Pulgas (3 y 4 años)', branch:'mixto'};
    if(age >= 5 && age <= 7) return {label:'Escuela (5 a 7 años)', rawCategory:'Escuela (5 a 7 años)', branch:'mixto'};
    if(age >= 8 && age <= 10) return {label:'Promocional (8 a 10 años)', rawCategory:'Promocional (8 a 10 años)', branch:'mixto'};
    if(age >= 11) return {label:'Pre federadas (11 años en adelante)', rawCategory:'Pre federadas (11 años en adelante)', branch:'mixto'};
  }

  if(a.includes('softbol')){
    if(age >= 6 && age <= 10) return {label:'Pre infantil mixto', rawCategory:'Pre infantil mixto', branch:'mixto'};
    if(age >= 11 && age <= 15) return {label:'Infantil cadete mixto', rawCategory:'Infantil cadete mixto', branch:'mixto'};
    if(age >= 16) return {label:'Femenino / categoría a confirmar', rawCategory:'Femenino', branch:branch||'femenino'};
  }

  if(a.includes('paleta')){
    if(age >= 6 && age <= 12) return {label:'Niños y niñas de 6 a 12 años', rawCategory:'Niños y niñas de 6 a 12 años', branch:'mixto'};
    if(age >= 13) return {label:'Adultos', rawCategory:'Adultos', branch:'mixto'};
  }
  return null;
}

function phase6RecommendRule(data, activity='', ageInfo=null, branch=''){
  const precise = preciseCategoryByAge(activity, ageInfo, branch);
  if(precise) return precise;

  const selected = phase6SelectedCategoryFromBranch(activity, branch);
  const rules = availableCategoryRules(data, activity, selected);
  const nearest = chooseNearestExistingRule(rules, ageInfo);
  if(nearest) return nearest;
  const label = fallbackRecommendedCategory(activity, ageInfo);
  return label ? {label, rawCategory:label, branch:branch||'mixto'} : null;
}
function phase6Intent(text=''){
  const t = normalizeUserText(text);
  const wantsSchedule = containsAny(t,['horario','horarios','orario','orarios','dias','días','dia','día','cuando','entrena','entrenan','clases']);
  const wantsPrice = containsAny(t,['precio','precios','costo','costos','valor','valores','cuanto sale','cuánto sale','cuota','cuotas','sale']);
  const wantsSignup = containsAny(t,['inscripcion','inscripción','insripcion','inscripsion','inscribir','inscribirme','anotar','anotarme','anotarlo','anotarla','sumar','empezar','arrancar','quiere jugar','quiere hacer','quiero jugar','quiero hacer']);
  const wantsTeacher = containsAny(t,['profe','profesor','profesora','entrenador','entrenadora']);
  const wantsWhatsapp = containsAny(t,['whatsapp','wasap','wsp','telefono','teléfono','contacto','hablar']);
  if(wantsSchedule) return 'schedule';
  if(wantsPrice) return 'price';
  if(wantsSignup) return 'inscription';
  if(wantsTeacher) return 'teacher';
  if(wantsWhatsapp) return 'admin';
  return '';
}
function phase6ReplyForKnownContext(data, s, rawText=''){
  const kind = phase6Intent(rawText) || disciplineFollowUpKind(rawText);
  if(!kind) return '';
  if(s.data?.disciplineDetail && ['schedule','teacher','price','inscription','admin'].includes(kind)){
    if(kind === 'admin') return goAdmin(data, s, s.phone || 'demo', rawText, `Usuario pidió contacto desde ${s.data?.disciplineDetail?.title || 'disciplina'}`);
    return disciplineAnswer(data, s, kind);
  }
  const remembered = activityFromMemory(s);
  if(remembered && ['schedule','price','inscription','admin'].includes(kind)){
    if(kind === 'admin') return goAdmin(data, s, s.phone || 'demo', rawText, `Usuario pidió contacto por ${remembered.label}`);
    return directActivityReply(data, remembered, rawText, s);
  }
  return '';
}
function phase6SmartConversation(data, s, rawText='', phone='demo'){
  const t = normalizeUserText(rawText);
  const activity = detectActivityFreeText(rawText);
  const ageInfo = extractAgeOrBirthYear(rawText);
  const branch = phase6BranchFromText(rawText, activity?.label || s.data?.currentActivity || '');
  const intent = phase6Intent(rawText);

  // Caso 1: frase completa. Ej: "Mi hijo tiene 11 años y quiere jugar al fútbol".
  if(activity && (ageInfo || intent)){
    s.data = { ...(s.data||{}), currentActivity: activity.label, lastNaturalIntent: intent || 'inscription' };
    setTopic(s,'actividades',{});
    setMenuContext(s, activity.key === 'natatorio' ? 'natatorio' : activity.key);

    if(ageInfo && !['natatorio'].includes(activity.key)){
      const tooYoung = tooYoungMessage(activity.label, ageInfo);
      if(tooYoung){
        return `⚠️ ${tooYoung}\n\nNo te recomiendo otra categoría porque no hay una opción deportiva real cargada para esa edad.\n\nSi querés, te comunico con administración para que te orienten.`;
      }
      const rec = phase6RecommendRule(data, activity.label, ageInfo, branch);
      if(rec){
        const title = `${activity.label}${rec.label ? ' - ' + rec.label : ''}`;
        const rawCat = rec.rawCategory || rec.label;
        setDiscipline(s,'discipline_detail', title, activity.label, [rawCat, rec.label].filter(Boolean), activity.key);
        s.data.userAge = ageInfo.age;
        s.data.userBirthYear = ageInfo.birthYear;
        s.data.userBranch = branch || rec.branch || '';
        const dataLabel = ageInfo.source === 'year' ? `año ${ageInfo.birthYear}` : `${ageInfo.age} años`;
        let next = `¿Qué te paso ahora?

A. 📅 Horarios
B. 💰 Costo / cuota
C. 📝 Iniciar inscripción
D. 👨‍🏫 Profesor/a
E. 📲 WhatsApp / administración`;
        if(intent === 'schedule') return disciplineAnswer(data, s, 'schedule');
        if(intent === 'price') return disciplineAnswer(data, s, 'price');
        if(intent === 'teacher') return disciplineAnswer(data, s, 'teacher');
        if(intent === 'admin') return goAdmin(data, s, phone, rawText, `Contacto por ${title}`);
        if(intent === 'inscription') return startSignupFlow(data, s, activity.label, title);
        return `¡Genial! ${activity.key==='football'?'⚽':activity.key==='basket'?'🏀':'😊'}\n\nPor ${dataLabel}, te recomiendo **${rec.label}**, que es la categoría real más adecuada que tengo cargada para ${activity.label}${branch ? ` (${branch})` : ''}.\n\n${next}`;
      }
    }

    // Natatorio o actividad sin categoría por edad: responde intención directa si la hay.
    return directActivityReply(data, activity, rawText, s);
  }

  // Caso 2: el usuario no menciona deporte, pero pregunta algo del contexto actual.
  if(!activity && intent){
    const contextual = phase6ReplyForKnownContext(data, s, rawText);
    if(contextual) return contextual;
  }

  // Caso 3: cambia de deporte naturalmente. Ej: "mejor básquet".
  if(activity){
    s.data = { ...(s.data||{}), currentActivity: activity.label, lastNaturalIntent: intent || '' };
    setTopic(s,'actividades',{});
    setMenuContext(s, activity.key === 'natatorio' ? 'natatorio' : activity.key);
    return directActivityReply(data, activity, rawText, s);
  }

  return '';
}

function ageSmartHint(age, activity=''){
  if(!age) return '';
  const a = clean(activity);
  if(a.includes('gimnasia')){
    if(age <= 4) return 'Por la edad, lo más probable es mirar Pulguitas (3 y 4 años).';
    if(age <= 7) return 'Por la edad, lo más probable es mirar Escuela (5 a 7 años).';
    if(age <= 10) return 'Por la edad, lo más probable es mirar Promocional (8 a 10 años).';
    return 'Por la edad, conviene consultar categoría disponible con el profe o administración.';
  }
  if(a.includes('futbol')){
    if(age <= 5) return 'Por la edad, puede corresponder escuelita o categorías iniciales; administración confirma el grupo exacto.';
    if(age <= 13) return 'Por la edad, puede corresponder fútbol infantil; conviene validar categoría por año de nacimiento.';
    return 'Para fútbol se suele definir por categoría/año de nacimiento. Te muestro el menú para ubicarlo bien.';
  }
  if(a.includes('basquet') || a.includes('basket')){
    if(age <= 8) return 'Por la edad, puede corresponder Mosquitos o Escuelita.';
    if(age <= 10) return 'Por la edad, puede corresponder Sub 9 / Sub 11 según cupo y año.';
    if(age <= 12) return 'Por la edad, puede corresponder Sub 11 / Sub 13 según año y cupo.';
    if(age <= 14) return 'Por la edad, puede corresponder Sub 13 / Sub 15 según año y rama.';
    if(age <= 16) return 'Por la edad, puede corresponder Sub 15 / Sub 17 según año y rama.';
    return 'Por la edad, puede corresponder Sub 17 o Primera, según rama y cupo.';
  }
  if(a.includes('natatorio') || a.includes('pileta') || a.includes('natacion')){
    return 'Para natatorio, con esa edad conviene confirmar grupo, nivel y cupo disponible con administración.';
  }
  return 'Con esa edad te puedo orientar, pero administración confirma grupo y cupo disponible.';
}

function activityFromMemory(s){
  const current = s?.data?.currentActivity || s?.data?.topic || '';
  const ctx = getMenuContext(s);
  const detected = detectActivityFreeText(current);
  if(detected) return detected;
  if(ctx === 'natatorio' || clean(current).includes('natatorio')) return {key:'natatorio', label:'Natatorio / pileta'};
  if(ctx === 'gymnastics' || clean(current).includes('gimnasia')) return {key:'gymnastics', label:'Gimnasia Artística'};
  if(ctx === 'basket' || ctx === 'basket_fem' || ctx === 'basket_masc' || clean(current).includes('basquet')) return {key:'basket', label:'Básquet'};
  if(ctx === 'football' || clean(current).includes('futbol')) return {key:'football', label:'Fútbol'};
  if(ctx === 'softbol' || clean(current).includes('softbol')) return {key:'softbol', label:'Sóftbol'};
  if(ctx === 'paleta' || clean(current).includes('paleta')) return {key:'paleta', label:'Pelota a Paleta'};
  return null;
}

function isContextFollowUp(text=''){
  const t = normalizeUserText(text);
  return containsAny(t,[
    'horarios','horario','dias','dia','cuando','clases',
    'inscripcion','inscribir','inscribirme','inscribirte','anotar','anotarme','anotarte',
    'precio','precios','costo','costos','valor','valores','cuanto','cuanto sale','cuota',
    'whatsapp','wasap','wsp','telefono','administracion','hablar','cupos','cupo','edades','edad','niveles'
  ]);
}

function isMemberFeeDebtQuery(text=''){
  const t = normalizeUserText(text);
  // Si el usuario pregunta si DEBE cuota/deuda, eso es cuota social/socio,
  // no precio de la actividad que venía consultando.
  return containsAny(t,['debo','deuda','adeudo','saldo','moroso','vencimiento','si debo','tengo deuda','debo cuota','debo algo','consultar deuda','cuota social','mi cuota'])
    || (/(cuota|cuotas)/.test(t) && containsAny(t,['debo','deuda','saldo','vencimiento','socio','social','pagar','pague','pagué']));
}

function clubLocationReply(data){
  return `El Club All Boys está en Hilario Lagos 435, Santa Rosa, La Pampa. 📍

Para consultas rápidas también podés comunicarte por WhatsApp con administración:
${adminContact(data)}

A. 🏠 Menú principal
B. 📞 Hablar con administración`;
}
function naturalHelpMenu(){
  return `Podés escribirme como hablarías por WhatsApp 😊

Ejemplos:
• Mi hijo tiene 9 años y quiere jugar al fútbol
• ¿Cuánto sale natación?
• Horarios de gimnasia artística
• Quiero inscribirme a básquet
• ¿Dónde queda el club?
• Necesito hablar con administración
• ¿Quién es el profesor?
• ¿Hay cupo?

Yo trato de entender el tema y seguir el contexto, sin hacerte pasar por mil menús.`;
}
function setTopic(s, topic, extra={}){
  s.data = { ...(s.data||{}), topic, ...extra };
  s.updatedAt = new Date().toISOString();
}
function currentTopic(s){ return s?.data?.topic || ''; }

function knowledgeSearch(data, text){
  const words = clean(text).split(/\s+/).filter(w=>w.length>3);
  let best=null, score=0;
  for(const k of (data.knowledge||[])){
    const body = clean((k.q||'')+' '+(k.a||''));
    const s = words.reduce((acc,w)=>acc+(body.includes(w)?1:0),0);
    if(s>score){ best=k; score=s; }
  }
  return score ? best : null;
}
function memberReply(member){
  const firstName = String(member.name || '').split(' ')[0] || 'Socio';
  if(Number(member.debt||0) > 0){
    return `${topicVibe('members')}

${firstName}, encontré tu ficha de socio Nº ${member.memberNo}.

⚠️ Registrás una deuda pendiente de ${money(member.debt)}.
Vencimiento registrado: ${member.nextDue}.

Podés abonarla por administración, transferencia o Mercado Pago.

¿Querés que te muestre los medios de pago disponibles?

También podés escribir “mi carnet” para ver el carnet digital demo.`;
  }
  return `${topicVibe('members')}

${firstName}, encontré tu ficha de socio Nº ${member.memberNo} ✅

Tu cuota figura al día.
Próximo vencimiento: ${member.nextDue}.
Actividad registrada: ${(member.activities||[]).join(', ') || 'sin actividades cargadas por ahora'}.

¿Querés consultar otro socio o necesitás otra información?`;
}

const allBoysWebsiteDocuments = [
  {
    title: 'Web oficial - Inicio All Boys Santa Rosa',
    source: 'https://cluballboyslapampa.org/',
    type: 'web',
    content: `La web oficial identifica al club como ALL BOYS SANTA ROSA - LA PAMPA. En la página principal aparecen secciones Inicio, El Club, Actividades, La Cantina y Carnet Digital. También muestra referencias a la hinchada, la Cantina del club, el Natatorio Ismael Amit, gimnasia artística y fútbol femenino. La sede figura en Hilario Lagos 435, Santa Rosa. El contacto publicado es +54 9 2954 592312 y el email institucional publicado es info@cluballboyslapampa.org.`
  },
  {
    title: 'Actividades destacadas - All Boys',
    source: 'https://cluballboyslapampa.org/',
    type: 'web',
    content: `Actividades e instalaciones mencionadas en la web oficial: Natatorio Ismael Amit, gimnasia artística, fútbol femenino y la Cantina del club. El bot debe responder que la información puede confirmarse con administración cuando se trate de horarios, cupos o valores actualizados.`
  },
  {
    title: 'Ubicación y contacto - All Boys',
    source: 'https://cluballboyslapampa.org/',
    type: 'web',
    content: `La sede del Club Atlético All Boys Santa Rosa figura en Hilario Lagos 435, Santa Rosa, La Pampa. El WhatsApp de contacto publicado en la web es +54 9 2954 592312.`
  }
];

function trainWebsite(data){
  data.documents = data.documents || [];
  let added = 0;
  for (const doc of allBoysWebsiteDocuments) {
    const exists = data.documents.some(d => d.source === doc.source && d.title === doc.title);
    if (!exists) {
      data.documents.unshift({ id: Date.now() + added, createdAt: new Date().toISOString(), ...doc });
      added++;
    }
  }
  return added;
}


function setMenuContext(s, menu){
  // Guarda también lastMenu para que una letra (A/B/C...) se interprete
  // por el último menú mostrado y no por el menú principal.
  s.data = { ...(s.data||{}), menu, lastMenu: menu || (s.data||{}).lastMenu || '' };
  s.state = menu ? `waiting_${menu}` : 'idle';
  s.updatedAt = new Date().toISOString();
}
function getMenuContext(s){ return (s && s.data && s.data.menu) || ''; }
function isLetter(text, letters){
  const t = clean(text).toUpperCase();
  return letters.includes(t);
}
function clearMenuContext(s){
  s.data = { ...(s.data||{}), menu:'', lastMenu:'main' };
  s.state = 'idle';
  s.updatedAt = new Date().toISOString();
}

// V59 - Reset fuerte cuando el bot abandona un flujo.
// Si vuelve al menú principal por no entender una consulta, no debe quedar
// enganchado a la categoría/deporte anterior. Evita que luego una letra
// del menú principal se interprete como una opción vieja.
function resetToMainContext(s){
  const keep = { ...(s.data || {}) };
  delete keep.menu;
  delete keep.topic;
  delete keep.currentActivity;
  delete keep.currentCategory;
  delete keep.disciplineDetail;
  delete keep.lastNaturalIntent;
  delete keep.priceFlow;
  delete keep.priceMode;
  delete keep.userBranch;
  // No borramos signupDraft/adminDraft/claimDraft acá porque algunos flujos
  // pueden usar sus propios pasos; esta función solo se usa al volver al menú.
  s.data = { ...keep, menu:'', topic:'' };
  s.state = 'idle';
  s.updatedAt = new Date().toISOString();
}

function reactivateBotSession(s){
  resetForNewConversation(s);
  s.data.returnedToBotAt=new Date().toISOString();
  s.data.attentionMode='bot';
}

// V100: Reactiva todas las sesiones que correspondan al mismo número.
// Evita que una sesión guardada como +549... y otra como 549... dejen al bot pausado.
function reactivateAllSessionsForPhone(data, phone){
  const digits=phoneDigits(phone);
  data.sessions=data.sessions||[];
  const matches=data.sessions.filter(x => digits && phoneDigits(x.phone)===digits);
  if(!matches.length){
    const created=getSession(data,String(phone||''));
    reactivateBotSession(created);
    return created;
  }
  const canonical=matches[0];
  reactivateBotSession(canonical);
  canonical.phone=canonical.phone || String(phone||'');
  // Quitamos duplicados del mismo teléfono para que no vuelva a aparecer un modo humano viejo.
  data.sessions=data.sessions.filter(x => x===canonical || phoneDigits(x.phone)!==digits);
  return canonical;
}

function adminWhatsAppLink(data, draft={}){
  const raw = String(data.club?.whatsapp || '2954592313').replace(/\D/g,'');
  const phone = raw.startsWith('54') ? raw : `549${raw}`;
  const msg = `Hola, vengo derivado desde Panchito.\nNombre: ${draft.name || ''}\nTeléfono: ${draft.phone || ''}\nTema: ${draft.topic || ''}\nConsulta: ${draft.message || ''}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

function adminWhatsAppNumber(data){
  const raw = String(data.club?.whatsapp || '2954592313').replace(/\D/g,'');
  return raw || '2954592313';
}

function normalizeWhatsappPhoneServer(value=''){
  let raw = String(value||'').replace(/\D/g,'');
  if(!raw) return '';
  if(raw.startsWith('549')) return raw;
  if(raw.startsWith('54')) return raw.startsWith('549') ? raw : '549' + raw.slice(2);
  raw = raw.replace(/^0+/, '');
  raw = raw.replace(/^(2954)15/, '$1');
  return `549${raw}`;
}

function replyToUserWhatsAppLink(draft={}, fallbackPhone=''){
  const phone = normalizeWhatsappPhoneServer(draft.phone || draft.contactPhone || fallbackPhone);
  if(!phone) return '';
  const msg = `Hola ${draft.name || ''}, te escribimos desde Administración de All Boys por tu consulta.\n\nTema: ${draft.topic || ''}\nConsulta: ${draft.message || ''}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

function derivationPriority(draft={}){
  const t = clean(`${draft.topic||''} ${draft.message||''}`);
  if(containsAny(t,['reclamo','queja','problema','mal','profesor','inconveniente','molesto','urgente'])) return '🔴 Reclamo';
  if(containsAny(t,['inscripcion','inscribir','anotar','alta','sumar','menor'])) return '🟢 Inscripción';
  return '🟡 Consulta';
}

function adminStepPrompt(step){
  const prompts = {
    dni: '1/3 Ingresá el DNI o número de socio para identificarte.',
    name: 'No pude encontrarte. Pasame tu nombre y apellido para continuar manualmente.',
    phone: 'Ahora pasame un teléfono de contacto.',
    topic: '2/3 ¿Sobre qué tema es la consulta? Ejemplo: básquet, fútbol, cuota, inscripción, natatorio o reclamo.',
    message: '3/3 Contame brevemente qué necesitás para que Administración lo pueda responder.'
  };
  return prompts[step] || prompts.dni;
}

function adminSummary(draft={}){
  const acts = Array.isArray(draft.activities) ? draft.activities.join(', ') : (draft.activities || '-');
  return `Consulta para administración:
Nombre y apellido: ${draft.name || '-'}
DNI: ${draft.dni || '-'}
N.º de socio: ${draft.memberNo || '-'}
Estado: ${draft.status || '-'}
Cuota: ${draft.feeStatus || '-'}${draft.debt !== undefined && draft.debt !== null ? ` (deuda: $${Number(draft.debt||0).toLocaleString('es-AR')})` : ''}
Actividades: ${acts || '-'}
Teléfono: ${draft.phone || '-'}
Tema: ${draft.topic || '-'}
Mensaje: ${draft.message || '-'}`;
}

function goAdmin(data, s, phone, rawText, note='Usuario pidió hablar con administración'){
  s.data = { ...(s.data||{}), adminDraft:{ originalText: rawText || '', note } };
  setMenuContext(s,'admin_dni');
  return `📞 Te llevo con Administración.
${topicVibe('admin')}

Primero voy a identificarte para que no tengas que volver a cargar todos tus datos.

${adminStepPrompt('dni')}

Escribí *OMITIR* si no sos socio o no tenés el dato a mano.`;
}


function activityMatchesName(a, key){
  const n = clean(a.name||'');
  const c = clean(a.category||'');
  const k = clean(key||'');
  if(!k) return false;
  if(k.includes('basquet') || k.includes('basket')) return n.includes('basquet') || n.includes('basket');
  if(k.includes('futbol') || k.includes('football')) return n.includes('futbol') || n.includes('football');
  if(k.includes('gimnasia')) return n.includes('gimnasia');
  if(k.includes('softbol')) return n.includes('softbol');
  if(k.includes('paleta')) return n.includes('paleta') || c.includes('paleta');
  if(k.includes('natatorio') || k.includes('pileta')) return n.includes('natatorio') || n.includes('pileta');
  return n.includes(k) || c.includes(k);
}

function activityPriceReply(data, activityName){
  const items = (data.activities||[])
    .filter(a => a.active !== false && activityMatchesName(a, activityName));

  const label = activityName || 'Actividad';
  const withPrices = items.filter(a => Number(a.cost||0) > 0);

  let lines = '';
  if(withPrices.length){
    lines = withPrices.map(a => {
      const cat = a.category ? ` - ${a.category}` : '';
      return `• ${a.name}${cat}: ${money(a.cost)}`;
    }).join('\n');
  } else if(items.length){
    lines = `El valor de esta actividad todavía no fue informado por la administración del club.`;
  } else {
    lines = `Todavía no encontré esa actividad cargada. Podés consultar con administración para confirmar la información.`;
  }

  return `💰 Precios / cuotas de ${label}

${lines}

📝 Inscripción:
Para inscribirte o consultar cupos, comunicate con administración del club.

${adminContact(data)}

¿Qué querés hacer ahora?
A. 📲 Hablar con administración
B. 🏅 Ver otra actividad
C. 🏠 Menú principal`;
}

function responseContextualPrice(data, context='actividad'){
  const c = clean(context);
  if(c === 'basket' || c === 'basquet') return activityPriceReply(data, 'Básquet');
  if(c === 'football' || c === 'futbol') return activityPriceReply(data, 'Fútbol');
  if(c.includes('gimnasia')) return activityPriceReply(data, 'Gimnasia Artística');
  if(c.includes('softbol')) return activityPriceReply(data, 'Softbol');
  if(c.includes('paleta')) return activityPriceReply(data, 'Pelota a Paleta');
  if(c.includes('natatorio') || c.includes('pileta')) return activityPriceReply(data, 'Natatorio');
  return activityPriceReply(data, context || 'Actividad');
}



function getActivityItems(data, activityName, categoryNeedles=[]){
  const act = clean(activityName || '');
  const needles = (categoryNeedles || []).map(clean).filter(Boolean);
  return (data.activities || []).filter(a => {
    if(a.active === false) return false;
    const name = clean(a.name || '');
    const cat = clean(a.category || '');
    if(act && !name.includes(act)) return false;
    if(!needles.length) return true;

    // Cuando el usuario pide una rama concreta (ej: Masculino Sub 13),
    // no mezclamos Femenino Sub 13 ni Físico Sub 13.
    return needles.some(k => {
      if(!k) return false;
      const exactNeeded = /masculino|femenino|fisico|físico|primera division|primera división/.test(k);
      if(exactNeeded) return cat === k || cat.includes(k);
      return cat.includes(k);
    });
  });
}

function shortCost(items){
  const priced = items.filter(a => Number(a.cost || 0) > 0);
  if(!priced.length) return 'El valor de esta actividad todavía no fue informado por la administración del club.';
  const unique = [...new Set(priced.map(a => money(a.cost)))];
  return `Precio/cuota: ${unique.join(' / ')}`;
}

function shortTeacher(items){
  const teachers = [...new Set(items.map(a => String(a.teacher || '').trim()).filter(Boolean))];
  return teachers.length ? `Profesor/a: ${teachers.join(' / ')}` : 'El profesor o profesora de esta actividad todavía no fue informado.';
}

function formatSchedule(items){
  if(!items.length) return 'El horario de esta actividad todavía no fue informado.';
  return items.map(a => {
    const cat = a.category ? `${a.category}: ` : '';
    const days = a.days || 'Días a confirmar';
    const time = a.time || 'Horario a confirmar';
    return `• ${cat}${days} de ${time}`;
  }).join('\n');
}


function officialActivityContact(activity=''){
  const a = clean(activity || '');
  if(a.includes('gimnasia')) return `Patricia “Pato” Saavedra
Responsable de Gimnasia artística
WhatsApp: 2954 29-6451`;
  if(a.includes('softbol') || a.includes('sóftbol')) return `Ángel Yorgoban
Responsable de Sóftbol
WhatsApp: 2954 66-4276`;
  if(a.includes('paleta')) return `Lucas Gómez
Responsable de Pelota a paleta
WhatsApp: 2954 44-6373`;
  if(a.includes('natatorio') || a.includes('natacion') || a.includes('natación') || a.includes('pileta')) return `José Luis “Chino” Weighant
Coordinador de Natación
WhatsApp: 2954 36-9045`;
  if(a.includes('basquet') || a.includes('básquet') || a.includes('futbol') || a.includes('fútbol')) return `Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312`;
  return `Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312`;
}

function officialContactIntro(activity='', purpose='precios, cupos o inscripción'){
  return `Para consultar ${purpose}:
${officialActivityContact(activity)}`;
}

function disciplineDetail(data, title, activityName, categoryNeedles, backMenu){
  const items = getActivityItems(data, activityName, categoryNeedles);
  const hasSchedule = items.some(a => String(a.days || '').trim() || String(a.time || '').trim());
  const hasPrice = items.some(a => Number(a.cost || 0) > 0);
  const hasTeacher = items.some(a => String(a.teacher || '').trim());

  return `${title}
${categoryVibe(title)}

¿Qué querés consultar?

A. Horarios ${hasSchedule ? '📅' : '📅'}
B. Profesor/a ${hasTeacher ? '👨‍🏫' : '👨‍🏫'}
C. Precio/cuota ${hasPrice ? '💰' : '💰'}
D. Inscripción 📝
E. Hablar con administración 📞
F. Volver
G. Menú principal`;
}

function priceDisciplineDetail(data, s){
  const detail = s.data?.disciplineDetail || {};
  const items = getActivityItems(data, detail.activity || '', detail.needles || []);
  const title = detail.title || 'Esta categoría';
  const hasPrice = items.some(a => Number(a.cost || 0) > 0);
  return `${title}
${categoryVibe(title)}

¿Qué querés consultar?

A. Precio/cuota ${hasPrice ? '💰' : '💰'}
B. Inscripción 📝
C. Volver a categorías
D. Volver a actividades
E. Menú principal`;
}

function disciplineAnswer(data, s, kind){
  const detail = s.data?.disciplineDetail || {};
  const items = getActivityItems(data, detail.activity || '', detail.needles || []);
  const title = detail.title || 'Esta disciplina';

  function finishAnswer(body, kindDone=''){
    s.data = { ...(s.data||{}), lastDisciplineAnswer: kindDone || '' };
    setMenuContext(s, 'after_discipline_answer');
    return `${body}${disciplineNextMenu(kindDone)}`;
  }

  const officialContact = officialActivityContact(detail.activity || s.data?.currentActivity || title);
  if(kind === 'price') return finishAnswer(`💰 ${title}

Para consultar el precio actualizado:
${officialContact}`, 'price');
  if(kind === 'teacher') return finishAnswer(`👨‍🏫 ${title}

Contacto responsable:
${officialContact}`, 'teacher');
  if(kind === 'inscription') return finishAnswer(`📝 ${title}

Para consultar cupos e inscripción:
${officialContact}`, 'inscription');
  if(kind === 'schedule') return finishAnswer(`📅 ${title}

${formatSchedule(items)}

${officialContactIntro(detail.activity || title)}`, 'schedule');

  // Flujo B: si el usuario ya eligió PRECIO o INSCRIPCIÓN antes de elegir deporte/categoría,
  // no hay que volver a preguntarle qué quiere consultar. Se responde directo.
  if(kind === 'all' && s.data?.priceFlow){
    const mode = s.data?.priceMode || 'price';
    return disciplineAnswer(data, s, mode === 'inscription' ? 'inscription' : 'price');
  }

  return disciplineDetail(data, title, detail.activity || '', detail.needles || [], detail.backMenu || 'activities');
}

function setDiscipline(s, menu, title, activity, needles, backMenu){
  const targetMenu = (s.data?.priceFlow && menu === 'discipline_detail') ? 'price_discipline_detail' : menu;
  setMenuContext(s, targetMenu);
  s.data.currentActivity = activity;
  s.data.currentCategory = title;
  s.data.disciplineDetail = { title, activity, needles, backMenu };
  s.data.lastDisciplineAnswer = '';
}


function handleAfterActivityAction(data, s, phone, rawText, letter, backMenu){
  if(letter==='A'){
    const act = s.data?.currentActivity || backMenu || 'actividad';
    setMenuContext(s, backMenu === 'basket' ? 'basket_price' : backMenu === 'football' ? 'football_price' : 'activity_price');
    s.data.currentActivity = act;
    return responseContextualPrice(data, act);
  }
  if(letter==='B'){
    return goAdmin(data, s, phone, rawText, 'Usuario pidió hablar con administración desde actividad');
  }
  if(letter==='C'){
    setMenuContext(s, backMenu || 'activities');
    return backMenu === 'basket' ? responseBasketMenu('back') : backMenu === 'football' ? responseFootballMenu('back') : responseActivityMenu();
  }
  if(letter==='D'){
    clearMenuContext(s);
    return panchitoMenu();
  }
  return '';
}


function sportVibe(kind='general'){
  const bank = {
    activities: [
      'Vamos a elegir la jugada correcta 😄',
      'Decime el deporte y yo te acompaño en la asistencia ⚽',
      'Arrancamos tranqui, sin silbato ni VAR 😄',
      'Dale, vemos qué disciplina encaja mejor y salimos jugando 💙',
      'Elegimos deporte sin presión: acá nadie queda en offside por preguntar 😂',
      'Te ayudo a encontrar la actividad ideal, como pase al pie ⚽',
      'Vamos por partes: deporte, edad y después Panchito acomoda la jugada 😄',
      'La idea es simple: vos me contás y yo te oriento 💙',
      'Acá no hay banco de suplentes: todas las consultas entran de titular 🏟️',
      'Vamos con buena onda, que para eso juega Panchito 😄',
      'Elegimos actividad con calma, como técnico armando el equipo 😄',
      'Vos elegís la disciplina y Panchito te da el pase justo 💙',
      'Vamos a ordenar la jugada para que sea fácil elegir 🏟️',
      'Acá la consulta entra jugando de titular 😄',
      'Actividad, edad y categoría: Panchito acomoda todo sin drama ⚽'
    ],
    basket: [
      '¡Buenísima elección! Vamos a encestar esta consulta 🏀',
      'Dale, te doy una mano sin hacer dobles 😄',
      'Básquet en All Boys: picamos la consulta y vamos al aro 🏀',
      'Prometo pasar la info limpia, sin caminarla 😄',
      'Vamos a buscar categoría como asistencia perfecta al aro 🏀',
      'Si hay que elegir rama o edad, lo hacemos fácil y sin tablero complicado 😄',
      'Acá Panchito tira la asistencia; la bandeja la metés vos 🏀',
      'La consulta viene picando, la agarramos y la resolvemos 😄',
      'Vamos con básquet, buena mano y mejor onda 🏀',
      'No hago triples, pero intento responder de tres puntos 😄',
      'Básquet con onda: pase, pique y respuesta clara 🏀',
      'Si la categoría rebota, Panchito toma el rebote y sigue 😄',
      'Vamos al aro de la información sin complicarla 🏀',
      'Con una letra me alcanza para tirar la asistencia 😄',
      'Básquet All Boys: respuesta rápida y al pecho 💙'
    ],
    football: [
      '¡Linda elección! Prometo no cobrar offside por preguntar 😄',
      'Vamos a buscar la categoría sin mandar la pelota a la tribuna ⚽',
      'La pelota al pie y la info clara ⚽',
      'Acá la pelota no se mancha, y la consulta tampoco 😄',
      'Decime edad o año y te tiro un pase a la categoría correcta ⚽',
      'Vamos con fútbol: ordenamos la jugada y salimos por abajo 😄',
      'Si la categoría está difícil, Panchito mete pausa y la acomoda ⚽',
      'Nada de pelotazo largo: respuesta clara y al pie 😄',
      'Vamos con la gambeta de la información 💙',
      'Prometo revisar la jugada antes de responder, sin VAR eterno 😂',
      'Fútbol y buena onda: Panchito juega de enganche ⚽',
      'Vamos a buscar la categoría como pase filtrado 😄',
      'Si hay dudas, levantamos la cabeza y tocamos al compañero 💙',
      'Acá la consulta no se va al lateral 😄',
      'Panchito marca la cancha y te orienta fácil ⚽'
    ],
    gymnastics: [
      'Vamos paso a paso, sin perder el equilibrio 🤸',
      'Acá hacemos piruetas con la info, pero clara 😄',
      'Buena elección, mucha disciplina y mucha onda 🤸',
      'Te oriento con cuidado, sin hacer mortal atrás con la respuesta 😄',
      'Gimnasia artística: elegancia, constancia y Panchito ayudando 💙',
      'Buscamos grupo por edad sin perder la postura 🤸',
      'La consulta sale prolija, como rutina bien entrenada 😄',
      'Vamos a estirar la info hasta que quede clara 🤸',
      'Te acompaño paso a paso, sin resbalones 😄',
      'Acá la única vuelta complicada es la de la rutina; la respuesta va simple 💙',
      'Gimnasia con energía: equilibrio, sonrisa y respuesta clara 🤸',
      'Panchito prepara la colchoneta y ordena la consulta 😄',
      'Vamos a caer bien parados con la información 💙',
      'Elegimos categoría sin perder la línea 🤸',
      'Si la consulta da vueltas, Panchito la aterriza suave 😄'
    ],
    natatorio: [
      'Al agua, pero el celular dejalo afuera de la pileta 😄',
      'Vamos a nadar esta consulta con calma 🏊',
      'Que lo único profundo sea la pileta, la respuesta va clarita 🏊',
      'Nos tiramos al agua con la info, pero sin salpicar confusión 😄',
      'Natatorio modo activo: buscamos grupo, horario o inscripción 🏊',
      'Tranquilo, esta consulta no se hunde: la sacamos a flote 😄',
      'Panchito se pone antiparras y te orienta 🏊',
      'Vamos brazada por brazada hasta llegar a la respuesta 😄',
      'Si hay cupo o grupo, administración confirma; yo te dejo encaminado 💙',
      'Pileta, horarios, inscripción: tirame la consulta y nadamos juntos 🏊',
      'Natatorio con calma: respiramos y vamos por la info 🏊',
      'Panchito flota, orienta y no se hunde con las dudas 😄',
      'Vamos a buscar grupo sin salpicar respuestas raras 💙',
      'La consulta entra al agua y sale clarita 🏊',
      'Si hay cupos, horarios o edades, vamos brazada a brazada 😄'
    ],
    softbol: [
      'Prometo que esta respuesta no se va de foul 🥎',
      'Vamos con sóftbol, buena pegada y buena info 🥎',
      'Te tiro una respuesta al guante, clarita 😄',
      'Buscamos categoría sin mandar la pelota afuera 🥎',
      'Acá hay swing de consulta y respuesta firme 😄',
      'Sóftbol con buena onda: vamos a resolverlo 🥎',
      'La consulta viene rápida, pero Panchito la atrapa 😄',
      'Respondemos con precisión, directo al guante 🥎',
      'Dale que esta jugada sale limpia 😄',
      'Si hace falta administración, te hago el pase 💙',
      'Sóftbol con swing y respuesta al guante 🥎',
      'Panchito batea la duda y corre a primera 😄',
      'Vamos a elegir grupo sin tirar bola mala 🥎',
      'La consulta viene fuerte, pero acá se agarra 💙',
      'Respuesta limpia, sin foul y con buena onda 😄'
    ],
    paleta: [
      'Te devuelvo la consulta con buen revés 😄',
      'Vamos con paleta, respuesta firme contra el frontón 🏓',
      'La consulta viene, Panchito la devuelve clarita 😄',
      'Buen deporte: reflejos, precisión y buena onda 🏓',
      'Vamos a pegarle bien a la info 😄',
      'Sin rebotes raros: te respondo simple 🏓',
      'Panchito al frontón de consultas 😄',
      'Te oriento con derecha, revés y paciencia 💙',
      'La respuesta vuelve bien colocada 🏓',
      'Si hay dudas, seguimos peloteando hasta aclararlo 😄',
      'Paleta con reflejos: pregunta y Panchito responde rápido 🏓',
      'Vamos al frontón de la info sin rebotes confusos 😄',
      'La consulta pega, vuelve y queda clara 💙',
      'Derecha, revés y datos prolijos 🏓',
      'Si querés otra categoría, seguimos jugando 😄'
    ],
    admin: [
      'Si hace falta hablar con una persona, yo hago el pase como un 10 😄',
      'Te derivo con administración sin vueltas 💙',
      'Panchito hace la asistencia y administración define 🏟️',
      'Vamos a dejar tu consulta bien armada para que te respondan mejor 😄',
      'Administración recibe la pelota y define la jugada 💙',
      'Te llevo con una persona sin hacerte dar vueltas 😄',
      'Panchito prepara el pase y el club te responde 🏟️'
    ]
  };
  return pickRandom(bank[kind] || bank.activities);
}


function topicVibe(kind='general'){
  const bank = {
    payments: [
      'Panchito abre la billetera, pero sin asustarse 😄',
      'Vamos a ordenar la cuota como planilla prolija 💳',
      'Tranqui, vemos pagos sin hacer cuentas raras 😄',
      'Te ayudo con la parte de pagos, sin vueltas y con buena onda 💙',
      'Acá la consulta entra por caja, pero sale clarita 😄',
      'Vamos con cuotas: Panchito revisa y te orienta 💳',
      'Si hay deuda, pago o comprobante, lo bajamos al piso y seguimos ⚽',
      'Vamos a dejar esta consulta de pagos más ordenada que vestuario antes del partido 😄',
      'Panchito no es contador, pero te da una mano con la cuota 💙',
      'Cuotas y pagos: lo vemos tranqui, sin tarjeta amarilla 😄'
    ],
    signup: [
      'Vamos a anotar futuro talento, con prolijidad y buena onda 📝',
      'Arrancamos la inscripción como entrada en calor: paso a paso 😄',
      'Panchito prepara la planilla y vos me pasás los datos 💙',
      'Inscripción en marcha: sin pelotazos, todo claro 📝',
      'Vamos a dejar la solicitud lista para que el club la revise bien 😄',
      'Anotar a alguien al club siempre suma: Panchito te acompaña 💙',
      'Dale, armamos la inscripción como jugada preparada ⚽',
      'Panchito agarra el lápiz virtual y arrancamos 📝',
      'Sumarse al club es una linda jugada; vamos paso a paso 😄',
      'Te llevo por la inscripción sin hacerte correr de más 💙'
    ],
    admin: [
      'Panchito hace el pase y administración define la jugada 📞',
      'Te llevo con una persona del club, sin hacerte dar vueltas 😄',
      'Armo bien la consulta para que administración la reciba clara 💙',
      'Si esto necesita humano, Panchito toca de primera para administración ⚽',
      'Vamos a derivarlo prolijo, como pase al pie 📞',
      'Administración recibe la pelota; yo te ayudo a acomodar el mensaje 😄',
      'Te acompaño hasta administración como buen asistidor 🏟️',
      'Panchito no abandona la jugada: te derivo bien 💙',
      'Vamos directo con administración, sin gambetas raras 😄',
      'Te hago el puente con el club, corto y claro 📞'
    ],
    claims: [
      'Contame tranquilo qué pasó; acá escuchamos sin sacar tarjeta amarilla 😄',
      'Vamos a ordenar el reclamo para que llegue claro al club 💬',
      'Panchito toma nota, sin silbato y sin reto 😄',
      'Si hubo un problema, lo dejamos registrado como corresponde 💙',
      'Dale, lo vemos con calma y lo cargamos prolijo 💬',
      'Acá la queja no se va a la tribuna: la dejamos bien presentada 😄',
      'Panchito escucha, anota y deriva donde corresponde 💙',
      'Vamos paso a paso, sin VAR eterno ni vueltas raras 😄',
      'Tu comentario importa; lo armamos bien para que lo revisen 💬',
      'Si algo no salió bien, lo ponemos en orden y seguimos 💙'
    ],
    members: [
      'Panchito busca el carnet en el bolsillo virtual 🎫',
      'Vamos a revisar la ficha de socio como corresponde 💙',
      'Busco el dato de socio sin hacerte correr la cancha 😄',
      'Carnet, cuota o ficha: Panchito se pone en modo archivo 🎫',
      'Vamos con socios: orden, buena onda y respuesta clara 💙',
      'Panchito revisa la ficha con lupa de club 🔎',
      'Si el socio está cargado, lo encontramos y seguimos 😄',
      'Vamos a mirar tu situación de socio sin vueltas 🎫',
      'Socios es cosa seria, pero Panchito le pone onda 💙',
      'Revisamos la ficha y salimos jugando ⚽'
    ],
    institutional: [
      'Panchito abre la casilla institucional y ordena el pase 📩',
      'Prensa, CV o propuesta: lo derivamos prolijo 💙',
      'Vamos a poner esa propuesta en el carril correcto 😄',
      'Si es para el club, lo dejamos bien presentado 📩',
      'Panchito recibe la idea y la acomoda para que llegue bien 💙'
    ],
    other: [
      'Contame nomás, Panchito intenta ubicar la jugada 😄',
      'Si no entra en el menú, igual lo vemos 💙',
      'Tirame la consulta y la bajamos al piso ⚽',
      'Vamos con esa duda, sin miedo al offside 😄',
      'Panchito escucha y trata de orientarte lo mejor posible 💙'
    ]
  };
  return pickRandom(bank[kind] || bank.other);
}

function categoryVibe(title=''){
  const t = clean(title);
  if(t.includes('sub 17')) return pickRandom(['Categoría fuerte, ya con ritmo de competencia 💪', 'Sub 17 viene con intensidad: Panchito ordena la jugada 😄', 'Acá ya se juega en serio, pero la consulta va simple 🏀']);
  if(t.includes('sub 15')) return pickRandom(['Sub 15: etapa linda para crecer y sumar minutos 💙', 'Vamos con Sub 15, respuesta al pie y sin vueltas 😄', 'Buena categoría para seguir aprendiendo y competir 🏀']);
  if(t.includes('sub 13')) return pickRandom(['Sub 13: seguimos formando juego y equipo 💙', 'Linda edad para aprender, divertirse y competir 😄', 'Panchito te ubica la info sin hacer dobles 🏀']);
  if(t.includes('sub 11') || t.includes('sub 9') || t.includes('escuelita') || t.includes('mosquitos')) return pickRandom(['Ideal para arrancar con confianza y buena onda 😄', 'Acá se aprende jugando, que es lo más lindo 💙', 'Primeros pasos, primeras jugadas y Panchito ayudando 🏀']);
  if(t.includes('pulguitas')) return pickRandom(['Pulguitas: mucha energía, aprendizaje y ternura 🤸', 'Para los más peques, vamos suave y con mucha onda 😄']);
  if(t.includes('escuela')) return pickRandom(['Escuela: aprender, moverse y disfrutar 💙', 'Linda etapa para sumar coordinación y confianza 😄']);
  if(t.includes('promocional')) return pickRandom(['Promocional: ya con más técnica y muchas ganas 🤸', 'Vamos subiendo la dificultad sin perder la sonrisa 😄']);
  if(t.includes('pre feder') || t.includes('federad')) return pickRandom(['Categoría con compromiso y mucha disciplina 💪', 'Acá hay entrenamiento firme y Panchito ordena la info 🤸']);
  if(t.includes('pre infantil')) return pickRandom(['Pre infantil: primeros swings y mucha diversión 🥎', 'Arranque ideal para aprender sóftbol con buena onda 😄']);
  if(t.includes('infantil cadete')) return pickRandom(['Infantil cadete: más juego, más equipo y más ritmo 🥎', 'Panchito busca la info directo al guante 😄']);
  if(t.includes('adultos')) return pickRandom(['Para adultos también hay juego y buena onda 💙', 'Nunca es tarde para sumarse y disfrutar 😄']);
  return pickRandom(['Buena categoría, vamos a ver la info clara 😄', 'Panchito acomoda la consulta y seguimos 💙', 'Dale, vemos esta opción sin vueltas.']);
}

function minorActivityPrompt(age=''){
  const edad = age ? ` de ${age} años` : '';
  return `😊 ¡Qué lindo! Para orientarte bien con tu hijo/a${edad}, primero decime qué actividad le interesa.

Elegí una opción:
A. 🏊 Natatorio / pileta
B. ⚽ Fútbol
C. 🏀 Básquet
D. 🤸 Gimnasia artística
E. 📞 Hablar con administración`;
}

function minorActivityConversationalReply(data, s, activity){
  const age = Number(s?.data?.userAge || 0);
  const edadTxt = age ? ` de ${age} años` : '';
  const key = activity.key;
  const label = activity.label;
  let intro = '';
  let next = '';

  if(key === 'natatorio'){
    intro = `🏊 ¡Excelente! Para un/a peque${edadTxt}, natatorio se confirma según edad, nivel, temporada y cupos.\n\n${age ? ageSmartHint(age,'natatorio') : 'Para ubicarlo bien conviene confirmar grupo y cupo con natatorio.'}`;
    next = `¿Querés que veamos horarios, edades/niveles, inscripción o que te derive a administración?`;
    setTopic(s,'natatorio',{}); setMenuContext(s,'natatorio'); s.data.currentActivity='Natatorio / pileta';
    return `${intro}\n\n${next}\n\nA. 🕒 Horarios\nB. 📝 Inscripción\nC. 👧 Edades y niveles\nD. 📲 Administración`;
  }

  if(key === 'football'){
    const info = age ? {age, birthYear: s.data?.userBirthYear || (new Date().getFullYear()-age), source:'age'} : null;
    const rec = info ? phase6RecommendRule(data, 'Fútbol', info, phase6BranchFromText('hijo varon','Fútbol')) : null;
    intro = `⚽ ¡Qué lindo! En All Boys la pelota arranca desde chicos. ${age ? `Con ${age} años, lo más probable es mirar **${rec?.label || fallbackRecommendedCategory('Fútbol', info) || 'categoría infantil'}**.` : 'Decime la edad o año de nacimiento y te ubico la categoría.'}`;
    setTopic(s,'actividades',{}); setMenuContext(s,'football'); s.data.currentActivity='Fútbol';
    if(rec){ setDiscipline(s,'discipline_detail', `Fútbol - ${rec.label}`, 'Fútbol', [rec.rawCategory, rec.label].filter(Boolean), 'football'); }
    return `${intro}\n\n¿Qué necesitás ahora?\nA. 🕒 Horarios\nB. 💰 Cuotas / precio\nC. 📝 Inscripción\nD. 📲 Administración\n\nTambién podés escribir: “horarios”, “cuánto sale” o “quiero inscribirlo”.`;
  }

  if(key === 'basket'){
    const branch = s.data?.userBranch || '';
    const info = age ? {age, birthYear: s.data?.userBirthYear || (new Date().getFullYear()-age), source:'age'} : null;
    const rec = info ? phase6RecommendRule(data, 'Básquet', info, branch) : null;
    intro = `🏀 ¡Buenísima elección! Vamos a encestar esta consulta. ${age ? `Con ${age} años, puede corresponder **${rec?.label || fallbackRecommendedCategory('Básquet', info) || 'una categoría inicial'}**${branch ? ` (${branch})` : ''}.` : 'Decime si es para chica o chico y la edad, y te ubico mejor.'}`;
    setTopic(s,'actividades',{}); setMenuContext(s,'basket'); s.data.currentActivity='Básquet';
    if(rec){ setDiscipline(s,'discipline_detail', `Básquet - ${rec.label}`, 'Básquet', [rec.rawCategory, rec.label].filter(Boolean), rec.branch === 'femenino' ? 'basket_fem' : 'basket_masc'); }
    return `${intro}\n\n¿Qué querés saber?\nA. 🕒 Horarios\nB. 💰 Cuotas / precio\nC. 📝 Inscripción\nD. 👨‍🏫 Profesor/a\nE. 📲 Administración\n\nSi preferís, escribí directo “horarios”, “precio” o “inscripción”.`;
  }

  if(key === 'gymnastics'){
    const info = age ? {age, birthYear: s.data?.userBirthYear || (new Date().getFullYear()-age), source:'age'} : null;
    const rec = info ? phase6RecommendRule(data, 'Gimnasia Artística', info, '') : null;
    intro = `🤸 ¡Hermosa disciplina! Vamos paso a paso, sin perder el equilibrio 😄 ${age ? `Con ${age} años, probablemente corresponda **${rec?.label || fallbackRecommendedCategory('Gimnasia Artística', info) || 'un grupo por edad'}**.` : 'Decime la edad y te ubico el grupo.'}`;
    setTopic(s,'actividades',{}); setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística';
    if(rec){ setDiscipline(s,'discipline_detail', `Gimnasia Artística - ${rec.label}`, 'Gimnasia Artística', [rec.rawCategory, rec.label].filter(Boolean), 'gymnastics'); }
    return `${intro}\n\n¿Qué necesitás?\nA. 🕒 Horarios\nB. 💰 Cuotas / precio\nC. 📝 Inscripción\nD. 👩‍🏫 Profesor/a\nE. 📲 Administración`;
  }

  return directActivityReply(data, activity, '', s);
}



// V57 - Memoria conversacional real + emoción por contexto.
// Guarda datos útiles aunque el usuario los diga sueltos: edad, rama, deporte y última intención.
function rememberConversationFacts(s, rawText='', activity=null){
  s.data = s.data || {};
  const t = normalizeUserText(rawText);
  const ageInfo = extractAgeOrBirthYear(rawText);
  if(ageInfo){
    s.data.userAge = ageInfo.age;
    s.data.userBirthYear = ageInfo.birthYear;
  }
  const branch = phase6BranchFromText(rawText, activity?.label || s.data.currentActivity || '');
  if(branch) s.data.userBranch = branch;
  if(activity){
    s.data.currentActivity = activity.label;
    s.data.lastActivityKey = activity.key;
  }
  const intent = phase6Intent(rawText);
  if(intent) s.data.lastNaturalIntent = intent;
  s.updatedAt = new Date().toISOString();
}

function memoryLabel(s){
  const bits=[];
  if(s?.data?.userAge) bits.push(`${s.data.userAge} años`);
  if(s?.data?.userBranch) bits.push(s.data.userBranch === 'femenino' ? 'femenino' : s.data.userBranch === 'masculino' ? 'masculino' : s.data.userBranch);
  if(s?.data?.currentActivity) bits.push(s.data.currentActivity);
  return bits.length ? bits.join(' · ') : '';
}

function contextEmotionForActivity(activity){
  const key = activity?.key || clean(activity?.label || '');
  if(key === 'football' || key.includes('futbol')) return sportVibe('football');
  if(key === 'basket' || key.includes('basquet')) return sportVibe('basket');
  if(key === 'natatorio' || key.includes('natatorio') || key.includes('pileta')) return sportVibe('natatorio');
  if(key === 'gymnastics' || key.includes('gimnasia')) return sportVibe('gymnastics');
  if(key === 'softbol' || key.includes('softbol')) return sportVibe('softbol');
  if(key === 'paleta' || key.includes('paleta')) return sportVibe('paleta');
  return sportVibe('activities');
}

function activityAgeInvalidOptions(activity='la actividad'){
  return `¿Qué querés hacer?

A. 🔄 Cambiar la edad
B. 📋 Ver categorías de ${activity}
C. 🏟️ Ver otras actividades
D. 📞 Hablar con administración
E. 🏠 Menú principal`;
}

function replyOnlyAgeRemembered(data, s, rawText=''){
  const ageInfo = extractAgeOrBirthYear(rawText);
  if(!ageInfo) return '';
  // Si solo dijo una edad/año, la guardamos.
  if(detectActivityFreeText(rawText)) return '';
  if(phase6Intent(rawText)) return '';

  const currentActivity = s.data?.currentActivity || '';
  const currentMenu = getMenuContext(s) || '';
  const hasActivityContext = !!currentActivity && ['gymnastics','football','basket','basket_fem','basket_masc','basket_init','softbol','paleta','activities','price_discipline_detail','discipline_detail'].includes(currentMenu);
  s.data = { ...(s.data||{}), userAge: ageInfo.age, userBirthYear: ageInfo.birthYear };
  const dataLabel = ageInfo.source === 'year' ? `año ${ageInfo.birthYear}` : `${ageInfo.age} años`;

  // V79: si ya estaba dentro de una disciplina, no se pierde el deporte.
  // Antes, al escribir por ejemplo "1" dentro de Gimnasia, Panchito volvía a preguntar actividad.
  // Ahora mantiene la actividad actual y ofrece caminos claros.
  if(hasActivityContext){
    const tooYoung = tooYoungMessage(currentActivity, ageInfo);
    const rec = phase6RecommendRule(data, currentActivity, ageInfo, s.data?.userBranch || '');
    if(tooYoung){
      s.data.ageInvalidActivity = currentActivity;
      s.data.ageInvalidBackMenu = currentMenu === 'activities' ? (activityFromMemory(s)?.key || 'activities') : currentMenu;
      setMenuContext(s,'activity_age_invalid');
      return `⚠️ ${tooYoung}

No sigo con la inscripción ni te cambio de deporte, así no cargamos algo que después no corresponda.

${activityAgeInvalidOptions(currentActivity)}`;
    }
    if(rec){
      s.data.currentCategory = rec.label || s.data.currentCategory;
      return `😊 Perfecto, ya me guardé el dato: **${dataLabel}**.

Para **${currentActivity}**, por esa edad te recomiendo: **${rec.label}**.

¿Qué querés consultar ahora?

A. 📅 Horarios
B. 💰 Costo / cuota
C. 📝 Iniciar inscripción
D. 👨‍🏫 Profesor/a
E. 📞 Administración`;
    }
    return `😊 Perfecto, ya me guardé el dato: **${dataLabel}**.

Seguimos en **${currentActivity}**. Administración confirma grupo, cupo y categoría final.

${activityAgeInvalidOptions(currentActivity)}`;
  }

  setMenuContext(s,'human_minor_activity');
  return `😊 Perfecto, ya me guardé el dato: **${dataLabel}**.

Ahora decime qué actividad le interesa y lo ubicamos mejor.

A. 🏊 Natatorio / pileta
B. ⚽ Fútbol
C. 🏀 Básquet
D. 🤸 Gimnasia artística
E. 📞 Hablar con administración`;
}

function replyActivityWithMemory(data, s, rawText='', phone='demo'){
  const activity = detectActivityFreeText(rawText);
  if(!activity) return '';
  rememberConversationFacts(s, rawText, activity);
  const ageInfo = s.data?.userAge ? { age:Number(s.data.userAge), birthYear:s.data.userBirthYear || (new Date().getFullYear()-Number(s.data.userAge)), source:'memory' } : extractAgeOrBirthYear(rawText);
  const branch = s.data?.userBranch || phase6BranchFromText(rawText, activity.label);
  const intent = phase6Intent(rawText);

  setTopic(s,'actividades',{});
  setMenuContext(s, activity.key === 'natatorio' ? 'natatorio' : activity.key);

  // Natatorio no usa categoría deportiva por edad: responde directo con memoria.
  if(activity.key === 'natatorio'){
    const intro = `🏊 ¡Vamos con natatorio! ${contextEmotionForActivity(activity)}`;
    const mem = memoryLabel(s);
    return `${intro}${mem ? `\n\nTengo anotado: ${mem}.` : ''}\n\n${directActivityReply(data, activity, rawText, s)}`;
  }

  if(ageInfo){
    const tooYoung = tooYoungMessage(activity.label, ageInfo);
    if(tooYoung){
      return `⚠️ ${tooYoung}\n\n${contextEmotionForActivity(activity)}\n\nSi querés, te muestro otras actividades para esa edad o te derivo con administración.`;
    }
    const rec = phase6RecommendRule(data, activity.label, ageInfo, branch);
    if(rec){
      const title = `${activity.label}${rec.label ? ' - ' + rec.label : ''}`;
      setDiscipline(s,'discipline_detail', title, activity.label, [rec.rawCategory, rec.label].filter(Boolean), activity.key);
      s.data.userAge = ageInfo.age;
      s.data.userBirthYear = ageInfo.birthYear;
      s.data.userBranch = branch || rec.branch || '';
      const dataLabel = ageInfo.source === 'year' ? `año ${ageInfo.birthYear}` : `${ageInfo.age} años`;
      if(intent === 'schedule') return disciplineAnswer(data, s, 'schedule');
      if(intent === 'price') return disciplineAnswer(data, s, 'price');
      if(intent === 'teacher') return disciplineAnswer(data, s, 'teacher');
      if(intent === 'admin') return goAdmin(data, s, phone, rawText, `Contacto por ${title}`);
      if(intent === 'inscription') return startSignupFlow(data, s, activity.label, title);
      return `${contextEmotionForActivity(activity)}\n\nTengo anotado: **${dataLabel}**${branch ? ` · **${branch}**` : ''}.\n\nPor esos datos, te recomiendo **${rec.label}**.\n\n¿Qué querés que te pase ahora?\n\nA. 📅 Horarios\nB. 💰 Costo / cuota\nC. 📝 Iniciar inscripción\nD. 👨‍🏫 Profesor/a\nE. 📲 WhatsApp / administración`;
    }
  }

  return directActivityReply(data, activity, rawText, s);
}

function replyContextualMemory(data, s, rawText='', phone='demo'){
  // 1) Edad suelta: "9", "9 años", "2017".
  const onlyAge = replyOnlyAgeRemembered(data, s, rawText);
  if(onlyAge) return onlyAge;

  // 2) Deporte suelto después de haber dicho edad/rama.
  const activityMemory = replyActivityWithMemory(data, s, rawText, phone);
  if(activityMemory) return activityMemory;

  // 3) Intención suelta con contexto: "horarios", "cuánto sale", "inscripción".
  const kind = phase6Intent(rawText) || disciplineFollowUpKind(rawText);
  if(kind && s.data?.disciplineDetail && ['schedule','teacher','price','inscription','admin'].includes(kind)){
    if(kind === 'admin') return goAdmin(data, s, phone, rawText, `Usuario pidió contacto desde ${s.data.disciplineDetail.title || 'disciplina'}`);
    return disciplineAnswer(data, s, kind);
  }
  if(kind && activityFromMemory(s) && ['schedule','price','inscription','admin'].includes(kind)){
    const remembered = activityFromMemory(s);
    if(kind === 'admin') return goAdmin(data, s, phone, rawText, `Usuario pidió contacto por ${remembered.label}`);
    return directActivityReply(data, remembered, rawText, s);
  }
  return '';
}

function responseActivityMenu(){
  return `¡Dale! ¿Qué actividad querés consultar?

A. Gimnasia artística 🤸
B. Básquet 🏀
C. Sóftbol 🥎
D. Pelota a paleta 🏓
E. Fútbol ⚽
F. Natación 🏊
G. Volver al menú principal

Respondé con una letra o escribí el nombre de la actividad.`;
}


function responseUnknownActivity(data, activityName='esa actividad'){
  const name = String(activityName || 'esa actividad').trim();
  return `No encontré **${name}** dentro de las actividades cargadas del club.

Por ahora puedo ayudarte con:
• 🤸 Gimnasia artística
• 🏀 Básquet
• 🥎 Sóftbol
• 🏓 Pelota a paleta
• ⚽ Fútbol
• 🏊 Natatorio / pileta

Si querés, escribí el nombre de una de esas actividades o MENÚ para volver al inicio.

Si necesitás confirmar si el club sumó ${name}, te dejo Administración:
${adminContact(data)}`;
}


function responseBasketAll(mode='normal'){
  const intro = mode === 'back' ? `🔙 Volvimos a Básquet.` : `🏀 ¡Vamos con Básquet!`;
  return `${intro}

Estos son todos los grupos y horarios disponibles:

BÁSQUET FEMENINO
• Martes y jueves:
  - Sub 17 y Primera: de 16 a 17.15 hs.
  - Sub 13 y Sub 15: de 17.15 a 18.30 hs.
  - Sub 11: de 18.30 a 19.30 hs.
• Viernes:
  - Sub 17 y Primera: de 16.30 a 18 hs.
• Sábados:
  - Sub 13: de 8.30 a 9.30 hs.
  - Sub 15: de 9.30 a 10.30 hs.
  - Sub 11: de 10 a 11 hs.

BÁSQUET MASCULINO
• Sub 17: lunes y miércoles de 16.30 a 18 hs; viernes de 15 a 16.30 hs.
• Preparación física Sub 17: lunes de 15.30 a 16.30 hs; martes y jueves de 15.30 a 16.30 hs.
• Sub 13: lunes y miércoles de 20 a 21 hs; martes y jueves de 18.30 a 19.30 hs.
• Preparación física Sub 13: martes y jueves de 17.30 a 18.30 hs.
• Sub 15: lunes y miércoles de 15 a 16.30 hs; viernes de 16.30 a 18 hs.
• Preparación física Sub 15: martes y jueves de 16.30 a 17.30 hs.
• Primera división: martes y jueves de 20.30 a 22 hs.
• Asociativo: martes y jueves de 19.30 a 20.30 hs; viernes de 20 a 21 hs.

ESCUELITA Y CATEGORÍAS INICIALES
• Sub 9: lunes, miércoles y viernes de 18 a 19 hs; sábados de 9 a 10 hs.
• Sub 11: lunes, miércoles y viernes de 19 a 20 hs; sábados de 9 a 10 hs.
• Escuelita: lunes, miércoles y viernes de 18 a 19 hs.
• Mosquitos: lunes, miércoles y viernes de 19 a 20 hs.

Para consultar edades, precios, cupos o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otra actividad
B. Volver al menú principal
C. Hablar con Administración`;
}

function responseFootballAll(mode='normal'){
  const intro = mode === 'back' ? `🔙 Volvimos a Fútbol.` : `⚽ ¡Vamos con Fútbol!`;
  return `${intro}

Estos son todos los grupos y horarios disponibles:

• Cuarta, Quinta y Sexta División: lunes a viernes a las 16 hs.
• Séptima y Octava División: lunes, miércoles, jueves y viernes a las 18 hs.
• Novena y Décima División: lunes a jueves a las 18 hs.
• Categoría 2017: lunes, miércoles y viernes de 18 a 19.30 hs.
• Categoría 2018: martes, jueves y viernes de 18 a 19.30 hs.
• Categoría 2019: lunes, miércoles y viernes de 18 a 19.30 hs.
• Categorías 2020 y 2021: martes, jueves y viernes de 18 a 19.30 hs.
• Fútbol femenino Sub 12 y Sub 14: lunes, miércoles y viernes de 18 a 19.30 hs.

Para consultar edades, precios, lugar de entrenamiento o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otra actividad
B. Volver al menú principal
C. Hablar con Administración`;
}

function responseBasketMenu(mode='normal'){
  return `¡Vamos con Básquet! 🏀

¿Qué querés consultar?
A. Básquet femenino
B. Básquet masculino
C. Escuelita y categorías iniciales
D. Volver a actividades
E. Volver al menú principal`;
}

function responseFootballMenu(mode='normal'){
  return `¡Vamos con Fútbol! ⚽

¿Qué categoría querés consultar?
A. Cuarta, Quinta y Sexta División
B. Séptima y Octava División
C. Novena y Décima División
D. Categorías 2017, 2018, 2019, 2020 y 2021
E. Femenino Sub 12 y Sub 14
F. Volver a actividades
G. Volver al menú principal`;
}

function responseGymnastics(mode='normal'){
  const intro = mode === 'back' ? `🔙 Volvimos a Gimnasia artística.` : `🤸 ¡Vamos con Gimnasia artística!\n${sportVibe('gymnastics')}`;
  return `${intro}

Estos son todos los grupos y horarios disponibles:

• Pulgas (3 y 4 años): martes y jueves de 18 a 19 hs.
• Escuela (5 a 7 años): martes y jueves de 19 a 20 hs.
• Promocional (8 a 10 años): lunes, miércoles y viernes de 18 a 19 hs.
• Pre federadas (11 años en adelante): lunes, miércoles y viernes de 19 a 20 hs.
• Federadas: lunes a viernes de 15 a 18 hs y de 20 a 21.30 hs.

${officialContactIntro('Gimnasia artística')}

¿Qué querés hacer ahora?
A. 🏅 Consultar otra actividad
B. 🏠 Menú principal
C. 📞 Hablar con Administración`;
}

function responseSoftbol(mode='normal'){
  const intro = mode === 'back' ? `🔙 Volvimos a Sóftbol.` : `🥎 ¡Vamos con Sóftbol!\n${sportVibe('softbol')}`;
  return `${intro}

Estos son todos los grupos y horarios disponibles:

• Pre infantil mixto: martes y jueves de 18 a 19.15 hs.
• Infantil cadete mixto: lunes, miércoles y viernes de 18 a 19.30 hs.
• Femenino: miércoles y viernes de 20 a 21.30 hs.

${officialContactIntro('Sóftbol', 'edades, precios, cupos o inscripción')}

¿Qué querés hacer ahora?
A. 🏅 Consultar otra actividad
B. 🏠 Menú principal
C. 📞 Hablar con Administración`;
}

function responsePaleta(mode='normal'){
  const intro = mode === 'back' ? `🔙 Volvimos a Pelota a paleta.` : `🏓 ¡Vamos con Pelota a paleta!\n${sportVibe('paleta')}`;
  return `${intro}

Estos son todos los grupos y horarios disponibles:

• Niños y niñas de 6 a 12 años: martes y jueves de 18 a 19 hs; sábados de 10.30 a 12.30 hs.
• Adultos: martes y jueves de 17 a 18 hs.

${officialContactIntro('Pelota a paleta')}

¿Qué querés hacer ahora?
A. 🏅 Consultar otra actividad
B. 🏠 Menú principal
C. 📞 Hablar con Administración`;
}

function responseBasketFemenino(mode='normal'){
  return `Horarios de Básquet femenino 🏀

Martes y jueves:
• Sub 17 y Primera: de 16 a 17.15 hs.
• Sub 13 y Sub 15: de 17.15 a 18.30 hs.
• Sub 11: de 18.30 a 19.30 hs.
Viernes:
• Sub 17 y Primera: de 16.30 a 18 hs.
Sábados:
• Sub 13: de 8.30 a 9.30 hs.
• Sub 15: de 9.30 a 10.30 hs.
• Sub 11: de 10 a 11 hs.

Para consultar precios, cupos o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otro grupo de Básquet
B. Consultar otra actividad
C. Volver al menú principal
D. Hablar con Administración`;
}

function responseBasketMasculino(mode='normal'){
  return `Horarios de Básquet masculino 🏀

• Sub 17: lunes y miércoles de 16.30 a 18 hs; viernes de 15 a 16.30 hs.
• Preparación física Sub 17: lunes de 15.30 a 16.30 hs; martes y jueves de 15.30 a 16.30 hs.
• Sub 13: lunes y miércoles de 20 a 21 hs; martes y jueves de 18.30 a 19.30 hs.
• Preparación física Sub 13: martes y jueves de 17.30 a 18.30 hs.
• Sub 15: lunes y miércoles de 15 a 16.30 hs; viernes de 16.30 a 18 hs.
• Preparación física Sub 15: martes y jueves de 16.30 a 17.30 hs.
• Primera división: martes y jueves de 20.30 a 22 hs.
• Asociativo: martes y jueves de 19.30 a 20.30 hs; viernes de 20 a 21 hs.

Para consultar precios, cupos o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otro grupo de Básquet
B. Consultar otra actividad
C. Volver al menú principal
D. Hablar con Administración`;
}

function responseBasketInicial(mode='normal'){
  return `Horarios de Básquet para categorías iniciales 🏀

• Sub 9: lunes, miércoles y viernes de 18 a 19 hs; sábados de 9 a 10 hs.
• Sub 11: lunes, miércoles y viernes de 19 a 20 hs; sábados de 9 a 10 hs.
• Escuelita: lunes, miércoles y viernes de 18 a 19 hs.
• Mosquitos: lunes, miércoles y viernes de 19 a 20 hs.

Para consultar edades, precios, cupos o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otro grupo de Básquet
B. Consultar otra actividad
C. Volver al menú principal
D. Hablar con Administración`;
}


function footballWordDetail(title, schedule){
  return `${title} ⚽
${schedule}

Para consultar edades, precios, lugar de entrenamiento o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otra categoría de Fútbol
B. Consultar otra actividad
C. Volver al menú principal
D. Hablar con Administración`;
}
function responseFootballYearsWord(){
  return `Horarios de Fútbol por categoría ⚽

1. Categoría 2017: lunes, miércoles y viernes de 18 a 19.30 hs.
2. Categoría 2018: martes, jueves y viernes de 18 a 19.30 hs.
3. Categoría 2019: lunes, miércoles y viernes de 18 a 19.30 hs.
4. Categorías 2020 y 2021: martes, jueves y viernes de 18 a 19.30 hs.

Para consultar precios, lugar de entrenamiento o inscripción:
Secretaría Club All Boys
Agustina Barreto
WhatsApp: 2954 60-9312

¿Qué querés hacer ahora?
A. Consultar otra categoría de Fútbol
B. Consultar otra actividad
C. Volver al menú principal
D. Hablar con Administración`;
}

function responseFootballA(data){
  return disciplineDetail(data, '⚽ Cuarta, Quinta y Sexta División', 'Fútbol', ['Cuarta', 'Quinta', 'Sexta'], 'football');
}

function responseFootballB(data){
  return disciplineDetail(data, '⚽ Séptima y Octava División', 'Fútbol', ['Séptima', 'Septima', 'Octava'], 'football');
}

function responseFootballC(data){
  return disciplineDetail(data, '⚽ Novena y Décima División', 'Fútbol', ['Novena', 'Décima', 'Decima'], 'football');
}

function responseFootballD(){
  return `⚽ Fútbol por categorías

¿Qué categoría querés consultar?

A. Categoría 2017
B. Categoría 2018
C. Categoría 2019
D. Categorías 2020-2021
E. Volver a fútbol
F. Volver al menú principal`;
}

function responseFootballE(data){
  return disciplineDetail(data, '⚽ Femenino Sub 12 y Sub 14', 'Fútbol', ['Femenino'], 'football');
}

function responsePricesMenu(){
  return `Te ayudo con precios e inscripción 📝

¿Qué necesitás?
A. Consultar el precio de una actividad
B. Inscribirme en una actividad
C. Asociarme al club
D. Inscripción para un menor
E. Volver al menú principal`;
}


function responseNatatorioMenu(isMinor=false){
  const intro = `Para consultar por Natación, comunicate directamente con el coordinador del área 🏊

${officialActivityContact('Natación')}

Natación cuenta con diferentes niveles, edades, horarios y opciones de clases. Además, los cupos pueden variar, por eso el coordinador te va a indicar cuál es la alternativa más adecuada y si hay disponibilidad.

Para que pueda orientarte mejor, podés enviarle:
• Edad de la persona interesada.
• Si sabe nadar o está comenzando.
• Días u horarios disponibles.`;

  return `${intro}

¿Qué querés hacer ahora?
A. Consultar otra actividad
B. Consultar el Plan de Natación
C. Volver al menú principal
D. Hablar con Administración`;
}


function responseNatatorioNextMenu(option=''){
  const opts = [];
  if(option !== 'horarios') opts.push('📅 Horarios');
  if(option !== 'inscripcion') opts.push('📝 Inscripción');
  if(option !== 'costos') opts.push('💲 Costos / cuotas');
  if(option !== 'whatsapp') opts.push('📲 WhatsApp Natatorio');
  opts.push('🏠 Menú principal');
  const letters = ['A','B','C','D','E'];
  return `

¿Qué querés consultar ahora?
${opts.map((o,i)=>`${letters[i]}. ${o}`).join('\n')}`;
}

function natatorioAfterOptionByLetter(last='', letter=''){
  const opts = [];
  if(last !== 'horarios') opts.push('horarios');
  if(last !== 'inscripcion') opts.push('inscripcion');
  if(last !== 'costos') opts.push('costos');
  if(last !== 'whatsapp') opts.push('whatsapp');
  opts.push('menu');
  const idx = ['A','B','C','D','E'].indexOf(String(letter||'').toUpperCase());
  return idx >= 0 ? opts[idx] : '';
}

function responseNatatorioOption(data, option){
  let body = '';
  if(option === 'horarios'){
    body = `🏊 Horarios de natatorio

Los horarios se organizan según edad y nivel.

Si me indicás la edad (por ejemplo 5, 8 o 12 años), puedo orientarte mejor antes de derivarte a Administración.`;
  } else if(option === 'inscripcion'){
    body = `📝 Inscripción a natatorio

¿Qué edad tiene el menor o la persona interesada?

Con esa información puedo orientarte mejor sobre los grupos y niveles disponibles.`;
  } else if(option === 'edades'){
    body = `👧👦 Edades y niveles

Puede haber propuestas para niños y niñas, pero la edad mínima y el grupo correspondiente se confirman según temporada, nivel y disponibilidad.

Si consultás por un menor, indicá la edad para que puedan orientarte mejor.`;
  } else if(option === 'cupos'){
    body = `📌 Cupos disponibles

Los cupos de natatorio pueden cambiar durante la temporada.

Administración puede confirmarte la disponibilidad actual y el turno más conveniente.`;
  }

  const contact = option === 'whatsapp' ? `

${activityWhatsAppLine(data, 'Natatorio / pileta')}` : `

${adminContact(data)}`;
  return `${body}${contact}${responseNatatorioNextMenu(option)}`;
}


function responseInstitutionalMenu(){
  return `Gracias por escribirle al club 📩

¿Qué querés enviar?
A. Consulta de prensa o medios
B. Dejar un CV
C. Proponer un proyecto
D. Ofrecer productos o servicios
E. Sponsoreo, publicidad o auspicio`;
}
function institutionalDetail(kind){
  const common=`\n\n¿Qué querés hacer ahora?\nA. Volver al menú institucional\nB. Volver al menú principal`;
  if(kind==='press') return `Consulta de prensa o medios\n\nEnviá:\n• Nombre y medio.\n• Motivo de la consulta.\n• Fecha o evento relacionado.\n• Teléfono y correo electrónico.\n\nContacto:\nPresidencia\nJosé Luis Roston\nWhatsApp: 2954 59-3557${common}`;
  if(kind==='cv') return `Dejar CV\n\nEnviá:\n• Nombre y apellido.\n• Área o actividad de interés.\n• Experiencia.\n• Teléfono y correo electrónico.\n• CV adjunto.\n\nContacto:\nSecretaría Club All Boys\nAgustina Barreto\nWhatsApp: 2954 60-9312${common}`;
  if(kind==='project') return `Proponer un proyecto\n\nEnviá:\n• Nombre y apellido.\n• Tipo de proyecto.\n• Resumen breve.\n• Público al que está dirigido.\n• Teléfono y correo electrónico.\n\nContactos:\nSecretaría Club All Boys - Agustina Barreto - WhatsApp: 2954 60-9312\nPresidencia - José Luis Roston - WhatsApp: 2954 59-3557${common}`;
  if(kind==='provider') return `Ofrecer productos o servicios\n\nEnviá:\n• Nombre o empresa.\n• Rubro.\n• Producto o servicio ofrecido.\n• Teléfono y correo electrónico.\n\nContacto:\nSecretaría Club All Boys\nAgustina Barreto\nWhatsApp: 2954 60-9312${common}`;
  return `Sponsoreo, publicidad o auspicio\n\nEnviá:\n• Nombre o empresa.\n• Tipo de propuesta.\n• Teléfono y correo electrónico.\n• Breve detalle de la propuesta.\n\nContacto:\nPresidencia\nJosé Luis Roston\nWhatsApp: 2954 59-3557${common}`;
}
function responsePredio(){
  return `Para consultas del Predio:\n\nAll Boys Predio\nRuta 35, pegado al Aeropuerto\nWhatsApp: 2954 37-0053\n\n¿Qué querés hacer ahora?\nA. Volver al menú principal\nB. Hablar con Secretaría del Club`;
}

function responsePaymentsMenu(){
  return `💳 Vamos con cuotas y pagos.
${topicVibe('payments')}

¿Qué necesitás?

A. 🔎 Consultar si tengo deuda
B. ✅ Avisar que ya pagué
C. 🏦 Consultar medios de pago
D. 📞 Hablar con administración
E. 🏠 Volver al menú principal`;
}


function responseClaimMenu(){
  return `💬 Dale, contame qué pasó.
${topicVibe('claims')}

Voy a registrar el reclamo paso por paso para que administración pueda revisarlo correctamente. ✅

1/4 Escribime el nombre y apellido.`;
}

function claimStepPrompt(step){
  const prompts = {
    name: '1/4 Escribime el nombre y apellido.',
    phone: '2/4 Ahora pasame un teléfono de contacto.',
    area: '3/4 ¿A qué área o actividad está relacionado? Por ejemplo: básquet, fútbol, natatorio, socios, administración.',
    detail: '4/4 Contame qué ocurrió o qué sugerencia querés dejar.'
  };
  return prompts[step] || prompts.dni;
}

function claimSummary(draft={}){
  return `Reclamo cargado:
Nombre y apellido: ${draft.name || '-'}
Teléfono: ${draft.phone || '-'}
Área/actividad: ${draft.area || '-'}
Qué ocurrió: ${draft.detail || '-'}`;
}


// ================= V103 - FLUJOS OFICIALES DEL DOCUMENTO DEL CLUB =================
const V103_CONTACTS = {
  secretaria: 'Secretaría Club All Boys\nWhatsApp: 2954 592313',
  futbol: 'Secretaría Club All Boys\nWhatsApp: 2954 370053',
  gimnasia: 'Patricia “Pato” Saavedra\nResponsable de Gimnasia artística\nWhatsApp: 2954 29-6451',
  softbol: 'Ángel Yorgoban\nResponsable de Sóftbol\nWhatsApp: 2954 66-4276',
  paleta: 'Lucas Gómez\nResponsable de Pelota a paleta\nWhatsApp: 2954 44-6373',
  natacion: 'José Luis “Chino” Weighant\nWhatsApp: 2954 36-9045',
  email: 'allboyseslapampa@gmail.com'
};

function v103MainMenu(mode='volver'){
  const head = mode === 'inicio'
    ? '¡Hola! Soy Panchito, el asistente virtual de All Boys 🤖🔵🟡\nBip bip, rueditas listas. ¿En qué te puedo ayudar?'
    : 'Volvemos al menú principal 🤖🔵🟡';
  return `${head}\n\nA. Actividades, días y horarios 🏀⚽🤸\nB. Precios e inscripción 📝\nC. Cuotas y pagos 💳\nD. Hablar con Administración 📞\nE. Reclamos o sugerencias 💬\nF. Prensa, CV, proveedores o propuestas 📩\nG. Predio 📍\nH. Otra consulta 🔎`;
}

function v103Activities(){ return `¡Dale! ¿Qué actividad querés consultar? 🤖\n\nA. Gimnasia artística 🤸\nB. Básquet 🏀\nC. Sóftbol\nD. Pelota a paleta\nE. Fútbol ⚽\nF. Natación 🏊\nG. Volver al menú principal\n\nRespondé con una letra o escribí el nombre de la actividad.`; }
function v103AfterActivity(kind='otra'){ return `\n\n¿Qué querés hacer ahora?\nA. Consultar otra actividad\nB. Volver al menú principal\nC. Hablar con Administración`; }
function v103Gym(){ return `Estos son los horarios de Gimnasia artística 🤸\n\nA. Pulgas, 3 y 4 años\nMartes y jueves de 18 a 19 hs.\n\nB. Escuela, 5 a 7 años\nMartes y jueves de 19 a 20 hs.\n\nC. Promocional, 8 a 10 años\nLunes, miércoles y viernes de 18 a 19 hs.\n\nD. Pre federadas, 11 años en adelante\nLunes, miércoles y viernes de 19 a 20 hs.\n\nE. Federadas\nLunes a viernes de 15 a 18 hs.\nTambién de lunes a viernes de 20 a 21.30 hs.\n\nPara consultar precios, cupos o inscripción:\n${V103_CONTACTS.gimnasia}${v103AfterActivity()}`; }
function v103Basket(){ return `¡Vamos con Básquet! 🏀\n¿Qué querés consultar?\n\nA. Básquet femenino\nB. Básquet masculino\nC. Escuelita y categorías iniciales\nD. Volver a actividades\nE. Volver al menú principal`; }
function v103BasketFem(){ return `Horarios de Básquet femenino 🏀\n\nMartes y jueves:\nSub 17 y Primera: de 16 a 17.15 hs.\nSub 13 y Sub 15: de 17.15 a 18.30 hs.\nSub 11: de 18.30 a 19.30 hs.\n\nViernes:\nSub 17 y Primera: de 16.30 a 18 hs.\n\nSábados:\nSub 13: de 8.30 a 9.30 hs.\nSub 15: de 9.30 a 10.30 hs.\nSub 11: de 10 a 11 hs.\n\nPara consultar precios, cupos o inscripción:\n${V103_CONTACTS.secretaria}\n\n¿Qué querés hacer ahora?\nA. Consultar otro grupo de Básquet\nB. Consultar otra actividad\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103BasketMasc(){ return `Horarios de Básquet masculino 🏀\n\nSub 17:\nLunes y miércoles de 16.30 a 18 hs.\nViernes de 15 a 16.30 hs.\nPreparación física: lunes de 15.30 a 16.30 hs.; martes y jueves de 15.30 a 16.30 hs.\n\nSub 13:\nLunes y miércoles de 20 a 21 hs.\nMartes y jueves de 18.30 a 19.30 hs.\nPreparación física: martes y jueves de 17.30 a 18.30 hs.\n\nSub 15:\nLunes y miércoles de 15 a 16.30 hs.\nViernes de 16.30 a 18 hs.\nPreparación física: martes y jueves de 16.30 a 17.30 hs.\n\nPrimera división:\nMartes y jueves de 20.30 a 22 hs.\n\nAsociativo:\nMartes y jueves de 19.30 a 20.30 hs.\nViernes de 20 a 21 hs.\n\nPara consultar precios, cupos o inscripción:\n${V103_CONTACTS.secretaria}\n\n¿Qué querés hacer ahora?\nA. Consultar otro grupo de Básquet\nB. Consultar otra actividad\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103BasketInitial(){ return `Horarios de Básquet para categorías iniciales 🏀\n\nSub 9:\nLunes, miércoles y viernes de 18 a 19 hs.\nSábados de 9 a 10 hs.\n\nSub 11:\nLunes, miércoles y viernes de 19 a 20 hs.\nSábados de 9 a 10 hs.\n\nEscuelita:\nLunes, miércoles y viernes de 18 a 19 hs.\n\nMosquitos:\nLunes, miércoles y viernes de 19 a 20 hs.\n\nPara consultar edades, precios, cupos o inscripción:\n${V103_CONTACTS.secretaria}\n\n¿Qué querés hacer ahora?\nA. Consultar otro grupo de Básquet\nB. Consultar otra actividad\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103Softbol(){ return `Horarios de Sóftbol\n\nA. Pre infantil mixto\nMartes y jueves de 18 a 19.15 hs.\n\nB. Infantil cadete mixto\nLunes, miércoles y viernes de 18 a 19.30 hs.\n\nC. Femenino\nMiércoles y viernes de 20 a 21.30 hs.\n\nPara consultar edades, precios, cupos o inscripción:\n${V103_CONTACTS.softbol}${v103AfterActivity()}`; }
function v103Paleta(){ return `Horarios de Pelota a paleta:\n\nA. Niños y niñas de 6 a 12 años\nMartes y jueves de 18 a 19 hs.\nSábados de 10.30 a 12.30 hs.\n\nB. Adultos\nMartes y jueves de 17 a 18 hs.\n\nPara consultar precios, cupos o inscripción:\n${V103_CONTACTS.paleta}${v103AfterActivity()}`; }
function v103Football(){ return `¡Vamos con Fútbol! Panchito se pone botines imaginarios ⚽🤖\n¿Qué categoría querés consultar?\n\nA. Cuarta, Quinta y Sexta División\nB. Séptima y Octava División\nC. Novena y Décima División\nD. Categorías 2017, 2018, 2019, 2020 y 2021\nE. Femenino Sub 12 y Sub 14\nF. Volver a actividades\nG. Volver al menú principal`; }
function v103FootballDetail(title, schedule){ return `${title} ⚽\n${schedule}\n\nPara consultar edades, precios, lugar de entrenamiento o inscripción:\n${V103_CONTACTS.futbol}\n\n¿Qué querés hacer ahora?\nA. Consultar otra categoría de Fútbol\nB. Consultar otra actividad\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103FootballYears(){ return `Horarios de Fútbol por categoría ⚽\n\n1. Categoría 2017\nLunes, miércoles y viernes de 18 a 19.30 hs.\n\n2. Categoría 2018\nMartes, jueves y viernes de 18 a 19.30 hs.\n\n3. Categoría 2019\nLunes, miércoles y viernes de 18 a 19.30 hs.\n\n4. Categorías 2020 y 2021\nMartes, jueves y viernes de 18 a 19.30 hs.\n\nPara consultar precios, lugar de entrenamiento o inscripción:\n${V103_CONTACTS.futbol}\n\n¿Qué querés hacer ahora?\nA. Consultar otra categoría de Fútbol\nB. Consultar otra actividad\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103Natacion(){ return `Para consultar por Natación, comunicate directamente con el coordinador del área 🏊\n\n${V103_CONTACTS.natacion}\n\nNatación cuenta con diferentes niveles, edades, horarios y opciones de clases. Además, los cupos pueden variar, por eso el coordinador te va a indicar cuál es la alternativa más adecuada y si hay disponibilidad.\n\nPara que pueda orientarte mejor, podés enviarle:\n• Edad de la persona interesada.\n• Si sabe nadar o está comenzando.\n• Días u horarios disponibles.\n\n¿Qué querés hacer ahora?\nA. Consultar otra actividad\nB. Consultar el Plan de Natación\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103PlanNatacion(){ return `El Plan de Natación está destinado a personas con discapacidad que quieran iniciarse en el aprendizaje y en la práctica deportiva 🏊\n\nLa información y la inscripción se consultan presencialmente en:\nDirección de Deportes Provincial\nQuintana y Pellegrini, Santa Rosa\n\nHorario de atención:\nLunes a viernes de 9 a 12 hs.\n\nEl Plan tiene cupos limitados. Si no hay una vacante disponible, la persona puede quedar anotada para ser contactada cuando haya disponibilidad.\n\n¿Qué querés hacer ahora?\nA. Volver a Natación\nB. Consultar otra actividad\nC. Volver al menú principal\nD. Hablar con Administración`; }
function v103Prices(){ return `Te ayudo con precios e inscripción 📝\n¿Qué necesitás?\n\nA. Consultar el precio de una actividad\nB. Inscribirme en una actividad\nC. Asociarme al club\nD. Inscripción para un menor\nE. Volver al menú principal`; }
function v103ChoosePrice(mode='price'){ return `${mode==='signup'?'¿En qué actividad querés inscribirte?':'¿Sobre qué actividad querés consultar?'}\n\nA. Gimnasia artística\nB. Sóftbol\nC. Pelota a paleta\nD. Natación\nE. Otra actividad\nF. Volver`; }
function v103PriceContact(letter){
  const map={A:['Gimnasia artística',V103_CONTACTS.gimnasia],B:['Sóftbol',V103_CONTACTS.softbol],C:['Pelota a paleta',V103_CONTACTS.paleta],D:['Natación',V103_CONTACTS.natacion],E:['Básquet, Fútbol u otra actividad',V103_CONTACTS.secretaria]};
  const x=map[letter]; if(!x) return '';
  return `Para consultar ${letter==='D'?'precios, horarios, niveles y cupos de':'el precio actualizado de'} ${x[0]}:\n${x[1]}\n\n¿Qué querés hacer ahora?\nA. Consultar otra actividad\nB. Volver al menú principal`;
}
function v103SignupContact(letter){
 const map={A:['Gimnasia artística',V103_CONTACTS.gimnasia],B:['Sóftbol',V103_CONTACTS.softbol],C:['Pelota a paleta',V103_CONTACTS.paleta],D:['Natación',V103_CONTACTS.natacion],E:['Para Básquet, Fútbol u otra actividad',V103_CONTACTS.secretaria]};
 const x=map[letter]; if(!x) return '';
 return `${x[0]}:\n${x[1]}\n\n¿Qué querés hacer ahora?\nA. Consultar otra actividad\nB. Volver al menú principal`;
}
function v103Minor(){ return `Si la inscripción es para un menor, por favor que continúe un adulto responsable 😊\n\n¿Qué actividad querés consultar?\nA. Gimnasia artística\nB. Sóftbol o Pelota a paleta\nC. Básquet o Fútbol\nD. Natación\nE. Plan de Natación\nF. Volver`; }
function v103Payments(){ return `Para consultas sobre cuotas, deuda, pagos, comprobantes o medios de pago, comunicate directamente con Administración 💳\n\n${V103_CONTACTS.secretaria}\n\nPara que puedan ayudarte más rápido, enviá en un solo mensaje:\n• Nombre y apellido.\n• DNI o número de socio.\n• Motivo de la consulta.\n• Comprobante, si ya realizaste un pago.\n\nPor seguridad, Panchito no informa deudas ni datos personales directamente por el momento. En una nueva actualización podré hacerlo.\n\n¿Qué querés hacer ahora?\nA. Volver al menú principal\nB. Hablar con Administración`; }
function v103Institutional(){ return `Gracias por escribirle al club 📩\n¿Qué querés enviar?\n\nA. Consulta de prensa o medios\nB. Dejar un CV\nC. Proponer un proyecto\nD. Ofrecer productos o servicios\nE. Sponsoreo, publicidad o auspicio\nF. Volver al menú principal`; }
function v103InstitutionalDetail(kind){
 const d={
  A:['Prensa o medios','• Nombre y medio.\n• Motivo de la consulta.\n• Fecha o evento relacionado.\n• Teléfono y correo electrónico.'],
  B:['Dejar CV','• Nombre y apellido.\n• Área o actividad de interés.\n• Experiencia.\n• Teléfono y correo electrónico.\n• CV adjunto.'],
  C:['Proponer un proyecto','• Nombre y apellido.\n• Tipo de proyecto.\n• Resumen breve.\n• Público al que está dirigido.\n• Teléfono y correo electrónico.'],
  D:['Proveedores','• Nombre o empresa.\n• Rubro.\n• Producto o servicio ofrecido.\n• Teléfono y correo electrónico.'],
  E:['Sponsoreo, publicidad o auspicio','• Nombre o empresa.\n• Tipo de propuesta.\n• Teléfono y correo electrónico.\n• Breve detalle de la propuesta.']
 }[kind]; if(!d) return '';
 return `${d[0]} 📩\n\nEnviá:\n${d[1]}\n\nContacto:\n${V103_CONTACTS.secretaria}${kind==='A'?'':`\nE-mail: ${V103_CONTACTS.email}`}\n\n¿Qué querés hacer ahora?\nA. Volver al menú institucional\nB. Volver al menú principal`;
}
function v103Predio(){ return `Para consultas del Predio:\n\nAll Boys Predio\nRuta 35, pegado al Aeropuerto\nWhatsApp: 2954 37-0053\n\n¿Qué querés hacer ahora?\nA. Volver al menú principal\nB. Hablar con Secretaría del Club`; }
function v103Error(){ return `Perdón, no terminé de entender la consulta. Mis circuitos hicieron “piiip” 🤖\n\nPodés elegir una opción:\n${v103MainMenu('volver').split('\n\n').slice(1).join('\n\n')}`; }

function v103SetMenu(s, menu){ setMenuContext(s, menu); s.data.v103Flow=true; }
function v103Admin(data,s,phone,rawText,note){ return goAdmin(data,s,phone,rawText,note); }

function v103HandleOfficialFlow(data,s,phone,rawText,text,letter,menu){
  const isL=(...xs)=>xs.includes(letter);
  const mainLike = !menu || menu==='main';
  if(mainLike && isLetter(rawText,['A','B','C','D','E','F','G','H'])){
    if(isL('A')){v103SetMenu(s,'v103_activities'); return v103Activities();}
    if(isL('B')){v103SetMenu(s,'v103_prices'); return v103Prices();}
    if(isL('C')){v103SetMenu(s,'v103_payments'); return v103Payments();}
    if(isL('D')) return v103Admin(data,s,phone,rawText,'Administración desde menú oficial');
    if(isL('E')){ setSession(s,'idle',{claimDraft:{}}); setMenuContext(s,'claim_name'); s.data.claimDraft={}; return responseClaimMenu(); }
    if(isL('F')){v103SetMenu(s,'v103_institutional'); return v103Institutional();}
    if(isL('G')){v103SetMenu(s,'v103_predio'); return v103Predio();}
    if(isL('H')){v103SetMenu(s,'v103_other'); return `No hay problema 😊\nContame brevemente qué necesitás y trato de orientarte.\n\nTambién podés elegir:\nA. Volver al menú principal\nB. Hablar con Administración`;}
  }
  if(menu==='v103_activities'){
    const a = isL('A')||text.includes('gimnasia'); const b=isL('B')||text.includes('basquet'); const c=isL('C')||text.includes('softbol'); const d=isL('D')||text.includes('paleta'); const e=isL('E')||text.includes('futbol'); const f=isL('F')||text.includes('natacion');
    if(a){v103SetMenu(s,'v103_after_activity'); return v103Gym();} if(b){v103SetMenu(s,'v103_basket'); return v103Basket();} if(c){v103SetMenu(s,'v103_after_activity'); return v103Softbol();} if(d){v103SetMenu(s,'v103_after_activity'); return v103Paleta();} if(e){v103SetMenu(s,'v103_football'); return v103Football();} if(f){v103SetMenu(s,'v103_natacion'); return v103Natacion();} if(isL('G')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_after_activity'){
    if(isL('A')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('B')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('C'))return v103Admin(data,s,phone,rawText,'Administración desde actividad');
  }
  if(menu==='v103_basket'){
    if(isL('A')){v103SetMenu(s,'v103_after_basket');return v103BasketFem();} if(isL('B')){v103SetMenu(s,'v103_after_basket');return v103BasketMasc();} if(isL('C')){v103SetMenu(s,'v103_after_basket');return v103BasketInitial();} if(isL('D')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('E')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_after_basket'){
    if(isL('A')){v103SetMenu(s,'v103_basket');return v103Basket();} if(isL('B')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('C')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('D'))return v103Admin(data,s,phone,rawText,'Administración desde Básquet');
  }
  if(menu==='v103_football'){
    if(isL('A')){v103SetMenu(s,'v103_after_football');return v103FootballDetail('Cuarta, Quinta y Sexta División','Lunes a viernes a las 16 hs.');} if(isL('B')){v103SetMenu(s,'v103_after_football');return v103FootballDetail('Séptima y Octava División','Lunes, miércoles, jueves y viernes a las 18 hs.');} if(isL('C')){v103SetMenu(s,'v103_after_football');return v103FootballDetail('Novena y Décima División','Lunes a jueves a las 18 hs.');} if(isL('D')){v103SetMenu(s,'v103_after_football');return v103FootballYears();} if(isL('E')){v103SetMenu(s,'v103_after_football');return v103FootballDetail('Fútbol femenino Sub 12 y Sub 14','Lunes, miércoles y viernes de 18 a 19.30 hs.');} if(isL('F')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('G')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_after_football'){
    if(isL('A')){v103SetMenu(s,'v103_football');return v103Football();} if(isL('B')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('C')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('D'))return v103Admin(data,s,phone,rawText,'Administración desde Fútbol');
  }
  if(menu==='v103_natacion'){
    if(isL('A')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('B')){v103SetMenu(s,'v103_plan_natacion');return v103PlanNatacion();} if(isL('C')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('D'))return v103Admin(data,s,phone,rawText,'Administración desde Natación');
  }
  if(menu==='v103_plan_natacion'){
    if(isL('A')){v103SetMenu(s,'v103_natacion');return v103Natacion();} if(isL('B')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('C')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('D'))return v103Admin(data,s,phone,rawText,'Administración desde Plan de Natación');
  }
  if(menu==='v103_prices'){
    if(isL('A')){v103SetMenu(s,'v103_price_choose');return v103ChoosePrice('price');} if(isL('B')){v103SetMenu(s,'v103_signup_choose');return v103ChoosePrice('signup');} if(isL('C')){v103SetMenu(s,'v103_simple_back');return `¡Qué bueno que quieras sumarte al club! 🔵🟡\n\nPara conocer requisitos, valores y documentación necesaria, comunicate con:\n${V103_CONTACTS.secretaria}\n\n¿Qué querés hacer ahora?\nA. Consultar actividades\nB. Volver al menú principal`;} if(isL('D')){v103SetMenu(s,'v103_minor');return v103Minor();} if(isL('E')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_price_choose'){
    if(['A','B','C','D','E'].includes(letter)){v103SetMenu(s,'v103_price_after');return v103PriceContact(letter);} if(isL('F')){v103SetMenu(s,'v103_prices');return v103Prices();}
  }
  if(menu==='v103_signup_choose'){
    if(['A','B','C','D','E'].includes(letter)){v103SetMenu(s,'v103_price_after');return v103SignupContact(letter);} if(isL('F')){v103SetMenu(s,'v103_prices');return v103Prices();}
  }
  if(menu==='v103_price_after'){
    if(isL('A')){v103SetMenu(s,'v103_price_choose');return v103ChoosePrice('price');} if(isL('B')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_simple_back'){
    if(isL('A')){v103SetMenu(s,'v103_activities');return v103Activities();} if(isL('B')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_minor'){
    if(isL('A')){v103SetMenu(s,'v103_simple_back');return `${V103_CONTACTS.gimnasia}\n\nA. Consultar actividades\nB. Volver al menú principal`;} if(isL('B')){v103SetMenu(s,'v103_simple_back');return `Sóftbol:\n${V103_CONTACTS.softbol}\n\nPelota a paleta:\n${V103_CONTACTS.paleta}\n\nA. Consultar actividades\nB. Volver al menú principal`;} if(isL('C')){v103SetMenu(s,'v103_simple_back');return `${V103_CONTACTS.secretaria}\n\nA. Consultar actividades\nB. Volver al menú principal`;} if(isL('D')){v103SetMenu(s,'v103_simple_back');return `${V103_CONTACTS.natacion}\n\nA. Consultar actividades\nB. Volver al menú principal`;} if(isL('E')){v103SetMenu(s,'v103_simple_back');return `Dirección de Deportes Provincial\nQuintana y Pellegrini, Santa Rosa\nLunes a viernes de 9 a 12 hs.\nConsulta presencial.\nEl Plan tiene cupos limitados.\n\nA. Consultar actividades\nB. Volver al menú principal`;} if(isL('F')){v103SetMenu(s,'v103_prices');return v103Prices();}
  }
  if(menu==='v103_payments'){
    if(isL('A')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('B'))return v103Admin(data,s,phone,rawText,'Cuotas y pagos');
  }
  if(menu==='v103_institutional'){
    if(['A','B','C','D','E'].includes(letter)){v103SetMenu(s,'v103_institutional_after');return v103InstitutionalDetail(letter);} if(isL('F')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_institutional_after'){
    if(isL('A')){v103SetMenu(s,'v103_institutional');return v103Institutional();} if(isL('B')){clearMenuContext(s);return v103MainMenu('volver');}
  }
  if(menu==='v103_predio'){
    if(isL('A')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('B'))return v103Admin(data,s,phone,rawText,'Consulta del Predio');
  }
  if(menu==='v103_other'){
    if(isL('A')){clearMenuContext(s);return v103MainMenu('volver');} if(isL('B'))return v103Admin(data,s,phone,rawText,'Otra consulta');
    if(rawText && !isLetter(rawText,['A','B'])) return v103Admin(data,s,phone,rawText,`Otra consulta: ${rawText}`);
  }
  return '';
}
// ================= FIN V103 =================

async function smartReply(rawText, phone='demo'){
  const data = db();
  data.sessions = data.sessions || [];
  data.conversations = data.conversations || [];
  data.pendingQueries = data.pendingQueries || [];
  const s = getSession(data, phone);
  const rawClean = clean(rawText);
  const text = normalizeUserText(rawText);
  const digits = ((String(rawText).match(/\d{4,12}/g)||[]).slice(-1)[0] || '');

  let intent='general', reply='', confidence=0.75;

  // Manejo de submenús: las letras A/B/C cambian según el contexto actual.
  let menu = getMenuContext(s);
  const letter = clean(rawText).toUpperCase();

  // FIX V75: si por algún reset quedó menu vacío/main pero el último menú mostrado
  // era un submenú, una letra sola debe responder a ese submenú.
  // Evita que E = "Volver a básquet" salte a "Administración".
  const lastMenuForLetters = (s.data && s.data.lastMenu) || '';
  if(isLetter(rawText, ['A','B','C','D','E','F','G','H']) && (!menu || menu === 'main') && lastMenuForLetters && lastMenuForLetters !== 'main') {
    menu = lastMenuForLetters;
    s.data.menu = menu;
    s.state = `waiting_${menu}`;
  }

  // Menús que son formularios paso a paso: acá no debe entrar la memoria de actividad.
  // Esto corrige el error interno "Cannot access protectedMenus before initialization"
  // y evita que una palabra como "horarios" rompa el bot cuando venía de Natatorio.
  const protectedMenus = [
    'signup_name','signup_age','signup_dni','signup_socio','signup_phone','signup_email','signup_notes','signup_confirm',
    'signup_edit_name','signup_edit_age','signup_edit_phone','signup_edit_dni','signup_edit_email','signup_edit_activity','signup_edit_notes','signup_duplicate','signup_done',
    'admin_dni','admin_dni_not_found','admin_name','admin_phone','admin_topic','admin_message',
    'claim_name','claim_phone','claim_area','claim_detail'
  ];

  // PRIORIDAD SOCIAL: saludos y respuestas cortas no deben abrir menús ni actividades.
  // Ejemplo: "buen día" no puede convertirse en "horarios" por el normalizador.
  if(isGreetingText(rawText)){
    intent='saludo'; confidence=.99;
    // Si ya habló con Panchito, no lo presentamos de nuevo: volvemos al menú con chiste.
    const alreadyMetPanchito = !!s.data?.seenPanchitoIntro || (data.conversations||[]).some(c => c.phone === phone);
    s.data = { ...(s.data||{}), menu:'main', topic:'', currentActivity:'', currentCategory:'', disciplineDetail:null, seenPanchitoIntro:true };
    setSession(s,'idle', s.data);
    reply = alreadyMetPanchito ? panchitoMenu('volver') : panchitoMenu('inicio');
    return finish();
  }

  if(isSoftSocialText(rawText)){
    intent='respuesta_social'; confidence=.96;
    reply = softSocialMessage(s);
    return finish();
  }

  const officialV103Reply = v103HandleOfficialFlow(data,s,phone,rawText,text,letter,menu);
  if(officialV103Reply){ intent='flujo_oficial_v103'; confidence=.99; reply=officialV103Reply; return finish(); }

  // V79: opciones cuando una edad no tiene categoría dentro de una actividad elegida.
  if(menu === 'activity_age_invalid'){
    intent='edad_sin_categoria_actividad_contextual'; confidence=.98;
    const invalidActivity = s.data?.ageInvalidActivity || s.data?.currentActivity || 'la actividad';
    const backMenu = s.data?.ageInvalidBackMenu || getMenuContext(s) || 'activities';
    if(isLetter(rawText,['A']) || containsAny(text,['cambiar edad','otra edad','corregir edad','edad'])){
      setMenuContext(s, backMenu && backMenu !== 'activity_age_invalid' ? backMenu : 'activities');
      reply = `Dale, corregimos la edad para **${invalidActivity}**.

Escribime la edad o el año de nacimiento.`;
      return finish();
    }
    if(isLetter(rawText,['B']) || containsAny(text,['categorias','categorías','ver categorias','ver categorías'])){
      const back = backMenu && backMenu !== 'activity_age_invalid' ? backMenu : 'activities';
      setMenuContext(s, back);
      reply = backMenuReply(back);
      return finish();
    }
    if(isLetter(rawText,['C']) || containsAny(text,['otras actividades','otro deporte','otra actividad','actividades'])){
      setMenuContext(s,'activities');
      reply = responseActivityMenu();
      return finish();
    }
    if(isLetter(rawText,['D']) || containsAny(text,['administracion','administración','admin','hablar'])){
      reply = goAdmin(data, s, phone, rawText, `Edad sin categoría para ${invalidActivity}`);
      return finish();
    }
    if(isLetter(rawText,['E']) || containsAny(text,['menu','menú','inicio','principal'])){
      clearMenuContext(s);
      reply = panchitoMenu();
      return finish();
    }
    reply = activityAgeInvalidOptions(invalidActivity);
    return finish();
  }

  function isMainMenuLetter(){
    return isLetter(rawText, ['A','B','C','D','E','F','G','H']);
  }

  // V77 - Sinónimos fuertes de administración.
  // Evita que frases como "secretaría", "hablar con alguien" o "humano"
  // se mezclen con opciones de deportes si no son una letra de menú.
  if(!isLetter(rawText, ['A','B','C','D','E','F','G','H']) && !protectedMenus.includes(menu) &&
     containsAny(text,['administracion','administración','secretaria','secretaría','hablar con alguien','hablar con una persona','persona','humano','atencion','atención','telefono del club','whatsapp del club'])){
    intent='administracion_sinonimo_v77'; confidence=.98;
    reply = goAdmin(data, s, phone, rawText, 'Usuario pidió hablar con administración por texto libre');
    return finish();
  }

  const contextualFollow = contextFollowUpReply(data, s, rawText);
  if(contextualFollow){
    intent='seguimiento_contextual_v67'; confidence=.94;
    reply = contextualFollow;
    return finish();
  }

  function routeMainMenuLetter(){
    const main = clean(rawText).toUpperCase();
    if(main==='A'){ setSession(s,'idle',{}); setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(main==='B'){ setSession(s,'idle',{}); setMenuContext(s,'prices'); reply=responsePricesMenu(); return finish(); }
    if(main==='C'){ setSession(s,'idle',{}); setMenuContext(s,'payments'); reply=responsePaymentsMenu(); return finish(); }
    if(main==='D'){
      setSession(s,'idle',{});
      reply = goAdmin(data, s, phone, rawText, 'Usuario pidió hablar con Administración desde el menú principal');
      return finish();
    }
    if(main==='E'){ setSession(s,'idle',{claimDraft:{}}); setMenuContext(s,'claim_name'); s.data.claimDraft={}; reply=responseClaimMenu(); return finish(); }
    if(main==='F'){ setSession(s,'idle',{}); setMenuContext(s,'institutional'); reply=responseInstitutionalMenu(); return finish(); }
    if(main==='G'){ setSession(s,'idle',{}); setMenuContext(s,'predio'); reply=responsePredio(); return finish(); }
    if(main==='H'){ setSession(s,'idle',{}); setMenuContext(s,'other'); reply=`No hay problema 😊

Contame brevemente qué necesitás y trato de orientarte.

A. Volver al menú principal
B. Hablar con Administración`; return finish(); }
  }

  // Si el último mensaje mostrado fue el menú principal, las letras A-H
  // SIEMPRE pertenecen al menú principal, no al submenú anterior.
  if(menu === 'main' && isMainMenuLetter()){
    return routeMainMenuLetter();
  }

  // V62 FIX CONTEXTO FUERTE DE MENÚS
  // Si hay un menú activo y el usuario responde con una letra, esa letra se interpreta
  // SIEMPRE según el último menú mostrado. Esto evita que, por ejemplo, E en
  // Actividades se tome como Administración del menú principal.
  function routeActiveMenuLetter(){
    if(!isLetter(rawText, ['A','B','C','D','E','F','G','H'])) return false;
    if(protectedMenus.includes(menu) || String(menu||'').startsWith('signup_') || String(menu||'').startsWith('admin_') || String(menu||'').startsWith('claim_')) return false;

    if(menu === 'activities'){
      intent='submenu_actividades_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística'; reply=responseGymnastics(); return true; }
      if(letter==='B'){ setMenuContext(s,'basket_all'); s.data.currentActivity='Básquet'; reply=responseBasketAll(); return true; }
      if(letter==='C'){ setMenuContext(s,'softbol'); s.data.currentActivity='Sóftbol'; reply=responseSoftbol(); return true; }
      if(letter==='D'){ setMenuContext(s,'paleta'); s.data.currentActivity='Pelota a Paleta'; reply=responsePaleta(); return true; }
      if(letter==='E'){ setMenuContext(s,'football_all'); s.data.currentActivity='Fútbol'; reply=responseFootballAll(); return true; }
      if(letter==='F'){ setMenuContext(s,'natatorio'); s.data.currentActivity='Natación'; reply=responseNatatorioMenu(false); return true; }
      if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu('volver'); return true; }
    }


    if(menu === 'basket_all' || menu === 'football_all'){
      if(letter==='A'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='B'){ clearMenuContext(s); reply=panchitoMenu('volver'); return true; }
      if(letter==='C'){ reply=goAdmin(data,s,phone,rawText, menu === 'basket_all' ? 'Consulta desde Básquet' : 'Consulta desde Fútbol'); return true; }
    }

    if(menu === 'football_legacy'){
      if(letter==='A'){ setMenuContext(s,'football_detail'); reply=footballWordDetail('Cuarta, Quinta y Sexta División','Lunes a viernes a las 16 hs.'); return true; }
      if(letter==='B'){ setMenuContext(s,'football_detail'); reply=footballWordDetail('Séptima y Octava División','Lunes, miércoles, jueves y viernes a las 18 hs.'); return true; }
      if(letter==='C'){ setMenuContext(s,'football_detail'); reply=footballWordDetail('Novena y Décima División','Lunes a jueves a las 18 hs.'); return true; }
      if(letter==='D'){ setMenuContext(s,'football_detail'); reply=responseFootballYearsWord(); return true; }
      if(letter==='E'){ setMenuContext(s,'football_detail'); reply=footballWordDetail('Fútbol femenino Sub 12 y Sub 14','Lunes, miércoles y viernes de 18 a 19.30 hs.'); return true; }
      if(letter==='F'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu('volver'); return true; }
    }

    if(menu === 'football_detail'){
      if(letter==='A'){ setMenuContext(s,'football_legacy'); reply=responseFootballMenu('back'); return true; }
      if(letter==='B'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='C'){ clearMenuContext(s); reply=panchitoMenu('volver'); return true; }
      if(letter==='D'){ reply=goAdmin(data,s,phone,rawText,'Consulta desde Fútbol'); return true; }
    }

    if(menu === 'football_years'){
      intent='submenu_futbol_anios_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2017','Fútbol',['2017'],'football_years'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='B'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2018','Fútbol',['2018'],'football_years'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='C'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2019','Fútbol',['2019'],'football_years'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='D'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2020','Fútbol',['2020'],'football_years'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='E'){ setMenuContext(s,'football'); reply=responseFootballMenu('back'); return true; }
      if(letter==='F'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
    }

    if(menu === 'basket_legacy'){
      if(letter==='A'){ setMenuContext(s,'basket_detail'); reply=responseBasketFemenino(); return true; }
      if(letter==='B'){ setMenuContext(s,'basket_detail'); reply=responseBasketMasculino(); return true; }
      if(letter==='C'){ setMenuContext(s,'basket_detail'); reply=responseBasketInicial(); return true; }
      if(letter==='D'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu('volver'); return true; }
    }

    if(menu === 'basket_detail'){
      if(letter==='A'){ setMenuContext(s,'basket_legacy'); reply=responseBasketMenu('back'); return true; }
      if(letter==='B'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='C'){ clearMenuContext(s); reply=panchitoMenu('volver'); return true; }
      if(letter==='D'){ reply=goAdmin(data,s,phone,rawText,'Consulta desde Básquet'); return true; }
    }

    if(menu === 'basket_fem'){
      intent='submenu_basquet_fem_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 17 y Primera','Básquet',['Femenino Sub 17','Femenino Primera'],'basket_fem'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='B'){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 13 y Sub 15','Básquet',['Femenino Sub 13','Femenino Sub 15'],'basket_fem'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='C'){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 11','Básquet',['Femenino Sub 11'],'basket_fem'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='D'){ setMenuContext(s,'basket'); reply=responseBasketMenu('back'); return true; }
      if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu(); return true; }
    }

    if(menu === 'basket_masc'){
      intent='submenu_basquet_masc_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 17','Básquet',['Masculino Sub 17'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='B'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 13','Básquet',['Masculino Sub 13'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='C'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 15','Básquet',['Masculino Sub 15'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='D'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Primera división','Básquet',['Masculino Primera división','Primera división'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='E'){ setDiscipline(s,'discipline_detail','🏀 Básquet Asociativo','Básquet',['Asociativo'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='F'){ setMenuContext(s,'basket'); reply=responseBasketMenu('back'); return true; }
      if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu(); return true; }
    }

    if(menu === 'basket_init'){
      intent='submenu_basquet_init_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setDiscipline(s,'discipline_detail','🏀 Básquet Sub 9','Básquet',['Sub 9'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='B'){ setDiscipline(s,'discipline_detail','🏀 Básquet Sub 11','Básquet',['Sub 11'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='C'){ setDiscipline(s,'discipline_detail','🏀 Básquet Escuelita','Básquet',['Escuelita'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='D'){ setDiscipline(s,'discipline_detail','🏀 Básquet Mosquitos','Básquet',['Mosquitos'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='E'){ setMenuContext(s,'basket'); reply=responseBasketMenu('back'); return true; }
      if(letter==='F'){ clearMenuContext(s); reply=panchitoMenu(); return true; }
    }

    // V82: En las fichas completas de actividades, A/B/C son siempre las opciones
    // que se muestran al final: otra actividad, menú principal y administración.
    // No deben reutilizarse como categorías antiguas de Básquet o Fútbol.
    if(menu === 'gymnastics' || menu === 'softbol' || menu === 'paleta'){
      intent='actividad_horarios_completos_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='B'){ clearMenuContext(s); reply=panchitoMenu(); return true; }
      if(letter==='C'){ reply=goAdmin(data,s,phone,rawText,`Consulta desde ${s.data.currentActivity || 'actividad'}`); return true; }
    }

    if(menu === 'softbol'){
      intent='submenu_softbol_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setDiscipline(s,'discipline_detail','🥎 Pre infantil mixto','Softbol',['Pre infantil'],'softbol'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='B'){ setDiscipline(s,'discipline_detail','🥎 Infantil cadete mixto','Softbol',['Infantil cadete'],'softbol'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='C'){ setDiscipline(s,'discipline_detail','🥎 Femenino','Softbol',['Femenino'],'softbol'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='D'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu(); return true; }
    }

    if(menu === 'paleta'){
      intent='submenu_paleta_contexto_fuerte'; confidence=.99;
      if(letter==='A'){ setDiscipline(s,'discipline_detail','🏓 Niños y niñas de 6 a 12 años','Pelota a Paleta',['Niños','niñas'],'paleta'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='B'){ setDiscipline(s,'discipline_detail','🏓 Adultos','Pelota a Paleta',['Adultos'],'paleta'); reply=disciplineAnswer(data,s,'all'); return true; }
      if(letter==='C'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return true; }
      if(letter==='D'){ clearMenuContext(s); reply=panchitoMenu(); return true; }
    }

    return false;
  }

  if(routeActiveMenuLetter()){
    return finish();
  }

  // V44 FIX: si el bot acaba de preguntar actividad para un menor,
  // las letras A-E pertenecen a ese menú, no al menú principal ni a un submenú viejo.
  if(menu === 'human_minor_activity'){
    const age = extractAge(rawText);
    if(age && !detectActivityFreeText(rawText) && !isLetter(rawText,['A','B','C','D','E'])){
      s.data.userAge = age;
      intent='menor_edad_recibida'; confidence=.94;
      reply = `😊 ¡Perfecto! ${age} años, ya puedo orientarte mejor.

¿Qué actividad le interesa?

A. 🏊 Natatorio / pileta
B. ⚽ Fútbol
C. 🏀 Básquet
D. 🤸 Gimnasia artística
E. 📞 Hablar con administración`;
      return finish();
    }
    if(isLetter(rawText,['A']) || containsAny(text,['natatorio','pileta','natacion','natación'])){
      intent='menor_natatorio'; confidence=.98;
      setTopic(s,'natatorio',{}); setMenuContext(s,'natatorio'); s.data.currentActivity='Natatorio / pileta';
      reply=(s.data.userAge? `🏊 ¡Al agua! Para ${s.data.userAge} años conviene confirmar grupo, nivel y cupo disponible.

`:'')+responseNatatorioMenu(true);
      return finish();
    }
    if(isLetter(rawText,['B']) || containsAny(text,['futbol','fútbol'])){
      intent='menor_futbol'; confidence=.98;
      const ageInfo = s.data.userAge ? {age:s.data.userAge, birthYear:new Date().getFullYear()-s.data.userAge, source:'age'} : null;
      const rec = ageInfo ? phase6RecommendRule(data, 'Fútbol', ageInfo, 'masculino') : null;
      setTopic(s,'actividades',{}); setMenuContext(s,'football'); s.data.currentActivity='Fútbol';
      if(rec){ setDiscipline(s,'discipline_detail', `Fútbol - ${rec.label}`, 'Fútbol', [rec.rawCategory, rec.label].filter(Boolean), 'football'); }
      reply = `⚽ ¡Qué lindo! En All Boys la pelota arranca desde chicos.

${s.data.userAge ? `Con ${s.data.userAge} años, lo más probable es **${rec?.label || fallbackRecommendedCategory('Fútbol', ageInfo) || 'categoría infantil'}**.

` : ''}¿Qué necesitás ahora?
A. 🕒 Horarios
B. 💰 Cuotas / precio
C. 📝 Inscripción
D. 📲 Administración`;
      return finish();
    }
    if(isLetter(rawText,['C']) || containsAny(text,['basquet','básquet','basket'])){
      intent='menor_basquet'; confidence=.98;
      setTopic(s,'actividades',{}); setMenuContext(s,'basket'); s.data.currentActivity='Básquet';
      reply = `🏀 ¡Buenísima elección! Vamos a encestar esta consulta.

${s.data.userAge ? `Me dijiste que tiene ${s.data.userAge} años. ` : ''}Para ubicar la categoría, decime si es para chica o chico.

A. 👧 Básquet femenino
B. 👦 Básquet masculino
C. 🐣 Escuelita / inicial
D. 🔙 Ver otras actividades`;
      return finish();
    }
    if(isLetter(rawText,['D']) || containsAny(text,['gimnasia'])){
      intent='menor_gimnasia'; confidence=.98;
      const ageInfo = s.data.userAge ? {age:s.data.userAge, birthYear:new Date().getFullYear()-s.data.userAge, source:'age'} : null;
      const rec = ageInfo ? phase6RecommendRule(data, 'Gimnasia Artística', ageInfo, '') : null;
      setTopic(s,'actividades',{}); setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística';
      if(rec){ setDiscipline(s,'discipline_detail', `Gimnasia Artística - ${rec.label}`, 'Gimnasia Artística', [rec.rawCategory, rec.label].filter(Boolean), 'gymnastics'); }
      reply = `🤸 ¡Hermosa disciplina! Vamos paso a paso, sin perder el equilibrio 😄

${s.data.userAge ? `Con ${s.data.userAge} años, probablemente corresponda **${rec?.label || fallbackRecommendedCategory('Gimnasia Artística', ageInfo) || 'un grupo por edad'}**.

` : ''}¿Qué necesitás?
A. 🕒 Horarios
B. 💰 Cuotas / precio
C. 📝 Inscripción
D. 👩‍🏫 Profesor/a
E. 📲 Administración`;
      return finish();
    }
    if(isLetter(rawText,['E']) || containsAny(text,['admin','administracion','persona'])){
      intent='menor_admin'; confidence=.98;
      reply=goAdmin(data,s,phone,rawText,'Consulta de menor derivada a administración');
      return finish();
    }
  }

  // Opciones después de cerrar una conversación.
  // En estos mensajes A significa "Menú principal", NO actividades.
  // Esto evita que después de "gracias / de nada" la A quede tomada como Deportes.
  if(s.state === 'after_close_options'){
    // Si el usuario vuelve a decir gracias después de registrar la encuesta,
    // NO volvemos a disparar la misma encuesta. Cerramos amable y dejamos el menú.
    if(isThanksText(rawText) || isByeText(rawText)){
      intent='cierre_ya_registrado'; confidence=.99;
      setSession(s,'idle',{}); setTopic(s,'',{}); clearMenuContext(s);
      reply = `${finalCloseMessage()}

${panchitoMenu()}`;
      return finish();
    }
    if(isLetter(rawText,['A']) || containsAny(text,['menu','menú','inicio','principal'])){
      intent='menu_principal_post_cierre'; confidence=.99;
      setSession(s,'idle',{}); setTopic(s,'',{}); clearMenuContext(s);
      reply = panchitoMenu();
      return finish();
    }
    if(isLetter(rawText,['B']) || containsAny(text,['nueva consulta','otra consulta','consultar'])){
      intent='nueva_consulta_post_cierre'; confidence=.97;
      setSession(s,'idle',{}); setTopic(s,'',{}); clearMenuContext(s);
      reply = `Perfecto 😊

Contame qué necesitás o elegí una opción del menú.

` + panchitoMenu();
      return finish();
    }
    // Si escribe otra cosa, no lo dejamos enganchado en actividades viejas.
    setSession(s,'idle',{}); clearMenuContext(s);
  }

  // Cierre global: si el usuario agradece o se despide, se limpia cualquier flujo activo
  // antes de procesar submenús, categorías, cuotas, administración o reclamos.
  if(s.state !== 'waiting_satisfaction' && s.state !== 'waiting_survey_comment' && (isThanksText(rawText) || isByeText(rawText))){
    intent='cierre_amigable'; confidence=.98;
    const surveyTopic = currentTopic(s) || s.data?.currentActivity || s.data?.menu || 'consulta';
    s.data.adminDraft = {};
    s.data.claimDraft = {};
    s.data.priceFlow = false;
    s.data.priceMode = '';
    clearMenuContext(s);
    setSession(s,'waiting_satisfaction',{surveyTopic});
    reply = thanksCloseMessage();
    return finish();
  }

  // Encuesta de experiencia al cerrar la conversación: formato simple A/B/C compatible con WhatsApp.
  if(s.state === 'waiting_satisfaction'){
    const cleanAnswer = clean(rawText || '');
    let score = 0;
    let label = '';

    if(isLetter(rawText,['A']) || cleanAnswer === 'a' || cleanAnswer.includes('si me sirvio') || cleanAnswer === 'si'){
      score = 5;
      label = 'Sí, me sirvió';
    } else if(isLetter(rawText,['B']) || cleanAnswer === 'b' || cleanAnswer.includes('mas o menos')){
      score = 3;
      label = 'Más o menos';
    } else if(isLetter(rawText,['C']) || cleanAnswer === 'c' || cleanAnswer.includes('no me sirvio') || cleanAnswer === 'no'){
      score = 1;
      label = 'No me sirvió';
    }

    if(score){
      intent='encuesta_satisfaccion'; confidence=.98;
      const survey = saveSurvey(data, phone, score, s.data?.surveyTopic || 'consulta', label);

      if(score === 5){
        setSession(s,'after_close_options',{}); clearMenuContext(s);
        reply = `¡Genial! Gracias por ayudarnos a mejorar 💙💛\n\nTu opinión quedó registrada.\n\nA. 🏠 Menú principal\nB. 💬 Nueva consulta`;
        return finish();
      }

      let claimNote = '';
      if(score <= 1){
        const p = addPending(data, phone, `Experiencia baja con Panchito: ${label}`, 'reclamo', 'Generado automáticamente desde encuesta de experiencia');
        p.name = 'Socio / visitante';
        p.contactPhone = phone;
        p.topic = 'Mala experiencia con Panchito';
        p.message = `El usuario respondió: ${label}. Conviene contactarlo para seguimiento.`;
        p.priority = '🔴 Reclamo';
        claimNote = '\n\nTambién generé un reclamo interno para seguimiento de Administración.';
      }

      setSession(s,'waiting_survey_comment',{surveyId:survey.id, surveyScore:score});
      reply = `Gracias por responder 😊${claimNote}\n\n¿Querés contarnos qué podemos mejorar?\n\nA. ✍️ Escribir comentario\nB. ⏭️ Omitir`;
      return finish();
    }

    if(containsAny(text,['menu','menú','inicio','salir','omitir','no gracias'])){
      intent='encuesta_omitida'; confidence=.9;
      setSession(s,'idle',{}); clearMenuContext(s);
      reply = 'Gracias igual 😊 Te dejo el menú por si necesitás algo más.\n\n' + panchitoMenu();
      return finish();
    }

    reply = 'Respondé con A, B o C.\n\nA. ✅ Sí, me sirvió\nB. 🟡 Más o menos\nC. ❌ No me sirvió\n\nTambién podés escribir OMITIR.';
    return finish();
  }

  if(s.state === 'waiting_survey_comment'){
    intent='comentario_encuesta_opcion'; confidence=.95;

    if(isLetter(rawText,['A'])){
      setSession(s,'waiting_survey_comment_input',{...(s.data||{})});
      reply = `Perfecto 😊

Escribí tu comentario y lo voy a guardar para ayudar a mejorar el servicio.`;
      return finish();
    }

    if(isLetter(rawText,['B']) || containsAny(text,['omitir','no','no gracias','gracias','menu','menú','inicio','salir']) || isThanksText(rawText) || isByeText(rawText)){
      setSession(s,'after_close_options',{}); clearMenuContext(s);
      reply = `Gracias por tu opinión 😊

Quedó registrada para que el club pueda mejorar la atención.

${finalCloseMessage()}

A. 🏠 Menú principal
B. 💬 Realizar otra consulta`;
      return finish();
    }

    // Si el usuario escribe directamente el comentario, también lo guardamos.
    const id = Number(s.data?.surveyId || 0);
    const survey = (data.surveys||[]).find(x=>Number(x.id)===id);
    if(survey) survey.comment = rawText;

    setSession(s,'after_close_options',{}); clearMenuContext(s);
    reply = `Gracias por tu comentario 😊

Quedó registrado para que el club pueda mejorar la atención.

${finalCloseMessage()}

A. 🏠 Menú principal
B. 💬 Realizar otra consulta`;
    return finish();
  }

  if(s.state === 'waiting_survey_comment_input'){
    intent='comentario_encuesta'; confidence=.95;

    const id = Number(s.data?.surveyId || 0);
    const survey = (data.surveys||[]).find(x=>Number(x.id)===id);
    if(survey) survey.comment = rawText;

    setSession(s,'after_close_options',{}); clearMenuContext(s);
    reply = `Gracias por tu comentario 😊

Quedó registrado para que el club pueda mejorar la atención.

${finalCloseMessage()}

A. 🏠 Menú principal
B. 💬 Realizar otra consulta`;
    return finish();
  }


  // V57: memoria conversacional antes de menús rígidos.
  // Guarda edad/sexo/deporte y responde usando contexto cuando el usuario escribe algo suelto.
  if(!protectedMenus.includes(menu) && !['waiting_satisfaction','waiting_survey_comment','waiting_survey_comment_input'].includes(s.state) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup' && !isMemberFeeDebtQuery(rawText)){
    const memorySmart = replyContextualMemory(data, s, rawText, phone);
    if(memorySmart){
      intent='memoria_conversacional_v57'; confidence=.99;
      reply = memorySmart;
      return finish();
    }
  }

  // FASE 6: conversación inteligente antes de caer en menús rígidos.
  // Detecta frases completas, recuerda contexto y responde solo lo que el usuario pidió.
  if(!protectedMenus.includes(menu) && !['waiting_satisfaction','waiting_survey_comment','waiting_survey_comment_input'].includes(s.state) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup' && !isMemberFeeDebtQuery(rawText)){
    const smart = phase6SmartConversation(data, s, rawText, phone);
    if(smart){
      intent='conversacion_inteligente'; confidence=.99;
      reply = smart;
      return finish();
    }
  }

  // V48: memoria fuerte por deporte + categoría.
  // Si ya eligió una categoría de cualquier deporte y después escribe
  // horarios / inscripción / precio / profesor / WhatsApp, responde dentro de esa misma categoría.
  // Esto evita que Fútbol, Básquet, Gimnasia, Sóftbol o Paleta vuelvan a pedir categoría.
  if(s.data?.disciplineDetail && ['discipline_detail','after_discipline_answer','price_discipline_detail'].includes(menu) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup'){
    const wanted = disciplineFollowUpKind(rawText);
    if(['schedule','teacher','price','inscription'].includes(wanted)){
      intent='memoria_categoria_'+wanted; confidence=.98;
      reply = disciplineAnswer(data, s, wanted);
      return finish();
    }
    if(wanted === 'admin'){
      intent='memoria_categoria_admin'; confidence=.98;
      reply = goAdmin(data, s, phone, rawText, `Usuario pidió administración desde ${s.data?.disciplineDetail?.title || 'disciplina'}`);
      return finish();
    }
    if(wanted === 'back'){
      intent='memoria_categoria_volver'; confidence=.96;
      const back = s.data?.disciplineDetail?.backMenu || 'activities';
      setMenuContext(s, back); reply = backMenuReply(back); return finish();
    }
    if(wanted === 'menu'){
      intent='memoria_categoria_menu'; confidence=.96;
      clearMenuContext(s); reply = panchitoMenu(); return finish();
    }
  }

  // Opciones dinámicas después de responder algo de Natatorio.
  // No repetimos la misma opción que el usuario acaba de pedir.
  if(menu === 'natatorio_after'){
    const last = s.data?.lastNatatorioAnswer || '';
    const selected = natatorioAfterOptionByLetter(last, letter);
    let wanted = selected;
    if(!wanted){
      if(containsAny(text,['horario','horarios','dias','cuando'])) wanted='horarios';
      else if(containsAny(text,['inscripcion','inscribir','anotar'])) wanted='inscripcion';
      else if(containsAny(text,['precio','costo','valor','cuanto','cuota'])) wanted='costos';
      else if(containsAny(text,['whatsapp','wasap','wsp','telefono','administracion','hablar'])) wanted='whatsapp';
      else if(containsAny(text,['menu','menú','inicio','principal'])) wanted='menu';
    }
    if(wanted){
      if(wanted === 'menu'){
        intent='menu_desde_natatorio'; confidence=.96;
        clearMenuContext(s); setTopic(s,'',{});
        reply = panchitoMenu();
        return finish();
      }
      intent='natatorio_after_'+wanted; confidence=.97;
      const query = wanted === 'costos' ? 'costos' : wanted;
      reply = directActivityReply(data, {key:'natatorio', label:'Natatorio / pileta'}, query, s);
      return finish();
    }
  }

  // Consulta de cuota/deuda del socio: tiene prioridad sobre la memoria de actividad.
  // Ej: si venía de Natatorio y escribe “quiero saber si debo cuota”, debe ir a Cuotas/Pagos,
  // no a costos de natatorio.
  if(!protectedMenus.includes(menu) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup' && isMemberFeeDebtQuery(rawText)){
    intent='cuota_deuda_socio'; confidence=.98;
    setSession(s,'waiting_dni_fee',{});
    setTopic(s,'cuota',{});
    reply = `Dale 😊 Para saber si debés cuota necesito consultar tu ficha de socio.

Pasame tu DNI o número de socio.`;
    return finish();
  }

  // V45: memoria fuerte de actividad.
  // Si el usuario ya está en Natatorio/Básquet/Fútbol/etc. y escribe "horarios",
  // "inscribirte", "precio", "cupos", etc., responde sobre esa actividad,
  // no lo manda a inscripciones generales ni repite "te interesa natación".
  if(!protectedMenus.includes(menu) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup'){
    const rememberedActivity = activityFromMemory(s);
    const userMentionedNewActivity = detectActivityFreeText(rawText);
    if(rememberedActivity && !userMentionedNewActivity && isContextFollowUp(rawText)){
      intent='actividad_memoria_fuerte'; confidence=.97;
      setTopic(s,'actividades',{});
      setMenuContext(s, rememberedActivity.key === 'natatorio' ? 'natatorio' : rememberedActivity.key);
      s.data.currentActivity = rememberedActivity.label;
      reply = directActivityReply(data, rememberedActivity, rawText, s);
      return finish();
    }
  }

  // IA humana tiene prioridad si el usuario cambia de tema y pregunta por un hijo/a.
  // Esto evita que una sesión vieja atrape la consulta en un submenú anterior.
  if(!protectedMenus.includes(menu) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup' && isMinorQuery(text) && !containsAny(text,['natatorio','pileta','natacion','natación','futbol','fútbol','basquet','básquet','gimnasia','softbol','paleta'])){
    intent='consulta_menor_contextual'; confidence=.91;
    setTopic(s,'menor',{}); setMenuContext(s,'human_minor_activity');
    reply = `${friendlyLead('minor')}\n\n¿Qué actividad estás buscando para tu hijo/a?\n\nA. Natatorio / pileta 🏊\nB. Fútbol ⚽\nC. Básquet 🏀\nD. Gimnasia artística 🤸\nE. Hablar con administración 📞`;
    return finish();
  }


  // V41: entendimiento más natural para consultas comunes sin depender de A/B/C.
  if(!protectedMenus.includes(menu) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup'){
    const age = extractAge(rawText);
    if(age){ s.data.userAge = age; }

    if(containsAny(text,['donde queda','dónde queda','direccion','dirección','ubicacion','ubicación','domicilio','como llego','cómo llego'])){
      intent='ubicacion_club'; confidence=.96;
      setTopic(s,'ubicacion',{}); clearMenuContext(s);
      reply = clubLocationReply(data);
      return finish();
    }

    if(containsAny(text,['que podes hacer','qué podés hacer','ayuda','no entiendo','como funciona','cómo funciona','opciones'])){
      intent='ayuda_natural'; confidence=.92;
      reply = naturalHelpMenu() + '\n\n' + panchitoMenu();
      return finish();
    }

    if(containsAny(text,['quiero inscribirme','me quiero inscribir','anotarme','anotar a mi hijo','anotar a mi hija','inscribir a mi hijo','inscribir a mi hija']) && !detectActivityFreeText(rawText)){
      intent='inscripcion_natural_sin_actividad'; confidence=.9;
      setTopic(s,'inscripcion',{}); setMenuContext(s,'prices');
      reply = `Dale, te ayudo con la inscripción 📝

Primero elegí la actividad para cargarla bien.

${responsePricesMenu()}`;
      return finish();
    }

    if((containsAny(text,['precio','cuanto sale','cuánto sale','valor','costo','cuota de','sale']) || containsAny(text,['inscripcion','inscripción','inscribir','anotar'])) && s.data?.currentActivity){
      const remembered = detectActivityFreeText(s.data.currentActivity) || {key:getMenuContext(s), label:s.data.currentActivity};
      intent='consulta_natural_con_memoria'; confidence=.94;
      reply = directActivityReply(data, remembered, rawText, s);
      return finish();
    }
  }

  // IA libre global: detecta actividades desde cualquier pantalla o submenú.
  // Ej: "quiere hacer gimnasia artística", "horarios de básquet", "natación para mi hijo".
  if(!protectedMenus.includes(menu) && s.state !== 'waiting_dni_fee' && s.state !== 'waiting_carnet_lookup'){
    const freeActivity = detectActivityFreeText(rawText);
    if(freeActivity){
      intent = `actividad_${freeActivity.key}_texto_libre`; confidence = .97;
      setSession(s,'idle',{});
      setTopic(s,'actividades',{});
      setMenuContext(s, freeActivity.key === 'natatorio' ? 'natatorio' : freeActivity.key);
      s.data.currentActivity = freeActivity.label;
      reply = directActivityReply(data, freeActivity, rawText, s);
      return finish();
    }
  }

  // Memoria: si ya venía hablando de una actividad y pregunta "horarios", "costos" o "inscripción".
  if(!protectedMenus.includes(menu) && s.data?.currentActivity && containsAny(text,['horario','horarios','dias','días','dia','día','inscripcion','inscripción','anotar','anotarme','precio','costo','cuanto','cuánto','valor','whatsapp','wasap','wsp'])){
    const remembered = detectActivityFreeText(s.data.currentActivity) || {key:getMenuContext(s), label:s.data.currentActivity};
    intent='actividad_memoria_contexto'; confidence=.93;
    setTopic(s,'actividades',{});
    reply = directActivityReply(data, remembered, rawText, s);
    return finish();
  }

  // Estado específico de consulta de socios/cuotas.
  // IMPORTANTE: se resuelve antes que los menús globales para que "si", "no" o un número
  // no caigan en otro menú por error.
  if(s.state === 'fee_checked') {
    const lastMember = (data.members||[]).find(m => String(m.id) === String(s.data?.lastMemberId));

    if(isAffirmative(text)) {
      if(lastMember && Number(lastMember.debt||0) > 0) {
        intent='medios_pago'; confidence=.94; setTopic(s,'pagos',{}); setMenuContext(s,'payments');
        reply = `Podés pagar por transferencia 💳

Alias:
${data.club.paymentAlias || 'allboyseslapampa'}

Después de pagar, enviá el comprobante al WhatsApp del club:
${data.club.whatsapp || '2954592313'}

Si querés consultar otro socio, elegí A en el menú de cuotas.`;
        return finish();
      }
      intent='consultar_otro_socio'; confidence=.96;
      clearMenuContext(s);
      setSession(s,'waiting_dni_fee',{});
      setTopic(s,'cuota',{});
      reply = 'Perfecto 😊\n\nPasame el DNI o número de socio que querés consultar.';
      return finish();
    }

    if(containsAny(text,['no','no gracias','nada mas','nada más','listo','gracias'])) {
      intent='fin_consulta_socio'; confidence=.92;
      setSession(s,'after_close_options',{});
      setTopic(s,'',{});
      clearMenuContext(s);
      reply = `${finalCloseMessage()}

A. 🏠 Menú principal
B. 💬 Nueva consulta`;
      return finish();
    }

    if(digits) {
      const m = findMember(data, digits);
      intent = m ? 'consulta_socio' : 'socio_no_encontrado';
      confidence = m ? .98 : .78;
      setSession(s, m ? 'fee_checked' : 'waiting_dni_fee', {lastDni:digits,lastMemberId:m?.id||null});
      setTopic(s,'cuota',{});
      if(m) reply = memberReply(m);
      else {
        addPending(data, phone, rawText, 'cuota', 'DNI/número no encontrado en demo');
        reply = notFoundMemberReply(digits);
      }
      return finish();
    }
    if(menu === 'human_minor_activity'){
    const age = extractAge(rawText);
    if(age && !detectActivityFreeText(rawText) && !isLetter(rawText,['A','B','C','D','E'])){
      s.data.userAge = age;
      intent='menor_edad_recibida'; confidence=.91;
      reply = `Perfecto, ${age} años 😊

Ahora decime qué actividad está buscando:

A. Natatorio / pileta 🏊
B. Fútbol ⚽
C. Básquet 🏀
D. Gimnasia artística 🤸
E. Hablar con administración 📞`;
      return finish();
    }
    if(isLetter(rawText,['A']) || containsAny(text,['natatorio','pileta','natacion','natación'])){ setTopic(s,'natatorio',{}); setMenuContext(s,'natatorio'); reply=(s.data.userAge? ageSmartHint(s.data.userAge,'natatorio')+'\n\n':'')+responseNatatorioMenu(true); return finish(); }
    if(isLetter(rawText,['B']) || containsAny(text,['futbol','fútbol'])){ setTopic(s,'actividades',{}); setMenuContext(s,'football'); s.data.currentActivity='Fútbol'; reply=(s.data.userAge? ageSmartHint(s.data.userAge,'futbol')+'\n\n':'')+responseFootballMenu(); return finish(); }
    if(isLetter(rawText,['C']) || containsAny(text,['basquet','básquet','basket'])){ setTopic(s,'actividades',{}); setMenuContext(s,'basket'); s.data.currentActivity='Básquet'; reply=(s.data.userAge? ageSmartHint(s.data.userAge,'basquet')+'\n\n':'')+responseBasketMenu(); return finish(); }
    if(isLetter(rawText,['D']) || containsAny(text,['gimnasia'])){ setTopic(s,'actividades',{}); setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística'; reply=(s.data.userAge? ageSmartHint(s.data.userAge,'gimnasia')+'\n\n':'')+responseGymnastics(); return finish(); }
    if(isLetter(rawText,['E']) || containsAny(text,['admin','administracion','persona'])){ reply=goAdmin(data,s,phone,rawText,'Consulta de menor derivada a administración'); return finish(); }
  }

  if((menu === 'main' || !menu) && isMainMenuLetter()) {
      return routeMainMenuLetter();
    }
  }

  if(s.state === 'waiting_dni_fee') {
    if(isMainMenuLetter()) {
      return routeMainMenuLetter();
    }
    if(digits) {
      const m = findMember(data, digits);
      intent = m ? 'consulta_socio' : 'socio_no_encontrado';
      confidence = m ? .98 : .78;
      setSession(s, m ? 'fee_checked' : 'waiting_dni_fee', {lastDni:digits,lastMemberId:m?.id||null});
      setTopic(s,'cuota',{});
      if(m) reply = memberReply(m);
      else {
        addPending(data, phone, rawText, 'cuota', 'DNI/número no encontrado en demo');
        reply = notFoundMemberReply(digits);
      }
      return finish();
    }

    if(containsAny(text,['menu','menú','inicio','salir','cancelar','volver'])) {
      intent='menu'; confidence=.9;
      setSession(s,'idle',{});
      setTopic(s,'',{});
      clearMenuContext(s);
      reply = panchitoMenu();
      return finish();
    }

    intent='esperando_dni_socio'; confidence=.8;
    reply = 'Para consultar la cuota necesito un DNI o número de socio. También podés escribir “menú” para volver al inicio.';
    return finish();
  }


  if(['signup_name','signup_age','signup_age_invalid','signup_dni','signup_socio','signup_phone','signup_email','signup_notes','signup_confirm','signup_edit_name','signup_edit_age','signup_edit_phone','signup_edit_dni','signup_edit_email','signup_edit_activity','signup_edit_notes','signup_duplicate','signup_done'].includes(menu)){
    if(containsAny(text,['menu','menú','inicio','salir','cancelar','volver'])){
      intent='inscripcion_cancelada'; confidence=.92;
      clearMenuContext(s);
      s.data.signupDraft = {};
      reply = panchitoMenu();
      return finish();
    }

    s.data.signupDraft = s.data.signupDraft || {};

    const naturalEdit = detectSignupEditIntent(rawText);
    if(naturalEdit && menu !== 'signup_duplicate' && menu !== 'signup_done'){
      intent='inscripcion_edicion_natural'; confidence=.97;
      const msg = applySignupEditIntent(data, s, naturalEdit);
      setMenuContext(s,'signup_confirm');
      reply = `${msg}

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    // IA / ayuda controlada dentro de la inscripción: si el usuario pregunta algo
    // como horarios, precio, cupos o requisitos, respondemos sin perder el paso actual.
    if(!String(menu||'').startsWith('signup_edit_') && menu !== 'signup_confirm' && menu !== 'signup_duplicate' && isSignupSideQuestion(rawText)){
      intent='inscripcion_consulta_intermedia'; confidence=.95;
      const answer = signupSideAnswer(data, s, rawText);
      reply = `${answer}

Seguimos con la inscripción donde estábamos 😊

${signupPromptForCurrentMenu(menu, s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_name'){
      intent='inscripcion_nombre'; confidence=.94;
      s.data.signupDraft.name = rawText;
      setMenuContext(s,'signup_age');
      reply = `Gracias ✅

${signupStepPrompt('age', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_age'){
      intent='inscripcion_edad'; confidence=.94;
      s.data.signupDraft.age = rawText;
      const blockedAge = signupAgeBlockedReply(data, s, rawText);
      if(blockedAge){
        validateAndApplySignupAge(data, s, rawText);
        setMenuContext(s,'signup_age_invalid');
        reply = blockedAge;
        return finish();
      }
      const advice = validateAndApplySignupAge(data, s, rawText);
      setMenuContext(s,'signup_dni');
      reply = `Perfecto ✅${advice}

${signupStepPrompt('dni', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_age_invalid'){
      intent='inscripcion_edad_sin_categoria'; confidence=.96;
      if(isLetter(rawText,['A']) || containsAny(text,['admin','administracion','administración','secretaria','secretaría','hablar'])){
        const draft = s.data.signupDraft || {};
        reply = goAdmin(data, s, phone, rawText, `Edad sin categoría para inscripción en ${draft.activity || 'actividad'}`);
        return finish();
      }
      if(isLetter(rawText,['B']) || containsAny(text,['otro deporte','otra actividad','deporte','actividad'])){
        s.data.signupDraft = {};
        setMenuContext(s,'activities');
        reply = `Dale, elegimos otra actividad y arrancamos bien desde ahí 😊

${responseActivityMenu()}`;
        return finish();
      }
      if(isLetter(rawText,['C']) || containsAny(text,['cambiar edad','edad','corregir'])){
        setMenuContext(s,'signup_age');
        reply = `Dale, corregimos la edad.

${signupStepPrompt('age', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
        return finish();
      }
      if(isLetter(rawText,['D']) || containsAny(text,['menu','menú','inicio'])){
        clearMenuContext(s);
        s.data.signupDraft = {};
        reply = panchitoMenu();
        return finish();
      }
      reply = `Elegí una opción para seguir:

A. 📞 Hablar con administración
B. 🏟️ Elegir otro deporte
C. 🔄 Cambiar la edad
D. 🏠 Menú principal`;
      return finish();
    }

    if(menu === 'signup_dni'){
      intent='inscripcion_dni'; confidence=.94;
      if(!containsAny(text,['omitir','no tengo','no se','no sé'])){
        s.data.signupDraft.dni = rawText.replace(/\D/g,'') || rawText;
      }
      setMenuContext(s,'signup_socio');
      reply = `Bien ✅

${signupStepPrompt('socio', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_socio'){
      intent='inscripcion_socio'; confidence=.94;
      if(isLetter(rawText,['A']) || containsAny(text,['si','sí','socio'])) s.data.signupDraft.memberStatus = 'Sí';
      else if(isLetter(rawText,['B']) || containsAny(text,['no'])) s.data.signupDraft.memberStatus = 'No';
      else s.data.signupDraft.memberStatus = 'No sabe / a confirmar';

      setMenuContext(s,'signup_phone');
      reply = `Perfecto ✅

${signupStepPrompt('phone', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_phone'){
      intent='inscripcion_telefono'; confidence=.94;
      s.data.signupDraft.phone = rawText;
      setMenuContext(s,'signup_email');
      reply = `Gracias ✅

${signupStepPrompt('email', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_email'){
      intent='inscripcion_mail'; confidence=.94;
      if(!containsAny(text,['omitir','no tengo','no','saltear'])){
        s.data.signupDraft.email = rawText;
      }
      setMenuContext(s,'signup_notes');
      reply = `Bien ✅

${signupStepPrompt('notes', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'signup_notes'){
      intent='inscripcion_observaciones'; confidence=.94;
      if(!containsAny(text,['no','ninguna','sin observaciones','omitir'])){
        s.data.signupDraft.notes = rawText;
      } else {
        s.data.signupDraft.notes = '';
      }
      setMenuContext(s,'signup_confirm');
      reply = `Listo, ya tengo los datos 😊

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_name'){
      intent='inscripcion_editar_nombre'; confidence=.96;
      s.data.signupDraft.name = rawText;
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé el nombre.

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_age'){
      intent='inscripcion_editar_edad'; confidence=.96;
      s.data.signupDraft.age = rawText;
      const blockedAge = signupAgeBlockedReply(data, s, rawText);
      if(blockedAge){
        validateAndApplySignupAge(data, s, rawText);
        setMenuContext(s,'signup_age_invalid');
        reply = `✅ Actualicé la edad, pero ojo:

${blockedAge}`;
        return finish();
      }
      const advice = validateAndApplySignupAge(data, s, rawText);
      setMenuContext(s,'signup_confirm');
      const actividadActual = s.data.signupDraft.activity || s.data.currentActivity || 'la actividad elegida';
      const categoriaActual = s.data.signupDraft.category || 'Categoría a confirmar';
      reply = `✅ Listo, actualicé solo la edad.${advice}

La actividad sigue siendo: **${actividadActual}**
Categoría recomendada ahora: **${categoriaActual}**

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_phone'){
      intent='inscripcion_editar_telefono'; confidence=.96;
      s.data.signupDraft.phone = rawText;
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé el teléfono.

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_dni'){
      intent='inscripcion_editar_dni'; confidence=.96;
      if(containsAny(text,['omitir','no tengo','no se','no sé'])) s.data.signupDraft.dni = '';
      else s.data.signupDraft.dni = rawText.replace(/\D/g,'') || rawText;
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé el DNI.

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_email'){
      intent='inscripcion_editar_mail'; confidence=.96;
      if(containsAny(text,['omitir','no tengo','no','saltear'])) s.data.signupDraft.email = '';
      else s.data.signupDraft.email = rawText;
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé el mail.

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_activity'){
      intent='inscripcion_editar_actividad'; confidence=.96;
      const act = detectActivityFreeText(rawText);
      if(!act){
        reply = `No pude ubicar esa actividad todavía.

Escribime el deporte o actividad, por ejemplo: Softbol, Fútbol, Básquet, Natatorio o Gimnasia.`;
        return finish();
      }
      s.data.signupDraft.activity = act.label;
      s.data.currentActivity = act.label;
      const info = extractAgeOrBirthYear(s.data.signupDraft.age || '');
      if(info){
        const rec = phase6RecommendRule(data, act.label, info, s.data.signupDraft.branch || s.data.userBranch || '');
        if(rec){
          s.data.signupDraft.category = rec.label || s.data.signupDraft.category;
          s.data.signupDraft.branch = rec.branch || s.data.signupDraft.branch || '';
          s.data.currentCategory = rec.label || s.data.currentCategory;
        } else {
          s.data.signupDraft.category = 'Categoría a confirmar';
        }
      } else {
        s.data.signupDraft.category = 'Categoría a confirmar';
      }
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé la actividad.

Actividad actual: **${s.data.signupDraft.activity}**
Categoría recomendada: **${s.data.signupDraft.category || 'Categoría a confirmar'}**

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_edit_notes'){
      intent='inscripcion_editar_observaciones'; confidence=.96;
      if(containsAny(text,['no','ninguna','sin observaciones','omitir'])) s.data.signupDraft.notes = '';
      else s.data.signupDraft.notes = rawText;
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé las observaciones.

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_confirm'){
      if(isLetter(rawText,['A']) || containsAny(text,['confirmar','confirmo','si','sí','dale','ok'])){
        intent='inscripcion_registrada'; confidence=.98;
        const dup = findDuplicateRegistration(data, phone, s.data.signupDraft);
        if(dup){
          s.data.duplicateRegistrationId = dup.id;
          const st=(dup.status||'Pendiente');
          let msg='⚠️ Ya existe una inscripción o solicitud para esta actividad.';
          if(st==='Sin cupo') msg='⚠️ Ya figurás en la lista de espera de esta actividad.';
          else if(st==='Confirmada') msg='✅ Esta persona ya figura confirmada en esta actividad.';

          reply=`${msg}

Actividad: ${dup.activity} - ${dup.category || 'Categoría a confirmar'}
Estado: ${st}

¿Querés actualizar los datos existentes con este resumen?

${signupSummary(s.data.signupDraft)}

A. ✅ Actualizar datos existentes
B. 📲 Hablar con administración
C. 🏠 Menú principal`;
          setMenuContext(s,'signup_duplicate');
          return finish();
        }
        const resumen = signupSummary(s.data.signupDraft);
        const registration = addRegistration(data, phone, s.data.signupDraft);

        setMenuContext(s,'signup_done');
        reply = `✅ Solicitud de inscripción generada

${resumen}

La solicitud quedó registrada con estado: 🟡 Pendiente.

Administración va a revisar:
• cupo disponible
• documentación requerida
• valor actualizado
• forma de pago

${adminSignupWhatsAppLine(data, s.data.signupDraft)}

¿Qué querés hacer ahora?
A. 📝 Cargar otra inscripción
B. 📲 Hablar con administración
C. 🏠 Menú principal`;
        return finish();
      }

      if(isLetter(rawText,['B'])){
        setMenuContext(s,'signup_edit_name');
        reply = `Dale, modificamos solo el nombre 😊

Escribime únicamente el nuevo nombre y apellido.`;
        return finish();
      }
      if(isLetter(rawText,['C'])){
        setMenuContext(s,'signup_edit_age');
        reply = `Dale, modificamos solo la edad 😊

Escribime la nueva edad o fecha de nacimiento.`;
        return finish();
      }
      if(isLetter(rawText,['D'])){
        setMenuContext(s,'signup_edit_phone');
        reply = `Dale, modificamos solo el teléfono 😊

Escribime el nuevo teléfono de contacto.`;
        return finish();
      }
      if(isLetter(rawText,['E'])){
        setMenuContext(s,'signup_edit_dni');
        reply = `Dale, modificamos solo el DNI 😊

Escribime el nuevo DNI, o poné OMITIR.`;
        return finish();
      }
      if(isLetter(rawText,['F'])){
        setMenuContext(s,'signup_edit_email');
        reply = `Dale, modificamos solo el mail 😊

Escribime el nuevo mail, o poné OMITIR.`;
        return finish();
      }
      if(isLetter(rawText,['G'])){
        setMenuContext(s,'signup_edit_activity');
        reply = `Dale, modificamos solo el deporte / actividad 😊

Escribime la nueva actividad. Ejemplo: Softbol, Fútbol, Básquet, Natatorio.`;
        return finish();
      }
      if(isLetter(rawText,['H'])){
        setMenuContext(s,'signup_edit_notes');
        reply = `Dale, modificamos solo las observaciones 😊

Escribime la nueva observación, o poné NO.`;
        return finish();
      }
      if(isLetter(rawText,['I']) || containsAny(text,['cancelar','cancelo'])){
        intent='inscripcion_cancelada'; confidence=.92;
        clearMenuContext(s); s.data.signupDraft = {};
        reply = `Solicitud cancelada.

${panchitoMenu()}`;
        return finish();
      }

      reply = `No llegué a interpretar esa opción.

${signupStepPrompt('confirm', s.data.signupDraft)}`;
      return finish();
    }

    if(menu === 'signup_duplicate'){
      if(isLetter(rawText,['A']) || containsAny(text,['actualizar','modificar','usar estos datos'])){
        const dup = (data.registrations||[]).find(r => String(r.id) === String(s.data.duplicateRegistrationId));
        const updated = updateDuplicateRegistration(dup, s.data.signupDraft || {});
        setMenuContext(s,'signup_done');
        reply = `✅ Listo, actualicé la inscripción existente.

${signupSummary(updated || s.data.signupDraft)}

Estado: ${updated?.status || 'Pendiente actualización'}

¿Qué querés hacer ahora?
A. 📝 Cargar otra inscripción
B. 📲 Hablar con administración
C. 🏠 Menú principal`;
        return finish();
      }
      if(isLetter(rawText,['B'])){
        intent='administracion_por_duplicado'; confidence=.94;
        reply = goAdmin(data, s, phone, rawText, 'Usuario detectó inscripción duplicada y pidió administración');
        return finish();
      }
      if(isLetter(rawText,['C'])){
        intent='menu_por_duplicado'; confidence=.94;
        s.data.signupDraft = {};
        clearMenuContext(s);
        reply = panchitoMenu();
        return finish();
      }
      reply = `No llegué a interpretar esa opción.

A. ✅ Actualizar datos existentes
B. 📲 Hablar con administración
C. 🏠 Menú principal`;
      return finish();
    }

    if(menu === 'signup_done'){
      if(isLetter(rawText,['A'])){
        intent='nueva_inscripcion'; confidence=.94;
        const last = s.data.signupDraft || {};
        s.data.signupDraft = { activity:last.activity || 'Actividad', category:last.category || 'Categoría a confirmar', source:'Panchito' };
        setMenuContext(s,'signup_name');
        reply = `Dale, cargamos otra solicitud de inscripción.

${signupStepPrompt('name', s.data.signupDraft)}`;
        return finish();
      }
      if(isLetter(rawText,['B'])){
        intent='administracion_desde_inscripcion'; confidence=.94;
        reply = goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde solicitud de inscripción');
        return finish();
      }
      if(isLetter(rawText,['C'])){
        intent='menu_desde_inscripcion'; confidence=.94;
        s.data.signupDraft = {};
        clearMenuContext(s);
        reply = panchitoMenu();
        return finish();
      }
      reply = `No llegué a interpretar esa opción.

¿Qué querés hacer ahora?
A. 📝 Cargar otra inscripción
B. 📲 Hablar con administración
C. 🏠 Menú principal`;
      return finish();
    }
  }

  if(['admin','admin_dni','admin_dni_not_found','admin_name','admin_phone','admin_topic','admin_message','admin_done'].includes(menu)){
    if(containsAny(text,['menu','menú','inicio','salir','cancelar','volver'])){
      intent='menu'; confidence=.9;
      clearMenuContext(s);
      s.data.adminDraft = {};
      reply = panchitoMenu();
      return finish();
    }

    s.data.adminDraft = s.data.adminDraft || {};

    if(menu === 'admin' || menu === 'admin_dni'){
      intent='admin_identificacion'; confidence=.97;
      if(containsAny(text,['omitir','no soy socio','no tengo'])){
        setMenuContext(s,'admin_name');
        reply = `No hay problema. Continuamos de forma manual.

${adminStepPrompt('name')}

Escribí MENÚ para cancelar.`;
        return finish();
      }
      const idValue = String(rawText||'').replace(/[^0-9A-Za-z-]/g,'').trim();
      if(idValue.length < 4){
        reply = `No pude reconocer ese dato. Ingresá el DNI completo o el número de socio.

También podés escribir *OMITIR*.`;
        return finish();
      }
      let memberResult = null;
      let source = 'local';
      try{
        if(digitalClubReady()){
          const apiResult = await digitalClubFindMember(idValue);
          memberResult = normalizeDigitalClubMember(apiResult);
          source = 'DigitalClub';
        } else {
          memberResult = normalizeLocalMember(findMember(data,idValue));
        }
      } catch(e){
        console.error('Error identificando socio:', e?.message||e);
        memberResult = normalizeLocalMember(findMember(data,idValue));
        source = memberResult ? 'base local' : 'sin resultado';
      }
      if(!memberResult){
        s.data.adminDraft.lookupValue = idValue;
        setMenuContext(s,'admin_dni_not_found');
        reply = `No encontré un socio con ese DNI o número.

A. Intentar nuevamente
B. Continuar cargando los datos manualmente
C. Volver al menú principal`;
        return finish();
      }
      Object.assign(s.data.adminDraft, memberResult, {lookupSource:source, lookupValue:idValue});
      setMenuContext(s,'admin_topic');
      const acts = Array.isArray(memberResult.activities) ? memberResult.activities.join(', ') : (memberResult.activities||'Sin actividades cargadas');
      reply = `✅ Socio identificado

👤 ${memberResult.name || '-'}
🎫 N.º de socio: ${memberResult.memberNo || '-'}
📌 Estado: ${memberResult.status || '-'}
💰 Cuota: ${memberResult.feeStatus || '-'}
🏅 Actividades: ${acts}

${adminStepPrompt('topic')}

Escribí MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'admin_dni_not_found'){
      if(isLetter(rawText,['A'])){
        setMenuContext(s,'admin_dni');
        reply = adminStepPrompt('dni');
        return finish();
      }
      if(isLetter(rawText,['B'])){
        setMenuContext(s,'admin_name');
        reply = adminStepPrompt('name');
        return finish();
      }
      if(isLetter(rawText,['C'])){
        clearMenuContext(s); s.data.adminDraft={}; reply=panchitoMenu(); return finish();
      }
      reply = `Elegí una opción:
A. Intentar nuevamente
B. Continuar manualmente
C. Menú principal`;
      return finish();
    }

    if(menu === 'admin_name'){
      intent='admin_nombre'; confidence=.92;
      s.data.adminDraft.name = rawText;
      setMenuContext(s,'admin_phone');
      reply = `Gracias ✅

${adminStepPrompt('phone')}

Escribí MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'admin_phone'){
      intent='admin_telefono'; confidence=.92;
      s.data.adminDraft.phone = rawText;
      setMenuContext(s,'admin_topic');
      reply = `Perfecto ✅

${adminStepPrompt('topic')}

Escribí MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'admin_topic'){
      intent='admin_tema'; confidence=.92;
      s.data.adminDraft.topic = rawText;
      setMenuContext(s,'admin_message');
      reply = `Bien ✅

${adminStepPrompt('message')}

Escribí MENÚ para cancelar.`;
      return finish();
    }

    if(menu === 'admin_message'){
      intent='admin_derivacion_completa'; confidence=.97;
      s.data.adminDraft.message = rawText;
      const resumen = adminSummary(s.data.adminDraft);
      const pending = addPending(data, phone, resumen, 'administracion', s.data.adminDraft.note || 'Derivación a administración');
      pending.name = s.data.adminDraft.name || '';
      pending.contactPhone = s.data.adminDraft.phone || '';
      pending.dni = s.data.adminDraft.dni || '';
      pending.memberNo = s.data.adminDraft.memberNo || '';
      pending.memberStatus = s.data.adminDraft.status || '';
      pending.feeStatus = s.data.adminDraft.feeStatus || '';
      pending.activities = s.data.adminDraft.activities || [];
      pending.lookupSource = s.data.adminDraft.lookupSource || '';
      pending.topic = s.data.adminDraft.topic || '';
      pending.message = s.data.adminDraft.message || '';
      pending.priority = derivationPriority(s.data.adminDraft);
      pending.whatsappLink = replyToUserWhatsAppLink(s.data.adminDraft, phone);
      setMenuContext(s,'admin_done');
      setAttentionMode(s,'human',{
        handoffAt:new Date().toISOString(),
        handoffReason:s.data.adminDraft.note || 'Derivación a administración',
        handoffId:pending.id
      });
      addHandoffHistory(data,s,'derived',{priority:pending.priority,topic:pending.topic||'',name:pending.name||''});
      reply = `✅ Consulta registrada

Estado: DERIVADA A ADMINISTRACIÓN
Tipo: ${pending.priority}
N°: DER-${String(pending.id).slice(-4)}

${resumen}

${humanModeMessage()}

${adminContact(data)}`;
      return finish();
    }

    if(menu === 'admin_done'){
      if(isThanksText(text)){
        intent='gracias_derivacion'; confidence=.96;
        const surveyTopic = currentTopic(s) || s.data?.currentActivity || s.data?.menu || 'consulta';
        setSession(s,'waiting_satisfaction',{surveyTopic});
        reply = thanksCloseMessage();
        return finish();
      }

      if(isByeText(text)){
        intent='despedida_derivacion'; confidence=.96;
        const surveyTopic = currentTopic(s) || s.data?.currentActivity || s.data?.menu || 'consulta';
        clearMenuContext(s);
        s.data.adminDraft = {};
        setSession(s,'waiting_satisfaction',{surveyTopic});
        reply = thanksCloseMessage();
        return finish();
      }

      if(isLetter(rawText,['A'])){
        intent='admin_nueva_consulta'; confidence=.95;
        s.data.adminDraft = {};
        setMenuContext(s,'admin_dni');
        reply = `Dale, cargamos otra consulta.

${adminStepPrompt('dni')}`;
        return finish();
      }
      if(isLetter(rawText,['B'])){
        intent='menu_desde_derivacion'; confidence=.95;
        clearMenuContext(s);
        s.data.adminDraft = {};
        reply = panchitoMenu();
        return finish();
      }
      

      reply = `No llegué a interpretar esa opción.

¿Qué querés hacer ahora?
A. 📝 Cargar otra consulta
B. 🏠 Volver al menú principal`;
      return finish();
    }
  }

  if(['claim','claim_name','claim_phone','claim_area','claim_detail','claim_done'].includes(menu)){
    if(containsAny(text,['menu','menú','inicio','salir','cancelar','volver'])){
      intent='menu'; confidence=.9;
      clearMenuContext(s);
      reply = panchitoMenu();
      return finish();
    }

    if(containsAny(text,['admin','administracion','administración','secretaria','secretaría','persona','hablar con alguien','atencion','atención']) || text === 'e'){
      intent='administracion'; confidence=.94;
      clearMenuContext(s);
      reply = goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde reclamos');
      return finish();
    }

    s.data.claimDraft = s.data.claimDraft || {};

    if(menu === 'claim' || menu === 'claim_name'){
      intent='reclamo_nombre'; confidence=.9;
      s.data.claimDraft.name = rawText;
      setMenuContext(s,'claim_phone');
      reply = `Gracias ✅

${claimStepPrompt('phone')}

También podés escribir “administración” o “menú”.`;
      return finish();
    }

    if(menu === 'claim_phone'){
      intent='reclamo_telefono'; confidence=.9;
      s.data.claimDraft.phone = rawText;
      setMenuContext(s,'claim_area');
      reply = `Perfecto ✅

${claimStepPrompt('area')}

También podés escribir “administración” o “menú”.`;
      return finish();
    }

    if(menu === 'claim_area'){
      intent='reclamo_area'; confidence=.9;
      s.data.claimDraft.area = rawText;
      setMenuContext(s,'claim_detail');
      reply = `Bien ✅

${claimStepPrompt('detail')}

También podés escribir “administración” o “menú”.`;
      return finish();
    }

    if(menu === 'claim_detail'){
      intent='reclamo_completo'; confidence=.95;
      s.data.claimDraft.detail = rawText;
      const resumen = claimSummary(s.data.claimDraft);
      const pending = addPending(data, phone, resumen, 'reclamo', 'Reclamo o sugerencia');
      pending.name = s.data.claimDraft.name || '';
      pending.contactPhone = s.data.claimDraft.phone || '';
      pending.topic = s.data.claimDraft.area || 'Reclamo';
      pending.message = s.data.claimDraft.detail || '';
      pending.priority = '🔴 Reclamo';
      pending.whatsappLink = replyToUserWhatsAppLink({
        name: pending.name,
        phone: pending.contactPhone,
        topic: pending.topic,
        message: pending.message
      }, phone);
      setMenuContext(s,'claim_done');
      reply = `✅ Reclamo registrado

Estado: PENDIENTE
Tipo: 🔴 Reclamo
N°: REC-${String(pending.id).slice(-4)}

${resumen}

La consulta quedó guardada en el panel: 📋 Consultas / Reclamos.
Administración puede verla y responder por WhatsApp.

¿Qué querés hacer ahora?
A. Cargar otro reclamo
B. Hablar con administración
C. Volver al menú principal`;
      return finish();
    }

    if(menu === 'claim_done'){
      if(isLetter(rawText,['A'])){
        intent='nuevo_reclamo'; confidence=.95;
        s.data.claimDraft = {};
        setMenuContext(s,'claim_name');
        reply = responseClaimMenu();
        return finish();
      }
      if(isLetter(rawText,['B'])){
        intent='administracion'; confidence=.95;
        clearMenuContext(s);
        reply = goAdmin(data, s, phone, rawText, 'Usuario pidió administración después de cargar reclamo');
        return finish();
      }
      if(isLetter(rawText,['C'])){
        intent='menu'; confidence=.95;
        clearMenuContext(s);
        reply = panchitoMenu();
        return finish();
      }
      reply = 'Podés elegir A para cargar otro reclamo, B para hablar con administración o C para volver al menú principal.';
      return finish();
    }
  }

  if(menu === 'activities' && isLetter(rawText, ['A','B','C','D','E','F','G'])){
    intent='submenu_actividades'; confidence=.96;
    if(letter==='A'){ setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística'; reply=responseGymnastics(); return finish(); }
    if(letter==='B'){ setMenuContext(s,'basket_legacy'); s.data.currentActivity='Básquet'; reply=responseBasketMenu(); return finish(); }
    if(letter==='C'){ setMenuContext(s,'softbol'); s.data.currentActivity='Softbol'; reply=responseSoftbol(); return finish(); }
    if(letter==='D'){ setMenuContext(s,'paleta'); s.data.currentActivity='Pelota a Paleta'; reply=responsePaleta(); return finish(); }
    if(letter==='E'){ setMenuContext(s,'football_legacy'); s.data.currentActivity='Fútbol'; reply=responseFootballMenu(); return finish(); }
    if(letter==='F'){ setMenuContext(s,'natatorio'); s.data.currentActivity='Natación'; reply=responseNatatorioMenu(false); return finish(); }
    if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu('volver'); return finish(); }
  }

  if(['gymnastics','softbol','paleta'].includes(menu) && isLetter(rawText, ['A','B','C'])){
    intent='actividad_horarios_completos'; confidence=.98;
    if(letter==='A'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='B'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='C'){ reply=goAdmin(data,s,phone,rawText,`Consulta desde ${s.data.currentActivity || 'actividad'}`); return finish(); }
  }

  if(menu === 'football_years' && isLetter(rawText, ['A','B','C','D','E','F'])){
    intent='submenu_futbol_anios'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2017','Fútbol',['2017'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2018','Fútbol',['2018'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2019','Fútbol',['2019'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setDiscipline(s,'discipline_detail','⚽ Categorías 2020-2021','Fútbol',['2020','2021'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='E'){ setMenuContext(s,'football'); reply=responseFootballMenu('back'); return finish(); }
    if(letter==='F'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'after_discipline_answer'){
    intent='post_resultado_disciplina'; confidence=.94;
    const back = s.data?.disciplineDetail?.backMenu || 'activities';
    const lastKind = s.data?.lastDisciplineAnswer || '';
    let wanted = disciplineAfterOptionByLetter(lastKind, letter) || disciplineFollowUpKind(rawText);

    if(wanted === 'schedule' || wanted === 'teacher' || wanted === 'price' || wanted === 'inscription'){
      reply = disciplineAnswer(data, s, wanted);
      return finish();
    }
    if(wanted === 'admin'){
      reply = goAdmin(data, s, phone, rawText, `Usuario pidió administración desde ${s.data?.disciplineDetail?.title || 'disciplina'}`);
      return finish();
    }
    if(wanted === 'back'){ setMenuContext(s, back); reply = backMenuReply(back); return finish(); }
    if(wanted === 'menu'){ s.data.priceFlow=false; s.data.priceMode=''; clearMenuContext(s); reply = panchitoMenu(); return finish(); }
    if(wanted === 'free'){ clearMenuContext(s); reply = 'Contame qué necesitás consultar y te ayudo.'; return finish(); }

    reply = disciplineNextMenu(lastKind).trim();
    return finish();
  }

  if(menu === 'price_discipline_detail'){
    intent='precio_inscripcion_categoria'; confidence=.95;
    if(containsAny(text,['precio','cuota','valor','sale','costo']) || isLetter(rawText,['A'])){ reply=disciplineAnswer(data,s,'price'); return finish(); }
    if(containsAny(text,['inscripcion','inscripción','inscribir','anotar']) || isLetter(rawText,['B'])){ reply=disciplineAnswer(data,s,'inscription'); return finish(); }
    if(isLetter(rawText,['C'])){
      const back = s.data?.disciplineDetail?.backMenu || 'activities';
      setMenuContext(s, back);
      reply = backMenuReply(back);
      return finish();
    }
    if(isLetter(rawText,['D'])){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(isLetter(rawText,['E'])){ s.data.priceFlow=false; s.data.priceMode=''; clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    reply = priceDisciplineDetail(data, s);
    return finish();
  }

  if(menu === 'discipline_detail'){
    intent='detalle_disciplina'; confidence=.94;
    if(containsAny(text,['horario','horarios','dias','días','cuando']) || isLetter(rawText,['A'])){ reply=disciplineAnswer(data,s,'schedule'); return finish(); }
    if(containsAny(text,['profesor','profe','entrenador','docente']) || isLetter(rawText,['B'])){ reply=disciplineAnswer(data,s,'teacher'); return finish(); }
    if(containsAny(text,['precio','cuota','valor','sale','costo']) || isLetter(rawText,['C'])){ reply=disciplineAnswer(data,s,'price'); return finish(); }
    if(containsAny(text,['inscripcion','inscripción','inscribir','anotar']) || isLetter(rawText,['D'])){ reply=disciplineAnswer(data,s,'inscription'); return finish(); }
    if(isLetter(rawText,['E'])){ reply=goAdmin(data, s, phone, rawText, `Usuario pidió administración desde ${s.data?.disciplineDetail?.title || 'disciplina'}`); return finish(); }
    if(isLetter(rawText,['F'])){
      const back = s.data?.disciplineDetail?.backMenu || 'activities';
      setMenuContext(s, back);
      reply = backMenuReply(back);
      return finish();
    }
    if(isLetter(rawText,['G'])){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    reply = disciplineAnswer(data,s,'all');
    return finish();
  }

  if(['activity_price','basket_price','football_price'].includes(menu) && isLetter(rawText, ['A','B','C'])){
    intent='acciones_post_precio_actividad'; confidence=.94;
    if(letter==='A'){ reply = goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde precios de actividad'); return finish(); }
    if(letter==='B'){ setMenuContext(s,'activities'); reply = responseActivityMenu(); return finish(); }
    if(letter==='C'){ clearMenuContext(s); reply = panchitoMenu(); return finish(); }
  }


  if(menu === 'natatorio' && isLetter(rawText, ['A','B','C','D'])){
    intent='submenu_natatorio'; confidence=.92;
    if(letter==='A'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='B'){
      setMenuContext(s,'natatorio_plan');
      reply=`🏊 Plan de Natación

El Plan de Natación está destinado a personas con discapacidad que quieran iniciarse en el aprendizaje y en la práctica deportiva.

La información y la inscripción se consultan presencialmente en:
Dirección de Deportes Provincial
Quintana y Pellegrini, Santa Rosa
Lunes a viernes de 9 a 12 hs.

El Plan tiene cupos limitados. Si no hay una vacante disponible, la persona puede quedar anotada para ser contactada cuando haya disponibilidad.

¿Qué querés hacer ahora?
A. Volver a Natación
B. Consultar otra actividad
C. Volver al menú principal
D. Hablar con Administración`;
      return finish();
    }
    if(letter==='C'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='D'){ reply=goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde natatorio'); return finish(); }
  }

  if(menu === 'natatorio_plan' && isLetter(rawText, ['A','B','C','D'])){
    intent='submenu_plan_natacion'; confidence=.92;
    if(letter==='A'){ setMenuContext(s,'natatorio'); reply=responseNatatorioMenu(false); return finish(); }
    if(letter==='B'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='C'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='D'){ reply=goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde Plan de Natación'); return finish(); }
  }

  if(menu === 'natatorio_after' && isLetter(rawText, ['A','B','C','D'])){
    intent='post_natatorio'; confidence=.92;
    if(letter==='A'){ reply=goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde respuesta de natatorio'); return finish(); }
    if(letter==='B'){ setMenuContext(s,'natatorio'); reply=responseNatatorioMenu(false); return finish(); }
    if(letter==='C'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='D'){ setMenuContext(s,'free'); reply='Contame qué necesitás consultar y te ayudo.'; return finish(); }
  }

  if(menu === 'institutional' && isLetter(rawText,['A','B','C','D','E'])){
    const kinds={A:'press',B:'cv',C:'project',D:'provider',E:'sponsor'};
    setMenuContext(s,'institutional_detail');
    reply=institutionalDetail(kinds[letter]);
    return finish();
  }
  if(menu === 'institutional_detail' && isLetter(rawText,['A','B'])){
    if(letter==='A'){ setMenuContext(s,'institutional'); reply=responseInstitutionalMenu(); return finish(); }
    clearMenuContext(s); reply=panchitoMenu('volver'); return finish();
  }
  if(menu === 'predio' && isLetter(rawText,['A','B'])){
    if(letter==='A'){ clearMenuContext(s); reply=panchitoMenu('volver'); return finish(); }
    reply=goAdmin(data,s,phone,rawText,'Consulta desde Predio'); return finish();
  }
  if(menu === 'admin_word' && isLetter(rawText,['A','B','C'])){
    if(letter==='A'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='B'){ setMenuContext(s,'payments'); reply=responsePaymentsMenu(); return finish(); }
    clearMenuContext(s); reply=panchitoMenu('volver'); return finish();
  }
  if(menu === 'other' && isLetter(rawText,['A','B'])){
    if(letter==='A'){ clearMenuContext(s); reply=panchitoMenu('volver'); return finish(); }
    reply=goAdmin(data,s,phone,rawText,'Otra consulta'); return finish();
  }

  if(menu === 'prices' && isLetter(rawText,['A','B','C','D','E'])){
    if(letter==='A'){ s.data.priceFlow=true; s.data.priceMode='price'; setMenuContext(s,'word_price_activity'); reply=`¿Sobre qué actividad querés consultar?

A. Gimnasia artística
B. Sóftbol
C. Pelota a paleta
D. Natación
E. Otra actividad`; return finish(); }
    if(letter==='B'){ s.data.priceFlow=true; s.data.priceMode='inscription'; setMenuContext(s,'word_signup_activity'); reply=`¿En qué actividad querés inscribirte?

A. Gimnasia artística
B. Sóftbol
C. Pelota a paleta
D. Natación
E. Otra actividad`; return finish(); }
    if(letter==='C'){ setMenuContext(s,'word_simple_end'); reply=`¡Qué bueno que quieras sumarte al club! ⚫⚪

Para conocer requisitos, valores y documentación necesaria, comunicate con:
${adminContact(data)}

¿Qué querés hacer ahora?
A. Consultar actividades
B. Volver al menú principal`; return finish(); }
    if(letter==='D'){ setMenuContext(s,'human_minor_activity'); reply=`Si la inscripción es para un menor, por favor que continúe un adulto responsable 😊

¿Qué actividad querés consultar?
A. Gimnasia artística
B. Sóftbol o Pelota a paleta
C. Básquet o Fútbol
D. Natación
E. Plan de Natación`; return finish(); }
    if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu('volver'); return finish(); }
  }
  if((menu==='word_price_activity' || menu==='word_signup_activity') && isLetter(rawText,['A','B','C','D','E'])){
    const mode=menu==='word_price_activity'?'precio actualizado':'inscripción';
    const map={A:['Gimnasia artística','Patricia “Pato” Saavedra','2954 29-6451'],B:['Sóftbol','Ángel Yorgoban','2954 66-4276'],C:['Pelota a paleta','Lucas Gómez','2954 44-6373'],D:['Natación','José Luis “Chino” Weighant','2954 36-9045'],E:['Básquet, Fútbol u otra actividad','Secretaría Club All Boys - Agustina Barreto','2954 60-9312']};
    const x=map[letter]; setMenuContext(s,'word_price_end');
    reply=`Para consultar ${mode} de ${x[0]}:
${x[1]}
WhatsApp: ${x[2]}

¿Qué querés hacer ahora?
A. Consultar otra actividad
B. Volver al menú principal`;
    return finish();
  }
  if(menu==='word_price_end' && isLetter(rawText,['A','B'])){
    if(letter==='A'){ setMenuContext(s,'prices'); reply=responsePricesMenu(); return finish(); }
    clearMenuContext(s); reply=panchitoMenu('volver'); return finish();
  }
  if(menu==='word_simple_end' && isLetter(rawText,['A','B'])){
    if(letter==='A'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    clearMenuContext(s); reply=panchitoMenu('volver'); return finish();
  }

  if(menu === 'payments' && isLetter(rawText, ['A','B','C','D','E'])){
    intent='submenu_pagos'; confidence=.94;
    if(letter==='A'){ setSession(s,'waiting_dni_fee',{}); setTopic(s,'cuota',{}); reply=`Para consultar tu estado de cuota, indicame tu DNI o número de socio.`; return finish(); }
    if(letter==='B'){
      addPending(data, phone, rawText, 'cuota', 'Usuario avisó que ya pagó');
      setMenuContext(s,'payments_after');
      reply=`Perfecto. Si realizaste un pago, podés enviar el comprobante a Administración para que puedan verificarlo.

${adminContact(data)}

La administración podrá revisar el comprobante y confirmar el estado del pago.${afterGeneralMenu()}`;
      return finish();
    }
    if(letter==='C'){
      setMenuContext(s,'payments_after');
      reply=`Podés pagar por transferencia 💳

Alias:
${data.club.paymentAlias || 'allboyseslapampa'}

Después de pagar, enviá el comprobante a Administración para que puedan verificarlo.

${adminContact(data)}${afterGeneralMenu()}`;
      return finish();
    }
    if(letter==='D'){
      addPending(data, phone, rawText, 'administracion', 'Usuario pidió administración desde pagos');
      setMenuContext(s,'payments_after');
      reply=`Claro 😊

Te derivo con administración.

${adminContact(data)}${afterGeneralMenu()}`;
      return finish();
    }
    if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }



  if(menu === 'general_after_prices' && isLetter(rawText, ['A','B','C'])){
    intent='post_consulta_general'; confidence=.94;
    if(letter==='A'){ setMenuContext(s,'prices'); reply=responsePricesMenu(); return finish(); }
    if(letter==='B'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='C'){ clearMenuContext(s); reply='Contame qué necesitás consultar y te ayudo.'; return finish(); }
  }

  if(menu === 'payments_after' && isLetter(rawText, ['A','B','C'])){
    intent='post_pagos'; confidence=.94;
    if(letter==='A'){ setMenuContext(s,'payments'); reply=responsePaymentsMenu(); return finish(); }
    if(letter==='B'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='C'){ clearMenuContext(s); reply='Contame qué necesitás consultar y te ayudo.'; return finish(); }
  }

  if(menu === 'other' && isLetter(rawText, ['A','B'])){
    intent='submenu_otra_consulta'; confidence=.9;
    if(letter==='A'){
      clearMenuContext(s);
      reply = panchitoMenu();
      return finish();
    }
    if(letter==='B'){
      reply = goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde otra consulta');
      return finish();
    }
  }

  // V77 - Comandos de navegación dentro de submenús.
  // Ahora VOLVER/ATRÁS respeta el nivel real del menú:
  // basket_init -> basket, football_years -> football, deporte -> actividades.
  // Además MENÚ/INICIO siempre limpia el contexto y vuelve al principal.
  if(containsAny(text,['menu','menú','inicio','principal','empezar de nuevo','volver al menu','volver al menú'])){
    intent='menu_global_v77'; confidence=.97;
    s.data.priceFlow=false; s.data.priceMode='';
    clearMenuContext(s); setTopic(s,'',{});
    reply=panchitoMenu('volver');
    return finish();
  }

  if(containsAny(text,['atras','atrás','volver','volver atras','volver atrás','regresar']) && menu){
    intent='volver_contextual_v77'; confidence=.94;
    const parentMap = {
      basket_fem:'basket', basket_masc:'basket', basket_init:'basket',
      football_years:'football',
      discipline_detail: (s.data?.disciplineDetail?.backMenu || 'activities'),
      price_discipline_detail: (s.data?.disciplineDetail?.backMenu || 'activities'),
      natatorio_after:'natatorio',
      general_after_prices:'prices', payments_after:'payments',
      activity_price:'activities', basket_price:'basket', football_price:'football',
      gymnastics:'activities', softbol:'activities', paleta:'activities',
      basket:'activities', football:'activities', natatorio:'main',
      prices:'main', payments:'main', institutional:'main', other:'main'
    };
    const parent = parentMap[menu] || 'main';
    if(parent === 'main'){ clearMenuContext(s); reply=panchitoMenu('volver'); return finish(); }
    setMenuContext(s,parent);
    reply = backMenuReply(parent);
    return finish();
  }


  function finish(){
    data.conversations.unshift({id:Date.now(), phone, text:rawText, reply, intent, confidence, sessionState:s.state, topic:currentTopic(s), createdAt:new Date().toISOString()});
    data.conversations = data.conversations.slice(0,500);
    save(data);
    return { reply, intent, confidence, session:s.state, topic:currentTopic(s) };
  }

  if(containsAny(text,['menu','menú','inicio','ayuda'])){
    intent='menu'; confidence=.95; setSession(s,'idle',{}); setTopic(s,'',{}); setMenuContext(s,'main');
    reply = panchitoMenu();
    return finish();
  }

  // PRIORIDAD ABSOLUTA: cierre de conversación y encuesta.
  // Tiene que ejecutarse antes de letras de menú o submenús para que "gracias", "chau" o "nada más" siempre muestren la encuesta.
  if(s.state !== 'waiting_satisfaction' && s.state !== 'waiting_survey_comment' && (isThanksText(rawText) || isByeText(rawText))){
    intent='cierre_amigable'; confidence=.99;
    const surveyTopic = currentTopic(s) || s.data?.currentActivity || s.data?.menu || 'consulta';
    s.data.adminDraft = {};
    s.data.claimDraft = {};
    s.data.priceFlow = false;
    s.data.priceMode = '';
    clearMenuContext(s);
    setSession(s,'waiting_satisfaction',{surveyTopic});
    reply = thanksCloseMessage();
    return finish();
  }

  if((menu === 'main' || !menu) && isMainMenuLetter()) {
    return routeMainMenuLetter();
  }


  if(false && menu === 'human_minor_activity'){
    const age = extractAge(rawText);
    if(age && !detectActivityFreeText(rawText) && !isLetter(rawText,['A','B','C','D','E'])){
      s.data.userAge = age;
      intent='menor_edad_recibida'; confidence=.91;
      reply = `Perfecto, ${age} años 😊

Ahora decime qué actividad está buscando:

A. Natatorio / pileta 🏊
B. Fútbol ⚽
C. Básquet 🏀
D. Gimnasia artística 🤸
E. Hablar con administración 📞`;
      return finish();
    }
    if(isLetter(rawText,['A']) || containsAny(text,['natatorio','pileta','natacion','natación'])){ setTopic(s,'natatorio',{}); setMenuContext(s,'natatorio'); reply=(s.data.userAge? ageSmartHint(s.data.userAge,'natatorio')+'\n\n':'')+responseNatatorioMenu(true); return finish(); }
    if(isLetter(rawText,['B']) || containsAny(text,['futbol','fútbol'])){ setTopic(s,'actividades',{}); setMenuContext(s,'football'); s.data.currentActivity='Fútbol'; reply=(s.data.userAge? ageSmartHint(s.data.userAge,'futbol')+'\n\n':'')+responseFootballMenu(); return finish(); }
    if(isLetter(rawText,['C']) || containsAny(text,['basquet','básquet','basket'])){ setTopic(s,'actividades',{}); setMenuContext(s,'basket'); s.data.currentActivity='Básquet'; reply=(s.data.userAge? ageSmartHint(s.data.userAge,'basquet')+'\n\n':'')+responseBasketMenu(); return finish(); }
    if(isLetter(rawText,['D']) || containsAny(text,['gimnasia'])){ setTopic(s,'actividades',{}); setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística'; reply=(s.data.userAge? ageSmartHint(s.data.userAge,'gimnasia')+'\n\n':'')+responseGymnastics(); return finish(); }
    if(isLetter(rawText,['E']) || containsAny(text,['admin','administracion','persona'])){ reply=goAdmin(data,s,phone,rawText,'Consulta de menor derivada a administración'); return finish(); }
  }

  // Carnet digital: busca por DNI / socio y muestra ficha preparada para QR.
  if(containsAny(text,['mi carnet','carnet','credencial','qr socio','qr del socio'])){
    if(digits){
      const m=findMember(data,digits);
      intent=m?'carnet_digital':'carnet_no_encontrado'; confidence=m?.id?.toString()? .98 : .8;
      if(m) reply = carnetReply(m, data) + askSatisfaction(s,'carnet digital');
      else { addPending(data, phone, rawText, 'carnet', 'No se encontró socio para carnet digital'); reply = notFoundMemberReply(digits); }
      return finish();
    }
    intent='carnet_pedir_dato'; confidence=.94;
    setSession(s,'waiting_carnet_lookup',{});
    reply = `${friendlyLead('carnet')}\n\nPasame tu DNI o número de socio para mostrar el carnet digital demo.`;
    return finish();
  }

  if(s.state === 'waiting_carnet_lookup'){
    if(digits){
      const m=findMember(data,digits);
      intent=m?'carnet_digital':'carnet_no_encontrado'; confidence=m? .98 : .8;
      if(m) reply = carnetReply(m, data) + askSatisfaction(s,'carnet digital');
      else { addPending(data, phone, rawText, 'carnet', 'No se encontró socio para carnet digital'); reply = notFoundMemberReply(digits); }
      return finish();
    }
    reply='Necesito DNI o número de socio para buscar el carnet. También podés escribir MENÚ para volver.';
    return finish();
  }

  // Atajos inteligentes por nombre de actividad.
  // Si el usuario escribe "futbol", "basquet", "gimnasia", etc. entra directo
  // al menú correcto y no vuelve al menú general de actividades.
  if(containsAny(text,['futbol','fútbol','inferiores','primera','septima','séptima','octava','novena','decima','décima','femenino sub'])){
    intent='actividad_futbol_directa'; confidence=.96;
    setTopic(s,'actividades',{}); setMenuContext(s,'football'); s.data.currentActivity='Fútbol';
    reply = responseFootballMenu();
    return finish();
  }

  if(containsAny(text,['basquet','básquet','basket','básket','basquetbol','básquetbol'])){
    intent='actividad_basquet_directa'; confidence=.98;
    setTopic(s,'actividades',{});
    s.data.currentActivity='Básquet';

    // Si pide rama masculina o femenina, NO mezclamos categorías.
    if(containsAny(text,['masculino','varones','hombres'])){
      setMenuContext(s,'basket_masc');
      if(containsAny(text,['sub 17','sub17'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 17','Básquet',['Masculino Sub 17'],'basket_masc'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      if(containsAny(text,['sub 13','sub13'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 13','Básquet',['Masculino Sub 13'],'basket_masc'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      if(containsAny(text,['sub 15','sub15'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 15','Básquet',['Masculino Sub 15'],'basket_masc'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      if(containsAny(text,['primera','primera division','primera división'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Primera división','Básquet',['Masculino Primera división','Primera división'],'basket_masc'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      if(containsAny(text,['asociativo'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Asociativo','Básquet',['Asociativo'],'basket_masc'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      reply = responseBasketMasculino();
      return finish();
    }

    if(containsAny(text,['femenino','mujeres','chicas'])){
      setMenuContext(s,'basket_fem');
      if(containsAny(text,['sub 17','sub17','primera'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 17 y Primera','Básquet',['Femenino Sub 17','Femenino Primera'],'basket_fem'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      if(containsAny(text,['sub 13','sub13','sub 15','sub15'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 13 y Sub 15','Básquet',['Femenino Sub 13','Femenino Sub 15'],'basket_fem'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      if(containsAny(text,['sub 11','sub11'])){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 11','Básquet',['Femenino Sub 11'],'basket_fem'); reply=disciplineAnswer(data,s,'schedule'); return finish(); }
      reply = responseBasketFemenino();
      return finish();
    }

    if(containsAny(text,['escuelita','inicial','iniciales','sub 9','sub9','mosquitos'])){
      setMenuContext(s,'basket_init');
      reply = responseBasketInicial();
      return finish();
    }

    setMenuContext(s,'basket');
    reply = responseBasketMenu();
    return finish();
  }

  if(containsAny(text,['gimnasia','gimnasia artistica','gimnasia artística'])){
    intent='actividad_gimnasia_directa'; confidence=.94;
    setTopic(s,'actividades',{}); setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística';
    reply = responseGymnastics();
    return finish();
  }

  if(containsAny(text,['softbol','sóftbol'])){
    intent='actividad_softbol_directa'; confidence=.94;
    setTopic(s,'actividades',{}); setMenuContext(s,'softbol'); s.data.currentActivity='Softbol';
    reply = responseSoftbol();
    return finish();
  }

  if(containsAny(text,['pelota paleta','paleta'])){
    intent='actividad_paleta_directa'; confidence=.94;
    setTopic(s,'actividades',{}); setMenuContext(s,'paleta'); s.data.currentActivity='Pelota a Paleta';
    reply = responsePaleta();
    return finish();
  }

  if(containsAny(text,['voley','vóley','volley','volei','voleibol','volleyball','patin','patín','patinaje'])){
    intent='actividad_no_cargada'; confidence=.96;
    const askedActivity = containsAny(text,['patin','patín','patinaje']) ? 'Patín / Patinaje' : 'Vóley';
    addPending(data, phone, rawText, 'actividad_no_cargada', `Consultó por actividad no cargada: ${askedActivity}`);
    reply = responseUnknownActivity(data, askedActivity);
    return finish();
  }

  if(containsAny(text,['admin','administracion','administración','secretaria','secretaría','humano','persona','hablar con alguien','atencion','atención','ventanilla']) || ((!menu || menu === 'main') && text==='e')){
    intent='administracion'; confidence=.92; setTopic(s,'administracion',{});
    addPending(data, phone, rawText, 'administracion', 'Usuario pidió hablar con administración');
    reply = `Claro 😊

Te derivo con administración.

Para ayudar a que te respondan más rápido, escribí en un solo mensaje:
• Tu nombre
• Motivo de la consulta
• Si sos socio/a, tu DNI o número de socio

${adminContact(data)}

Tu mensaje queda registrado para que administración pueda revisarlo.`;
    return finish();
  }

  // Respuestas humanas rápidas para cerrar o saludar sin caer en el fallback.
  if(isThanksText(text)) {
    intent='cierre_amigable'; confidence=.95;
    const surveyTopic = currentTopic(s) || s.data?.currentActivity || s.data?.menu || 'consulta';
    clearMenuContext(s);
    setSession(s,'waiting_satisfaction',{surveyTopic});
    reply = thanksCloseMessage();
    return finish();
  }

  if(isByeText(text)) {
    intent='despedida'; confidence=.95;
    const surveyTopic = currentTopic(s) || s.data?.currentActivity || s.data?.menu || 'consulta';
    clearMenuContext(s);
    setSession(s,'waiting_satisfaction',{surveyTopic});
    reply = thanksCloseMessage();
    return finish();
  }

  // Cuotas por DNI/número: solo se consulta automáticamente si el usuario habla de cuota/socio/DNI.
  // Así evitamos que cualquier número suelto del chat se interprete como socio.
  if(digits && containsAny(text,['dni','socio','cuota','cuotas','deuda','pago','pagar','vencimiento','carnet'])){
    const m = findMember(data, digits);
    intent = m ? 'consulta_socio' : 'socio_no_encontrado';
    confidence = m ? .98 : .78;
    setSession(s, m ? 'fee_checked' : 'waiting_dni_fee', {lastDni:digits,lastMemberId:m?.id||null});
    setTopic(s,'cuota',{});
    if(m) reply = memberReply(m);
    else {
      addPending(data, phone, rawText, 'cuota', 'DNI/número no encontrado en demo');
      reply = notFoundMemberReply(digits);
    }
    return finish();
  }

  if(text==='c' || containsAny(text,['cuota','cuotas','deuda','debo','pagar','pago','pague','pagué','comprobante','vencimiento','socio','saldo'])){
    intent='cuotas_pagos'; confidence=.93; setSession(s,'idle',{}); setTopic(s,'cuota',{}); setMenuContext(s,'payments');
    reply = responsePaymentsMenu();
    return finish();
  }

  if(containsAny(text,['alias','medio de pago','medios de pago','transferencia','mercado pago','como pago','cómo pago'])){
    intent='medios_pago'; confidence=.94; setTopic(s,'pagos',{});
    reply = `Podés pagar por transferencia 💳

Alias:
${data.club.paymentAlias || 'allboyseslapampa'}

Después de pagar, enviá el comprobante al WhatsApp del club:
${data.club.whatsapp || '2954592313'}

Así administración puede revisarlo e imputarlo.

Para evitar información desactualizada, administración confirmará los datos correspondientes.`;
    return finish();
  }

  if(text==='d' || containsAny(text,['natatorio','pileta','piscina','natacion','natación','nadar','clases de natacion','clases de natación','aquagym'])){
    intent='natatorio'; confidence=.96; setTopic(s,'natatorio',{}); setMenuContext(s,'natatorio');
    reply = responseNatatorioMenu(isMinorQuery(text));
    return finish();
  }

  if(currentTopic(s)==='natatorio' && containsAny(text,['hijo','hija','menor','nene','nena','niño','niña','chicos','infantil','edad'])){
    intent='natatorio_menor'; confidence=.93;
    setMenuContext(s,'natatorio');
    reply = responseNatatorioMenu(true);
    return finish();
  }

  if(text==='a' || containsAny(text,['actividades','actividad','horarios','dias','días','clases','deportes','futbol','fútbol','basquet','básquet','gimnasia','softbol','sóftbol','pelota paleta','paleta'])){
    intent='actividades'; confidence=.92; setTopic(s,'actividades',{}); s.data.priceFlow=false; s.data.priceMode=''; setMenuContext(s,'activities');
    reply = responseActivityMenu();
    return finish();
  }

  if(text==='b' || containsAny(text,['precio','precios','valor','valores','inscripcion','inscripción','inscribirme','anotarme','anotar','quiero empezar','quiero asociarme','cuanto sale','cuánto sale'])){
    intent='precios_inscripcion'; confidence=.9; setTopic(s,'inscripcion',{}); setMenuContext(s,'prices');
    addPending(data, phone, rawText, 'inscripcion', 'Consulta de precio/inscripción');
    reply = `Te ayudo con precios e inscripción 📝

Para brindarte información correcta, elegí qué tipo de consulta querés realizar.

A. Precio de una actividad
B. Cómo inscribirme a una actividad
C. Cómo asociarme al club
D. Inscripción para un menor
E. Hablar con administración
F. Volver al menú principal

`;
    return finish();
  }

  if(text==='e' || containsAny(text,['reclamo','queja','problema','sugerencia','inconveniente','mala atencion','mala atención','quiero reclamar','quiero sugerir'])){
    intent='reclamo_sugerencia'; confidence=.9;
    setSession(s,'idle',{ claimDraft: {} });
    setMenuContext(s,'claim_name');
    s.data.claimDraft = {};
    reply = responseClaimMenu();
    return finish();
  }

  if(containsAny(text,['urgencia','emergencia','accidente','lesion','lesión','lastimado','peligro','ambulancia','medico','médico','seguridad','me cai','me caí','se cayó','golpe'])){
    intent='urgencia'; confidence=.95;
    addPending(data, phone, rawText, 'urgencia', 'Situación sensible/urgente');
    reply = `Si es una urgencia o una situación que necesita atención inmediata, por favor acercate al personal del club o comunicate con emergencias.

Este WhatsApp puede no ser atendido al instante.

También dejo tu mensaje marcado para administración.

Las urgencias necesitan atención inmediata de una persona responsable.`;
    return finish();
  }

  if(text==='f' || containsAny(text,['prensa','periodista','entrevista','acreditacion','acreditación','cv','curriculum','currículum','trabajo','profesor','entrenador','proyecto','propuesta','proveedor','sponsor','auspicio','publicidad','convenio','estudiante','investigacion','investigación'])){
    intent='institucional'; confidence=.9;
    addPending(data, phone, rawText, 'institucional', 'Prensa/CV/proveedor/propuesta');
    setMenuContext(s,'institutional');
    reply = responseInstitutionalMenu();
    return finish();
  }

  if(text==='g' || containsAny(text,['predio','ruta 35','aeropuerto'])){
    intent='predio'; confidence=.94; setMenuContext(s,'predio'); reply=responsePredio(); return finish();
  }

  if(text==='h' || containsAny(text,['otra consulta','otra','no se','no sé','no aparece','ninguna opcion','ninguna opción','consulta'])){
    intent='otra_consulta'; confidence=.75;
    addPending(data, phone, rawText, 'otra', 'Otra consulta');
    setMenuContext(s,'other');
    reply = `No hay problema 😊
${topicVibe('other')}

Contame brevemente qué necesitás y trato de orientarte.

A. Volver al menú principal
B. Hablar con administración

Quedo atento a tu consulta.`;
    return finish();
  }

  // V63 - IA controlada: si ninguna regla/menú entendió, probamos IA antes del fallback común.
  // Esto NO reemplaza los menús: solo entra cuando el flujo llegó hasta acá.
  const aiReply = await responderConIAControlada(rawText, data, s);
  if(aiReply){
    intent='ia_controlada'; confidence=.70;
    reply = aiReply;
    return finish();
  }

  // Fallback inteligente
  intent='no_entendido'; confidence=.42;
  addPending(data, phone, rawText, 'no_entendido', 'No se entendió la consulta');

  // Si no entendió y va a mostrar el menú principal, limpiamos el flujo anterior.
  // Ejemplo: estaba esperando "Categoría 2017", el usuario escribe un nombre,
  // Panchito muestra menú principal; la próxima "A" debe ser Actividades, no Categoría 2017.
  resetToMainContext(s);

  const fixedText = correctionHint(rawText);
  if(fixedText && fixedText !== rawClean){
    reply = `Creo que quisiste decir: "${fixedText}" 😊

Podés escribirme de nuevo con esa palabra o elegir una opción:

A. Actividades, días y horarios 🏀⚽🤸🏊
B. Precios e inscripción 📝
C. Cuotas y pagos 💳
D. Hablar con Administración 📞
E. Reclamos o sugerencias 💬
F. Prensa, CV, proveedores o propuestas 📩
G. Predio 📍
H. Otra consulta 🔎`;
  } else {
    reply = `😊 Perdón, no entendí esa consulta.

Elegí una de las opciones del menú o escribime qué necesitás e intentaré ayudarte.

A. Actividades, días y horarios 🏀⚽🤸🏊
B. Precios e inscripción 📝
C. Cuotas y pagos 💳
D. Hablar con Administración 📞
E. Reclamos o sugerencias 💬
F. Prensa, CV, proveedores o propuestas 📩
G. Predio 📍
H. Otra consulta 🔎`;
  }
  return finish();
}

app.get('/api/state', (req,res)=>{
  const data = db();
  const total = data.members?.length || 0;
  const active = data.members.filter(m=>m.status==='Activo').length;
  const debtors = data.members.filter(m=>m.debt>0).length;
  const debt = data.members.reduce((s,m)=>s+(Number(m.debt)||0),0);
  const month = new Date().toISOString().slice(0,7);
  const todayChats = (data.conversations||[]).filter(c=>c.createdAt?.slice(0,10)===today()).length;
  const monthlyRevenue = (data.payments||[]).filter(p=>String(p.date||'').slice(0,7)===month).reduce((s,p)=>s+Number(p.amount||0),0);
  data.registrations = data.registrations || [];
  const registrationsPending = data.registrations.filter(r=>(r.status||'Pendiente')==='Pendiente').length;
  const pendingList = (data.pendingQueries||[]).filter(p=>!String(`${p.priority||''} ${p.category||''} ${p.topic||''} ${p.note||''}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes('inscripcion') && !p.registrationId);
  const claimsPending = pendingList.filter(p=>String(`${p.priority||''} ${p.category||''} ${p.topic||''}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes('reclamo') && (p.status||'Pendiente')==='Pendiente').length;
  res.json({ ...data, stats:{ total, active, debtors, debt, activities:(data.activities||[]).length, todayChats, monthlyRevenue, payments:data.payments?.length||0, documents:data.documents?.length||0, pending:pendingList.filter(p=>p.status==='Pendiente').length, claimsPending, registrations:data.registrations.length, registrationsPending, surveys:(data.surveys||[]).length, satisfactionAvg: (data.surveys||[]).length ? Math.round((data.surveys||[]).reduce((a,b)=>a+Number(b.score||0),0)/(data.surveys||[]).length*10)/10 : 0 } });
});
app.post('/api/bot', async (req,res)=>{ try { res.json(await smartReply(req.body.text || '', req.body.from || 'demo')); } catch(e){ console.error(e); res.status(500).json({ reply:'Perdón, tuve un inconveniente para procesar la consulta. Probá escribir MENÚ o consultá con administración.' }); } });
app.post('/api/reset-demo-session', (req,res)=>{ const data=db(); const phone=String(req.body?.from || '5492954000000'); data.sessions=(data.sessions||[]).filter(s=>String(s.phone)!==phone); save(data); res.json({ok:true}); });

app.post('/api/members', (req,res)=>{ const data=db(); const m={id:Date.now(),password:'1234',activities:[],status:'Activo',...req.body}; data.members.unshift(m); save(data); res.json(m); });
app.put('/api/members/:id', (req,res)=>{ const data=db(); const id=Number(req.params.id); data.members=data.members.map(m=>m.id===id?{...m,...req.body}:m); save(data); res.json({ok:true}); });
app.delete('/api/members/:id', (req,res)=>{ const data=db(); data.members=data.members.filter(m=>m.id!==Number(req.params.id)); save(data); res.json({ok:true}); });

app.post('/api/payments', (req,res)=>{ const data=db(); data.payments=data.payments||[]; const member=data.members.find(m=>m.id===Number(req.body.memberId)); const amount=Number(req.body.amount||0); const p={id:Date.now(),memberId:member?.id||null,memberName:member?.name||req.body.memberName||'',amount,method:req.body.method||'Efectivo',period:req.body.period||'',date:req.body.date||today(),note:req.body.note||''}; data.payments.unshift(p); if(member){ member.debt=Math.max(0, Number(member.debt||0)-amount); member.feeStatus=member.debt>0?'Pendiente':'Al día'; member.lastPayment=p.date; } save(data); res.json(p); });
app.delete('/api/payments/:id', (req,res)=>{ const data=db(); data.payments=(data.payments||[]).filter(p=>p.id!==Number(req.params.id)); save(data); res.json({ok:true}); });


app.post('/api/activities', (req,res)=>{
  const data=db();
  data.activities=data.activities||[];
  const item={
    id:Date.now(),
    name:req.body.name||'',
    category:req.body.category||'',
    days:req.body.days||'',
    time:req.body.time||'',
    cost:Number(req.body.cost||0),
    teacher:req.body.teacher||'',
    contact:req.body.contact||'Administración',
    active:req.body.active!==false,
    slots:Number(req.body.slots||0),
    used:Number(req.body.used||0),
    notes:req.body.notes||''
  };
  data.activities.unshift(item);
  save(data);
  res.json(item);
});
app.put('/api/activities/:id', (req,res)=>{
  const data=db();
  const id=Number(req.params.id);
  data.activities=(data.activities||[]).map(a=>a.id===id?{...a,...req.body,id,cost:Number(req.body.cost??a.cost??0),slots:Number(req.body.slots??a.slots??0),used:Number(req.body.used??a.used??0),active:req.body.active!==undefined?req.body.active:a.active}:a);
  save(data);
  res.json({ok:true});
});
app.delete('/api/activities/:id', (req,res)=>{
  const data=db();
  data.activities=(data.activities||[]).filter(a=>a.id!==Number(req.params.id));
  save(data);
  res.json({ok:true});
});

app.post('/api/knowledge', (req,res)=>{ const data=db(); const item={id:Date.now(),...req.body}; data.knowledge.unshift(item); save(data); res.json(item); });
app.delete('/api/knowledge/:id', (req,res)=>{ const data=db(); data.knowledge=data.knowledge.filter(k=>k.id!==Number(req.params.id)); save(data); res.json({ok:true}); });
app.post('/api/documents', (req,res)=>{ const data=db(); data.documents=data.documents||[]; const item={id:Date.now(),title:req.body.title||'Documento',type:'texto',content:req.body.content||'',createdAt:new Date().toISOString()}; data.documents.unshift(item); save(data); res.json(item); });
app.delete('/api/documents/:id', (req,res)=>{ const data=db(); data.documents=(data.documents||[]).filter(d=>d.id!==Number(req.params.id)); save(data); res.json({ok:true}); });


function arrifyActivities(v){ return String(v||'').split(/[|;]/).map(x=>x.trim()).filter(Boolean); }
function boolActive(v){ const t=clean(v||'SI'); return !['no','false','0','inactiva','inactivo'].includes(t); }
app.post('/api/import/members', (req,res)=>{
  const data=db(); data.members=data.members||[];
  const items=Array.isArray(req.body.items)?req.body.items:[];
  let added=0, updated=0, skipped=0;
  for(const it of items){
    const dni=String(it.dni||it.DNI||'').trim();
    const name=String(it.name||it.nombre||it.Nombre||'').trim();
    if(!dni || !name){ skipped++; continue; }
    let m=data.members.find(x=>String(x.dni||'')===dni || (it.memberNo && String(x.memberNo||'')===String(it.memberNo)));
    const patch={
      dni,
      memberNo:String(it.memberNo||it.socio||it.numeroSocio||it['número socio']||'').trim(),
      name,
      phone:String(it.phone||it.telefono||it.teléfono||'').trim(),
      email:String(it.email||'').trim(),
      status:String(it.status||'Activo').trim()||'Activo',
      feeStatus:String(it.feeStatus||it.cuota||'Pendiente').trim()||'Pendiente',
      debt:Number(String(it.debt||it.deuda||0).replace(/\./g,'').replace(',','.'))||0,
      activities:arrifyActivities(it.activities||it.actividades),
      password:'1234'
    };
    patch.feeStatus = patch.debt>0 ? (patch.feeStatus==='Al día'?'Pendiente':patch.feeStatus) : (patch.feeStatus||'Al día');
    if(m){ Object.assign(m, patch); updated++; }
    else{ data.members.unshift({id:Date.now()+added+updated, nextDue:'10/07/2026', lastPayment:'', ...patch}); added++; }
  }
  save(data); res.json({ok:true,added,updated,skipped});
});
app.post('/api/import/activities', (req,res)=>{
  const data=db(); data.activities=data.activities||[];
  const items=Array.isArray(req.body.items)?req.body.items:[];
  let added=0, updated=0, skipped=0;
  for(const it of items){
    const name=String(it.name||it.nombre||it.actividad||'').trim();
    const category=String(it.category||it.categoria||it.categoría||'').trim();
    if(!name){ skipped++; continue; }
    let a=data.activities.find(x=>clean(x.name||'')===clean(name) && clean(x.category||'')===clean(category));
    const patch={
      name, category,
      days:String(it.days||it.dias||it.días||'').trim(),
      time:String(it.time||it.horario||'').trim(),
      cost:Number(String(it.cost||it.precio||it.cuota||0).replace(/\./g,'').replace(',','.'))||0,
      teacher:String(it.teacher||it.profesor||it.profe||'').trim(),
      contact:String(it.contact||it.contacto||'Administración').trim()||'Administración',
      active:boolActive(it.active||it.activa),
      slots:Number(it.slots||it.cupo||0)||0,
      notes:String(it.notes||it.notas||it.requisitos||'').trim()
    };
    if(a){ Object.assign(a, patch); updated++; }
    else{ data.activities.unshift({id:Date.now()+added+updated, used:0, ...patch}); added++; }
  }
  save(data); res.json({ok:true,added,updated,skipped});
});


app.get('/api/registrations',requireAdminApi,requireRole('admin','secretaria'),(req,res)=>{ const data=db(); res.json(data.registrations||[]); });
app.put('/api/registrations/:id',requireAdminApi,requireRole('admin','secretaria'),(req,res)=>{
  const data=db();
  const id=Number(req.params.id);
  data.registrations=(data.registrations||[]).map(r=>r.id===id?{...r,...req.body,id,status:registrationStatusLabel(req.body.status||r.status),updatedAt:new Date().toISOString()}:r);
  save(data);
  res.json({ok:true});
});
app.delete('/api/registrations/:id',requireAdminApi,requireRole('admin','secretaria'),(req,res)=>{
  const data=db();
  data.registrations=(data.registrations||[]).filter(r=>r.id!==Number(req.params.id));
  save(data);
  res.json({ok:true});
});
app.get('/api/pending',requireAdminApi,requireRole('admin','secretaria'),(req,res)=>{ const data=db(); res.json(data.pendingQueries||[]); });
app.put('/api/pending/:id',requireAdminApi,requireRole('admin','secretaria'),(req,res)=>{ const data=db(); const id=Number(req.params.id); data.pendingQueries=(data.pendingQueries||[]).map(p=>p.id===id?{...p,...req.body,id,updatedAt:new Date().toISOString()}:p); save(data); res.json({ok:true}); });
app.delete('/api/pending/:id',requireAdminApi,requireRole('admin','secretaria'),(req,res)=>{ const data=db(); data.pendingQueries=(data.pendingQueries||[]).filter(p=>p.id!==Number(req.params.id)); save(data); res.json({ok:true}); });

// V104 - Inicio/cierre de sesión antes de proteger el resto de las rutas administrativas.
app.post('/api/admin/login',(req,res)=>{
  const username=String(req.body?.username||'').trim();
  const password=String(req.body?.password||'');
  const user=ADMIN_USERS.find(u=>safeEqual(username,u.username));
  if(!user || !safeEqual(password,user.password)){
    return res.status(401).json({ok:false,error:'Usuario o contraseña incorrectos'});
  }
  setAdminCookie(res,createAdminToken(user));
  res.json({ok:true,user:user.username,displayName:user.displayName,role:user.role,scopes:user.scopes});
});
app.post('/api/admin/logout',(req,res)=>{ clearAdminCookie(res); res.json({ok:true}); });
app.get('/api/admin/me',requireAdminApi,(req,res)=>res.json({ok:true,user:req.admin.u,displayName:req.admin.n,role:req.admin.r,scopes:req.admin.s,expiresAt:req.admin.exp}));
// Todas las demás rutas de bandeja y métricas requieren sesión.
app.use(['/api/handoffs','/api/admin'], requireAdminApi);

// V93 - Bandeja/controles básicos para atención humana.
app.get('/api/handoffs',(req,res)=>{
  const data=db();
  const pendingById=new Map((data.pendingQueries||[]).map(p=>[String(p.id),p]));
  const items=(data.sessions||[])
    .filter(isHumanMode)
    .map(s=>{
      const pending=pendingById.get(String(s.data?.handoffId||''))||{};
      const recent=(data.conversations||[]).filter(c=>c.phone===s.phone).slice(0,10);
      return {
        phone:s.phone, mode:'human', handoffAt:s.data?.handoffAt||s.updatedAt,
        reason:s.data?.handoffReason||'Administración', handoffId:s.data?.handoffId||null,
        name:pending.name||'', contactPhone:pending.contactPhone||'', topic:pending.topic||'',
        message:pending.message||'', priority:pending.priority||'🟡 Consulta', recentMessages:recent,
        updatedAt:s.updatedAt
      };
    });
  res.json(items.filter(item=>adminCanAccessItem(req.admin,item)));
});
app.get('/api/handoffs/history',(req,res)=>{
  const data=db();
  const history=data.handoffHistory||[];
  if(adminCanSeeAll(req.admin)) return res.json(history);
  const pendingById=new Map((data.pendingQueries||[]).map(p=>[String(p.id),p]));
  res.json(history.filter(h=>adminCanAccessItem(req.admin,{...h,...(pendingById.get(String(h.handoffId||''))||{})})));
});

app.get('/api/admin/dashboard',(req,res)=>{
  const data=db();
  const now=Date.now();
  const dayKey=new Date().toISOString().slice(0,10);
  const weekStart=now-(6*24*60*60*1000);
  const conversations=data.conversations||[];
  const history=data.handoffHistory||[];
  const pending=data.pendingQueries||[];
  const sessions=data.sessions||[];
  const scopedPending=adminCanSeeAll(req.admin)?pending:pending.filter(p=>adminCanAccessItem(req.admin,p));
  const allowedPhones=new Set(scopedPending.map(p=>phoneDigits(p.phone||p.contactPhone||'')));
  const scopedConversations=adminCanSeeAll(req.admin)?conversations:conversations.filter(c=>allowedPhones.has(phoneDigits(c.phone||'')) || adminCanAccessItem(req.admin,c));
  const scopedHistory=adminCanSeeAll(req.admin)?history:history.filter(h=>allowedPhones.has(phoneDigits(h.phone||'')) || adminCanAccessItem(req.admin,h));

  const humanSessions=sessions.filter(isHumanMode).filter(s=>adminCanSeeAll(req.admin)||allowedPhones.has(phoneDigits(s.phone||'')));
  const activeBotSessions=sessions.filter(s=>!isHumanMode(s) && s.updatedAt && (now-Date.parse(s.updatedAt))<=15*60*1000).filter(s=>adminCanSeeAll(req.admin)||allowedPhones.has(phoneDigits(s.phone||''))||adminCanAccessItem(req.admin,{topic:s.data?.currentActivity||s.data?.topic||'',reason:s.data?.handoffReason||''}));
  const todayConversations=scopedConversations.filter(c=>(c.createdAt||'').slice(0,10)===dayKey);
  const todayDerived=scopedHistory.filter(h=>(h.at||'').slice(0,10)===dayKey && h.action==='derived');
  const claimsToday=scopedPending.filter(p=>(p.createdAt||'').slice(0,10)===dayKey && clean(`${p.category||''} ${p.topic||''} ${p.priority||''}`).includes('reclamo'));

  const waitSamples=[];
  const derivedByPhone={};
  for(const h of [...scopedHistory].reverse()){
    const key=phoneDigits(h.phone||'');
    if(!key) continue;
    if(h.action==='derived') derivedByPhone[key]=Date.parse(h.at||'');
    if(['taken','closed','returned_to_bot'].includes(h.action) && derivedByPhone[key]){
      const end=Date.parse(h.at||'');
      if(Number.isFinite(end) && end>=derivedByPhone[key]) waitSamples.push(end-derivedByPhone[key]);
      delete derivedByPhone[key];
    }
  }
  const avgWaitMinutes=waitSamples.length?Math.round(waitSamples.reduce((a,b)=>a+b,0)/waitSamples.length/60000):0;

  const topicCounts={};
  for(const c of scopedConversations.filter(c=>Date.parse(c.createdAt||0)>=weekStart)){
    const topic=String(c.topic||c.intent||'Otra consulta').trim()||'Otra consulta';
    topicCounts[topic]=(topicCounts[topic]||0)+1;
  }
  const topTopics=Object.entries(topicCounts).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([name,count])=>({name,count}));

  const daily=[];
  for(let i=6;i>=0;i--){
    const d=new Date(now-i*86400000).toISOString().slice(0,10);
    daily.push({
      date:d,
      conversations:scopedConversations.filter(c=>(c.createdAt||'').slice(0,10)===d).length,
      handoffs:scopedHistory.filter(h=>(h.at||'').slice(0,10)===d && h.action==='derived').length,
      claims:scopedPending.filter(p=>(p.createdAt||'').slice(0,10)===d && clean(`${p.category||''} ${p.topic||''} ${p.priority||''}`).includes('reclamo')).length
    });
  }

  const resolvedByBot=Math.max(0,todayConversations.length-todayDerived.length);
  const botResolutionRate=todayConversations.length?Math.round(resolvedByBot/todayConversations.length*100):0;
  const c=digitalClubConfig();
  res.json({
    generatedAt:new Date().toISOString(),
    metrics:{
      activeNow:activeBotSessions.length,
      waitingHuman:humanSessions.length,
      conversationsToday:todayConversations.length,
      handoffsToday:todayDerived.length,
      claimsToday:claimsToday.length,
      avgWaitMinutes,
      botResolutionRate,
      registrationsPending:(adminCanSeeAll(req.admin)?(data.registrations||[]):(data.registrations||[]).filter(r=>adminCanAccessItem(req.admin,r))).filter(r=>(r.status||'Pendiente')==='Pendiente').length
    },
    topTopics,
    daily,
    digitalClub:{ready:digitalClubReady(),baseUrl:c.baseUrl||'',checkedAt:new Date().toISOString()},
    recent:scopedHistory.slice(0,30),
    user:{displayName:req.admin.n,role:req.admin.r,scopes:req.admin.s}
  });
});


function findHandoffItem(data,requestedPhone){
  const s=findSessionByPhone(data,requestedPhone);
  if(!s) return {session:null,item:null};
  const pending=(data.pendingQueries||[]).find(p=>String(p.id)===String(s.data?.handoffId||''))||{};
  return {session:s,item:{phone:s.phone,reason:s.data?.handoffReason||'',topic:pending.topic||'',message:pending.message||'',name:pending.name||''}};
}
function denyIfNoHandoffAccess(req,res,data,requestedPhone){
  const found=findHandoffItem(data,requestedPhone);
  if(found.item && !adminCanAccessItem(req.admin,found.item)){ res.status(403).json({ok:false,error:'No tenés permiso para atender esta conversación'}); return true; }
  return false;
}

app.post('/api/handoffs/:phone/human',(req,res)=>{
  const data=db(); data.sessions=data.sessions||[];
  const requestedPhone=String(req.params.phone);
  if(denyIfNoHandoffAccess(req,res,data,requestedPhone)) return;
  const s=findSessionByPhone(data,requestedPhone) || getSession(data,requestedPhone);
  setAttentionMode(s,'human',{handoffAt:new Date().toISOString(),handoffReason:req.body?.reason||'Tomado manualmente por Administración'});
  addHandoffHistory(data,s,'taken',{operator:req.body?.operator||'Administración'});
  save(data); res.json({ok:true,phone:s.phone,mode:'human'});
});
app.post('/api/handoffs/:phone/bot',(req,res)=>{
  const data=db(); data.sessions=data.sessions||[];
  const requestedPhone=String(req.params.phone);
  if(denyIfNoHandoffAccess(req,res,data,requestedPhone)) return;
  const previous=findSessionByPhone(data,requestedPhone) || getSession(data,requestedPhone);
  addHandoffHistory(data,previous,'returned_to_bot',{operator:req.body?.operator||'Administración'});
  const s=reactivateAllSessionsForPhone(data,requestedPhone);
  save(data); res.json({ok:true,phone:s.phone,mode:'bot',message:botReturnedMessage()});
});
app.post('/api/handoffs/:phone/close', async (req,res)=>{
  try{
    const adminKey=process.env.ADMIN_API_KEY;
    if(adminKey && req.get('x-admin-key')!==adminKey) return res.status(401).json({ok:false,error:'No autorizado'});
    const data=db(); data.sessions=data.sessions||[];
    const requestedPhone=String(req.params.phone);
    if(denyIfNoHandoffAccess(req,res,data,requestedPhone)) return;
    const previous=findSessionByPhone(data,requestedPhone) || getSession(data,requestedPhone);
    const phone=phoneDigits(previous.phone || requestedPhone);
    addHandoffHistory(data,previous,'closed',{operator:req.body?.operator||'Administración'});
    reactivateAllSessionsForPhone(data,requestedPhone); save(data);
    let notified=false;
    if(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID){
      await sendMetaText(phone,botReturnedMessage()); notified=true;
    }
    res.json({ok:true,phone,mode:'bot',notified,message:botReturnedMessage()});
  }catch(e){ res.status(500).json({ok:false,error:e?.message||'No se pudo cerrar la atención'}); }
});

app.post('/api/member-login',(req,res)=>{ const data=db(); const member=data.members.find(m=>m.dni===String(req.body.dni||'') && String(m.password||'1234')===String(req.body.password||'')); if(!member) return res.status(401).json({error:'Datos incorrectos'}); const payments=(data.payments||[]).filter(p=>p.memberId===member.id); res.json({member,payments,club:data.club}); });


// TWILIO WHATSAPP SANDBOX
// Configurar en Twilio > WhatsApp Sandbox > "When a message comes in":
// https://TU_URL_PUBLICA/whatsapp
function escapeXml(value=''){
  return String(value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}
function normalizeTwilioPhone(from=''){
  return String(from || 'whatsapp:demo').replace(/^whatsapp:/i,'');
}
function chunkWhatsApp(text='', max=1450){
  const raw = String(text || '').trim() || 'Perdón, no pude generar una respuesta. Escribí MENÚ para empezar de nuevo.';
  if(raw.length <= max) return [raw];
  const out=[];
  let rest=raw;
  while(rest.length > max){
    let cut = rest.lastIndexOf('\n', max);
    if(cut < 500) cut = rest.lastIndexOf(' ', max);
    if(cut < 500) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if(rest) out.push(rest);
  return out.slice(0, 4);
}

function twilioXml(text=''){
  const messages = chunkWhatsApp(text);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${messages.map(m=>`<Message>${escapeXml(m)}</Message>`).join('')}</Response>`;
}

function twilioSilentXml(){
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

function logTwilioDiagnostic(route, incomingText, from, result, replyText, xml){
  console.log('=================================');
  console.log(`📍 Ruta: ${route}`);
  console.log('📩 Mensaje recibido:');
  console.log(incomingText || '(vacío)');
  console.log('📱 Desde:');
  console.log(from || '(sin número)');
  console.log('🤖 Respuesta generada:');
  console.log(replyText || '(respuesta vacía)');
  console.log('🧠 Intent:');
  console.log(result?.intent || '(sin intent)');
  console.log('📏 Caracteres:');
  console.log(String(replyText || '').length);
  console.log('📦 XML Twilio generado:');
  console.log(xml);
  console.log('=================================');
}
function logFullTwilioError(route, e){
  console.error('=================================');
  console.error(`❌ ERROR COMPLETO EN ${route}`);
  console.error(e?.stack || e);
  if(e?.response?.data){
    console.error('Respuesta del servicio externo:');
    console.error(e.response.data);
  }
  if(e?.message){
    console.error('Mensaje de error:');
    console.error(e.message);
  }
  console.error('=================================');
}
function quickTwilioReply(rawText='', alreadyMet=false){
  // Respuesta rápida Twilio: menú natural, sin presentarse de nuevo si ya venía hablando.
  const t = clean(rawText).replace(/[!¡?¿.,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(!t) return panchitoMenu(alreadyMet ? 'volver' : 'inicio');
  const menuWords = ['menu','menú','inicio','empezar','arrancar','opciones','opcion','opción','0'];
  if(menuWords.includes(t)) return panchitoMenu('volver');
  if(isGreetingText(t)) return panchitoMenu(alreadyMet ? 'volver' : 'inicio');
  if(['hola','holaa','buenas','buen dia','buen día','buenos dias','buenos días','buenas tardes','buenas noches'].includes(t)) return panchitoMenu(alreadyMet ? 'volver' : 'inicio');
  return '';
}
async function smartReplySafe(rawText, from){
  let alreadyMetPanchitoFast = false;
  try{
    const dataFast = db();
    const phoneFast = normalizeTwilioPhone(from);
    let sessionFast = findSessionByPhone(dataFast, phoneFast);
    // V100: una atención humana también vence por inactividad. Así, al día siguiente
    // un saludo inicia una conversación nueva en vez de dejar el número bloqueado.
    if(sessionFast && sessionExpired(sessionFast)){
      resetForNewConversation(sessionFast);
      save(dataFast);
    }
    if(isHumanMode(sessionFast)){
      // Control de prueba/administración. PIN configurable con ADMIN_CONTROL_PIN.
      if(isAdminControlCommand(rawText,'bot') || isAdminControlCommand(rawText,'cerrar')){
        addHandoffHistory(dataFast,sessionFast,'returned_to_bot_command',{channel:'whatsapp'});
        reactivateAllSessionsForPhone(dataFast,phoneFast);
        save(dataFast);
        return {reply:botReturnedMessage(),silent:false,intent:'admin_reactiva_bot',confidence:1};
      }
      dataFast.conversations = dataFast.conversations || [];
      dataFast.conversations.unshift({
        id:Date.now(), phone:phoneFast, text:rawText, reply:'', intent:'modo_humano_sin_respuesta',
        confidence:1, sessionState:sessionFast.state, topic:sessionFast.data?.handoffReason || 'administracion',
        createdAt:new Date().toISOString()
      });
      dataFast.conversations = dataFast.conversations.slice(0,500);
      save(dataFast);
      return { reply:'', silent:true, intent:'modo_humano', confidence:1 };
    }
    if(isAdminControlCommand(rawText,'tomar')){
      setAttentionMode(sessionFast,'human',{handoffAt:new Date().toISOString(),handoffReason:'Tomado con comando administrativo'});
      addHandoffHistory(dataFast,sessionFast,'taken_command',{channel:'whatsapp'});
      save(dataFast);
      return {reply:'✅ Conversación puesta en modo humano. Panchito queda pausado.',silent:false,intent:'admin_toma_chat',confidence:1};
    }
    alreadyMetPanchitoFast = !!sessionFast?.data?.seenPanchitoIntro;
  }catch(e){ console.error('No se pudo comprobar modo humano:', e); }
  const quick = quickTwilioReply(rawText, alreadyMetPanchitoFast);
  if(quick){
    // Guardamos que el usuario está en menú principal aunque haya entrado por la respuesta rápida.
    // Así, si después responde A, B, C, etc., no se mezcla con un submenú anterior.
    try{
      const data = db();
      data.sessions = data.sessions || [];
      const s = getSession(data, normalizeTwilioPhone(from));
      s.state = 'idle';
      s.data = { ...(s.data||{}), menu:'main', topic:'', currentActivity:'', currentCategory:'', disciplineDetail:null, seenPanchitoIntro:true };
      s.updatedAt = new Date().toISOString();
      save(data);
    }catch(e){ console.error('No se pudo guardar contexto de menú principal:', e); }
    return { reply: quick, intent: 'twilio_rapido', confidence: .99 };
  }
  const timeout = new Promise(resolve => setTimeout(() => resolve({
    reply: 'Perdón, Panchito tardó más de lo esperado. Escribí MENÚ para empezar de nuevo o probá otra vez en unos segundos.',
    intent: 'timeout_seguro', confidence: .1
  }), 7000));
  return Promise.race([smartReply(rawText, from), timeout]);
}
app.get('/whatsapp', (req,res)=>{
  res.type('text/plain').send('Panchito WhatsApp OK. Configurá Twilio con POST a esta misma URL.');
});
app.post('/whatsapp', async (req,res)=>{
  try{
    const incomingText = req.body?.Body || req.body?.body || '';
    const from = normalizeTwilioPhone(req.body?.From || req.body?.WaId || 'whatsapp:demo');
    console.log('Twilio WhatsApp recibido:', { from, text: incomingText });
    const result = await smartReplySafe(incomingText, from);
    const replyText = result?.reply || result?.text || String(result || '');
    const xml = result?.silent ? twilioSilentXml() : twilioXml(replyText);
    logTwilioDiagnostic('/whatsapp', incomingText, from, result, replyText, xml);
    res.type('text/xml').send(xml);
  }catch(e){
    logFullTwilioError('/whatsapp', e);
    const fallback = 'Perdón, Panchito tuvo un inconveniente para responder. Escribí MENÚ o probá de nuevo en unos segundos.';
    res.type('text/xml').send(twilioXml(fallback));
  }
});

// WEBHOOK UNIFICADO: Twilio Sandbox + WhatsApp Business Platform (Meta Cloud API)
// Meta configura esta URL para verificación y recepción:
// https://TU_URL_PUBLICA/webhook
function isMetaWebhook(body={}){
  return body?.object === 'whatsapp_business_account' || Array.isArray(body?.entry);
}

function extractMetaMessages(body={}){
  const items=[];
  for(const entry of (body.entry||[])){
    for(const change of (entry.changes||[])){
      const value=change?.value||{};
      const metadata=value.metadata||{};
      for(const message of (value.messages||[])){
        let text='';
        if(message.type==='text') text=message.text?.body||'';
        else if(message.type==='button') text=message.button?.text||message.button?.payload||'';
        else if(message.type==='interactive'){
          text=message.interactive?.button_reply?.title
            || message.interactive?.button_reply?.id
            || message.interactive?.list_reply?.title
            || message.interactive?.list_reply?.id
            || '';
        }else if(message.type==='image') text=message.image?.caption||'[imagen]';
        else if(message.type==='document') text=message.document?.caption||'[documento]';
        else if(message.type==='audio') text='[audio]';
        else if(message.type==='location') text='[ubicación]';
        else text=`[${message.type||'mensaje'}]`;
        items.push({
          from:String(message.from||''),
          text:String(text||''),
          messageId:message.id||'',
          timestamp:message.timestamp||'',
          phoneNumberId:metadata.phone_number_id||process.env.WHATSAPP_PHONE_NUMBER_ID||'',
          displayPhoneNumber:metadata.display_phone_number||''
        });
      }
    }
  }
  return items;
}

async function sendMetaText(to, text, phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID){
  const token=process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion=process.env.WHATSAPP_API_VERSION || 'v23.0';
  if(!token) throw new Error('Falta WHATSAPP_ACCESS_TOKEN');
  if(!phoneNumberId) throw new Error('Falta WHATSAPP_PHONE_NUMBER_ID');
  const messages=chunkWhatsApp(text, 3900);
  const results=[];
  for(const body of messages){
    const r=await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:String(to).replace(/\D/g,''),type:'text',text:{preview_url:false,body}})
    });
    const json=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(`Meta WhatsApp ${r.status}: ${JSON.stringify(json).slice(0,800)}`);
    results.push(json);
  }
  return results;
}

async function processMetaIncoming(item){
  console.log('Meta WhatsApp recibido:', {from:item.from,text:item.text,messageId:item.messageId});
  const result=await smartReplySafe(item.text,item.from);
  const replyText=result?.reply || result?.text || String(result||'');
  if(!result?.silent && replyText){
    await sendMetaText(item.from,replyText,item.phoneNumberId);
  }
  return result;
}

app.get('/webhook',(req,res)=>{
  const verifyToken=process.env.WHATSAPP_VERIFY_TOKEN || 'clubbot-demo';
  const mode=req.query['hub.mode'];
  const token=req.query['hub.verify_token'];
  const challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===verifyToken) return res.status(200).send(challenge);
  if(token===verifyToken && challenge) return res.status(200).send(challenge);
  if(Object.keys(req.query||{}).length) return res.sendStatus(403);
  res.type('text/plain').send('Panchito webhook activo: Twilio + WhatsApp Business Platform.');
});

app.post('/webhook', async (req,res)=>{
  // Meta necesita recibir HTTP 200 rápidamente. Procesamos luego de confirmar recepción.
  if(isMetaWebhook(req.body)){
    const messages=extractMetaMessages(req.body);
    res.sendStatus(200);
    for(const item of messages){
      try{ await processMetaIncoming(item); }
      catch(e){ console.error('ERROR META WHATSAPP:',e?.stack||e); }
    }
    return;
  }

  // Compatibilidad con Twilio mientras se usa el entorno de prueba.
  try{
    const incomingText=req.body?.Body || req.body?.body || req.body?.message || '';
    const from=normalizeTwilioPhone(req.body?.From || req.body?.WaId || 'whatsapp:demo');
    console.log('Webhook Twilio recibido:',{from,text:incomingText});
    const result=await smartReplySafe(incomingText,from);
    const replyText=result?.reply || result?.text || String(result||'');
    const xml=result?.silent ? twilioSilentXml() : twilioXml(replyText);
    logTwilioDiagnostic('/webhook',incomingText,from,result,replyText,xml);
    res.type('text/xml').send(xml);
  }catch(e){
    logFullTwilioError('/webhook',e);
    res.type('text/xml').send(twilioXml('Perdón, Panchito tuvo un inconveniente para responder. Escribí MENÚ o probá de nuevo.'));
  }
});

// Envío manual/base para una futura bandeja de Administración.
// Requiere proteger esta ruta con ADMIN_API_KEY en producción.
app.post('/api/whatsapp/send', async (req,res)=>{
  try{
    const adminKey=process.env.ADMIN_API_KEY;
    if(adminKey && req.get('x-admin-key')!==adminKey) return res.status(401).json({ok:false,error:'No autorizado'});
    const to=String(req.body?.to||'').replace(/\D/g,'');
    const text=String(req.body?.text||'').trim();
    if(!to || !text) return res.status(400).json({ok:false,error:'Faltan to y text'});
    const result=await sendMetaText(to,text);
    res.json({ok:true,result});
  }catch(e){
    console.error('ERROR ENVÍO MANUAL META:',e?.stack||e);
    res.status(500).json({ok:false,error:e?.message||'No se pudo enviar'});
  }
});

app.get('/api/whatsapp/config-status',(req,res)=>{
  res.json({
    provider:'meta-cloud-api',
    ready:Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_VERIFY_TOKEN),
    verifyToken:Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    accessToken:Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId:Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
    apiVersion:process.env.WHATSAPP_API_VERSION || 'v23.0'
  });
});


app.post('/api/train/website', (req,res)=>{
  try{
    const data = db();
    const added = trainWebsite(data);
    save(data);
    res.json({ ok:true, added, message: added ? 'Base web incorporada a Documentos IA.' : 'La base web ya estaba cargada.' });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'No se pudo entrenar con la web.' });
  }
});

app.get('/api/train/website/preview', (req,res)=>{
  res.json({ ok:true, documents: allBoysWebsiteDocuments });
});


// V98 - Normalización de socios para identificar por DNI o número de socio.
function normalizeLocalMember(member){
  if(!member) return null;
  return {
    name:member.name || member.fullName || '',
    dni:String(member.dni||''),
    memberNo:String(member.memberNo || member.numeroSocio || member.id || ''),
    phone:member.phone || member.telefono || '',
    status:member.status || member.estado || 'Activo',
    feeStatus:member.feeStatus || member.estadoCuota || (Number(member.debt||0)>0?'Con deuda':'Al día'),
    debt:Number(member.debt||member.deuda||0),
    activities:Array.isArray(member.activities) ? member.activities.map(a=>typeof a==='string'?a:(a.name||a.nombre||a.activity||'')).filter(Boolean) : []
  };
}
function normalizeDigitalClubMember(payload){
  if(!payload) return null;
  if(payload.encontrado === false || payload.found === false) return null;
  const root = payload.socio || payload.member || payload.data?.socio || payload.data?.member || payload.data || payload;
  if(!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const cuota = root.cuota || root.fee || {};
  const rawActivities = root.actividades || root.activities || root.deportes || [];
  const activities = Array.isArray(rawActivities) ? rawActivities.map(a=>typeof a==='string'?a:(a.nombre||a.name||a.actividad||a.activity||a.categoria||'')).filter(Boolean) : [];
  const name = root.nombreCompleto || root.nombre_apellido || root.name || [root.nombre,root.apellido].filter(Boolean).join(' ');
  if(!name && !root.dni && !root.numeroSocio && !root.memberNo) return null;
  return {
    name:name || '',
    dni:String(root.dni || root.documento || ''),
    memberNo:String(root.numeroSocio || root.numero_socio || root.memberNo || root.idSocio || ''),
    phone:root.telefono || root.phone || root.celular || '',
    status:root.estado || root.status || (root.activo===false?'Inactivo':'Activo'),
    feeStatus:cuota.estado || root.estadoCuota || root.feeStatus || (Number(cuota.importeAdeudado||root.deuda||0)>0?'Con deuda':'Al día'),
    debt:Number(cuota.importeAdeudado || cuota.deuda || root.deuda || root.debt || 0),
    activities
  };
}

// V97 - Base de integración de solo lectura con DigitalClub.
function digitalClubConfig(){
  return {
    baseUrl:String(process.env.DIGITALCLUB_API_URL||'').replace(/\/$/,''),
    apiKey:String(process.env.DIGITALCLUB_API_KEY||''),
    memberPath:String(process.env.DIGITALCLUB_MEMBER_PATH||'/socios'),
    authHeader:String(process.env.DIGITALCLUB_AUTH_HEADER||'Authorization'),
    authPrefix:String(process.env.DIGITALCLUB_AUTH_PREFIX||'Bearer')
  };
}
function digitalClubReady(){ const c=digitalClubConfig(); return Boolean(c.baseUrl && c.apiKey); }
async function digitalClubFindMember(value){
  const c=digitalClubConfig();
  if(!digitalClubReady()) throw new Error('DigitalClub todavía no está configurado');
  const url=new URL(c.baseUrl+c.memberPath);
  const raw=String(value||'').trim();
  if(/^\d{7,8}$/.test(raw)) url.searchParams.set('dni',raw);
  else url.searchParams.set('numeroSocio',raw);
  const headers={Accept:'application/json'};
  headers[c.authHeader]=`${c.authPrefix} ${c.apiKey}`.trim();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),7000);
  try{
    const r=await fetch(url,{headers,signal:controller.signal});
    const body=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(`DigitalClub respondió ${r.status}`);
    return body;
  } finally { clearTimeout(timer); }
}
app.get('/api/integrations/digitalclub/status',(req,res)=>{
  const c=digitalClubConfig();
  res.json({ready:digitalClubReady(),baseUrl:c.baseUrl||null,memberPath:c.memberPath,hasApiKey:Boolean(c.apiKey)});
});
app.post('/api/integrations/digitalclub/member-test',async(req,res)=>{
  try{ res.json({ok:true,data:await digitalClubFindMember(req.body?.value)}); }
  catch(e){ res.status(400).json({ok:false,error:e?.message||'No se pudo consultar DigitalClub'}); }
});

app.get('/admin/login',(req,res)=>{
  if(readAdminSession(req)) return res.redirect('/admin');
  res.sendFile(path.join(__dirname,'public','admin-login.html'));
});
app.get('/admin',requireAdminPage,(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

app.get('/health',(req,res)=>res.send('ClubBot IA Enterprise activo ✅'));
app.listen(PORT,()=>{
  console.log(`ClubBot IA Enterprise en http://localhost:${PORT}`);
  console.log('Panchito V100 activo - retorno bot y nuevas conversaciones corregidos');
});
