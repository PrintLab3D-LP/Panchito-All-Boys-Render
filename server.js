require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');

app.use(cors());
app.use(express.json({ limit: '15mb' }));
// Twilio WhatsApp envía los mensajes como application/x-www-form-urlencoded.
// Esta línea permite leer req.body.Body, req.body.From, etc.
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function db(){ return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); }
function save(data){ fs.writeFileSync(DB_PATH, JSON.stringify(data,null,2)); }
function clean(t=''){ return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
function money(n){ return new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(n)||0); }
function containsAny(text, words){ return words.some(w => text.includes(clean(w))); }

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
function getSession(data, phone){ let s=(data.sessions||[]).find(x=>x.phone===phone); if(!s){ s={phone,state:'idle',data:{},updatedAt:new Date().toISOString()}; data.sessions.unshift(s); } return s; }
function setSession(s,state,extra={}){ s.state=state; s.data={...(s.data||{}),...extra}; s.updatedAt=new Date().toISOString(); }
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
  else if(activity.key === 'football') body = responseFootballMenu();
  else if(activity.key === 'basket') {
    if(containsAny(t,['masculino','varones','hombres'])){
      if(session){ setMenuContext(session,'basket_masc'); session.data.currentActivity='Básquet'; }
      if(containsAny(t,['sub 17','sub17'])){ if(session) setDiscipline(session,'discipline_detail','🏀 Básquet Masculino Sub 17','Básquet',['Masculino Sub 17'],'basket_masc'); body = disciplineAnswer(data,session||{data:{disciplineDetail:{activity:'Básquet',categoryNeedles:['Masculino Sub 17'],backMenu:'basket_masc'}}},'schedule'); }
      else if(containsAny(t,['sub 13','sub13'])){ if(session) setDiscipline(session,'discipline_detail','🏀 Básquet Masculino Sub 13','Básquet',['Masculino Sub 13'],'basket_masc'); body = disciplineAnswer(data,session||{data:{disciplineDetail:{activity:'Básquet',categoryNeedles:['Masculino Sub 13'],backMenu:'basket_masc'}}},'schedule'); }
      else if(containsAny(t,['sub 15','sub15'])){ if(session) setDiscipline(session,'discipline_detail','🏀 Básquet Masculino Sub 15','Básquet',['Masculino Sub 15'],'basket_masc'); body = disciplineAnswer(data,session||{data:{disciplineDetail:{activity:'Básquet',categoryNeedles:['Masculino Sub 15'],backMenu:'basket_masc'}}},'schedule'); }
      else if(containsAny(t,['primera','primera division','primera división'])){ if(session) setDiscipline(session,'discipline_detail','🏀 Básquet Masculino Primera división','Básquet',['Masculino Primera división','Primera división'],'basket_masc'); body = disciplineAnswer(data,session||{data:{disciplineDetail:{activity:'Básquet',categoryNeedles:['Masculino Primera división'],backMenu:'basket_masc'}}},'schedule'); }
      else body = responseBasketMasculino();
    } else if(containsAny(t,['femenino','mujeres','chicas'])){
      if(session){ setMenuContext(session,'basket_fem'); session.data.currentActivity='Básquet'; }
      if(containsAny(t,['sub 17','sub17','primera'])){ if(session) setDiscipline(session,'discipline_detail','🏀 Básquet Femenino Sub 17 y Primera','Básquet',['Femenino Sub 17','Femenino Primera'],'basket_fem'); body = disciplineAnswer(data,session||{data:{disciplineDetail:{activity:'Básquet',categoryNeedles:['Femenino Sub 17','Femenino Primera'],backMenu:'basket_fem'}}},'schedule'); }
      else if(containsAny(t,['sub 13','sub13','sub 15','sub15'])){ if(session) setDiscipline(session,'discipline_detail','🏀 Básquet Femenino Sub 13 y Sub 15','Básquet',['Femenino Sub 13','Femenino Sub 15'],'basket_fem'); body = disciplineAnswer(data,session||{data:{disciplineDetail:{activity:'Básquet',categoryNeedles:['Femenino Sub 13','Femenino Sub 15'],backMenu:'basket_fem'}}},'schedule'); }
      else body = responseBasketFemenino();
    } else body = responseBasketMenu();
  }
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
function timeGreeting(){
  const h = new Date().getHours();
  if(h >= 6 && h < 13) return '¡Buen día!';
  if(h >= 13 && h < 20) return '¡Buenas tardes!';
  return '¡Buenas noches!';
}
function panchitoMicroPhrase(){
  return pickRandom([
    'Dale, te ayudo 😊',
    'Perfecto, vamos por partes.',
    'Buenísimo, lo vemos.',
    'Listo, te oriento.',
    'De una, Panchito al rescate 😄',
    'Vamos con eso 💙',
    'Te sigo el hilo, como marca personal 😄',
    'Joya, sigo atento.',
    'Tranqui, bajamos la consulta al piso y salimos jugando ⚽',
    'Ahí voy, con la camiseta bien puesta 💙',
    'Dale que esta consulta la sacamos jugando 😄',
    'Estoy para darte una mano, como buen asistidor 🏟️'
  ]);
}
function panchitoIntroFunny(){
  const frases = [
    'Prometo ayudarte más rápido que un contraataque ⚽😄',
    'No soy Messi, pero con las consultas me defiendo bastante bien 😄',
    'Vos preguntá tranquilo, yo hago el precalentamiento de respuestas 🏃‍♂️',
    'En All Boys no prometo goles, pero sí buena información 💙',
    'Estoy más atento que arquero en penal 🥅',
    'Acá no cobramos offside por preguntar ⚽',
    'Preguntá sin miedo, que yo juego de asistidor 😄',
    'Mientras vos escribís, yo ya estoy buscando la respuesta 🔎',
    'Hoy vengo con botines nuevos para responder mejor 😄',
    'Si la consulta viene complicada, la bajamos al piso y salimos jugando ⚽',
    'No tengo camiseta transpirada, pero sí muchas ganas de ayudar 💙',
    'Estoy listo para darte una mano, como buen 10 armador 🏟️',
    'No prometo gambetas, pero sí orientarte lo mejor posible 😄',
    'Preguntame tranquilo: acá el VAR no anula consultas 😂',
    'Vamos paso a paso, sin pelotazos largos ⚽',
    'Yo te acompaño; los goles los hacen ustedes 💙',
    'Estoy en modo club: información, buena onda y respuesta rápida 😄',
    'Arrancamos cuando quieras, yo ya hice entrada en calor 🏃‍♂️',
    'Si querés horarios, cuotas o inscripción, te tiro un pase filtrado 😄',
    'Consultame lo que necesites, que para eso entré a la cancha ⚽',
    'Hoy Panchito está titular: preguntá nomás 😄',
    'Te atiendo con más ganas que tribuna en clásico 💙',
    'La consulta que venga, la paramos de pecho y respondemos claro ⚽',
    'Acá la buena onda juega de local 🏟️',
    'Si hace falta, te hago el pase a administración como un 10 😄',
    'No vendo humo: te oriento y, si hace falta, te derivo al club 💙'
  ];
  return pickRandom(frases);
}
function greetingMessage(){
  return panchitoMenu();
}
function softSocialMessage(s){
  const topic = (currentTopic(s) || s.data?.currentActivity || '').trim();
  if(topic){
    return `${panchitoMicroPhrase()}

Seguimos con ${topic}. Podés pedirme horarios, inscripción, costos, profesor o WhatsApp.`;
  }
  return panchitoMenu();
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
  return `⭐ Gracias por comunicarte con All Boys 😊

¿Te sirvió la información?

A. ✅ Sí, me sirvió
B. 🟡 Más o menos
C. ❌ No me sirvió

Respondé con A, B o C.
También podés escribir OMITIR.`;
}
function panchitoMenu(){
  const saludo = pickRandom([
    `👋 ${timeGreeting()} Soy Panchito, el bot de All Boys 😄`,
    `💙 ¡Buenas! Soy Panchito, el asistente copado de All Boys.`,
    `🏟️ ¡Hola! Panchito presente en la cancha de consultas.`,
    `🤖 ¡Hola! Soy Panchito. Hoy juego de asistidor del club.`,
    `⚽ ¡Buenas! Soy Panchito. Vos tirá la consulta que yo la bajo al piso.`,
    `😄 ¡Hola! Panchito al habla, listo para darte una mano.`,
    `💙 ¡Qué bueno verte por acá! Soy Panchito, asistente de All Boys.`,
    `🥅 ¡Hola! Soy Panchito. Estoy más atento que arquero en penal.`,
    `🏆 ¡Bienvenido a All Boys! Soy Panchito y entro de titular para ayudarte.`,
    `🙌 ¡Buenas! Soy Panchito. Acá la buena onda juega de local.`
  ]);
  return `${saludo}
${panchitoIntroFunny()}

¿Qué andás buscando hoy? 😄

A. 🏟️ Actividades, días y horarios
B. 📝 Precios e inscripción
C. 💳 Cuotas y pagos
D. 🏊 Natatorio / pileta
E. 👨‍💼 Hablar con administración
F. 💬 Reclamos o sugerencias
G. 📩 Prensa, CV, proveedores o propuestas
H. 🤔 Otra consulta`;
}
function adminContact(data){
  return `Administración All Boys
Responsables: Carolina y Mónica
📲 Abrir WhatsApp Administración`;
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
  return prompts[step] || prompts.name;
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
    : back === 'football_years' ? responseFootballD()
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
    if(c.includes('cuarta') || c.includes('quinta') || c.includes('sexta')) return {label:'Cuarta, Quinta y Sexta División', minAge:16, maxAge:20, branch:'masculino'};
    if(c.includes('septima') || c.includes('octava')) return {label:'Séptima y Octava División', minAge:14, maxAge:15, branch:'masculino'};
    if(c.includes('novena') || c.includes('decima')) return {label:'Novena y Décima División', minAge:12, maxAge:13, branch:'masculino'};
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
function phase6RecommendRule(data, activity='', ageInfo=null, branch=''){
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
  s.data = { ...(s.data||{}), menu };
  s.state = menu ? `waiting_${menu}` : 'idle';
  s.updatedAt = new Date().toISOString();
}
function getMenuContext(s){ return (s && s.data && s.data.menu) || ''; }
function isLetter(text, letters){
  const t = clean(text).toUpperCase();
  return letters.includes(t);
}
function clearMenuContext(s){
  s.data = { ...(s.data||{}), menu:'' };
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
    name: '1/4 Para derivarte bien, pasame tu nombre y apellido.',
    phone: '2/4 Ahora pasame un teléfono de contacto.',
    topic: '3/4 ¿Sobre qué tema es la consulta? Ejemplo: básquet, fútbol, cuota, inscripción, natatorio o reclamo.',
    message: '4/4 Contame brevemente qué necesitás para que administración lo pueda responder.'
  };
  return prompts[step] || prompts.name;
}

function adminSummary(draft={}){
  return `Consulta para administración:
Nombre y apellido: ${draft.name || '-'}
Teléfono: ${draft.phone || '-'}
Tema: ${draft.topic || '-'}
Mensaje: ${draft.message || '-'}`;
}

function goAdmin(data, s, phone, rawText, note='Usuario pidió hablar con administración'){
  s.data = { ...(s.data||{}), adminDraft:{ originalText: rawText || '', note } };
  setMenuContext(s,'admin_name');
  return `📞 Te llevo con administración.
${topicVibe('admin')}

Antes necesito algunos datos para que el club pueda responderte correctamente.

${adminStepPrompt('name')}

${adminContact(data)}`;
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

  if(kind === 'price') return finishAnswer(`💰 ${title}

${shortCost(items)}`, 'price');
  if(kind === 'teacher') return finishAnswer(`👨‍🏫 ${title}

${shortTeacher(items)}`, 'teacher');
  if(kind === 'inscription') return startSignupFlow(data, s, detail.activity || s.data?.currentActivity || 'Actividad', title);
  if(kind === 'schedule') return finishAnswer(`📅 ${title}

${formatSchedule(items)}`, 'schedule');

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
    return backMenu === 'basket' ? responseBasketMenu() : backMenu === 'football' ? responseFootballMenu() : responseActivityMenu();
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

function replyOnlyAgeRemembered(data, s, rawText=''){
  const ageInfo = extractAgeOrBirthYear(rawText);
  if(!ageInfo) return '';
  // Si solo dijo una edad/año, la guardamos y preguntamos actividad.
  if(detectActivityFreeText(rawText)) return '';
  if(phase6Intent(rawText)) return '';
  s.data = { ...(s.data||{}), userAge: ageInfo.age, userBirthYear: ageInfo.birthYear };
  setMenuContext(s,'human_minor_activity');
  const dataLabel = ageInfo.source === 'year' ? `año ${ageInfo.birthYear}` : `${ageInfo.age} años`;
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
  return `😄 ¡Perfecto! Vamos a encontrar la actividad ideal.
${sportVibe('activities')}

¿Cuál te interesa consultar?

A. 🤸 Gimnasia artística
B. 🏀 Básquet
C. 🥎 Sóftbol
D. 🏓 Pelota a paleta
E. ⚽ Fútbol
F. 🏠 Volver al menú principal

`;
}

function responseBasketMenu(){
  return `🏀 ¡Excelente! Básquet es una gran elección.
${sportVibe('basket')}

Para orientarte bien, decime una cosa:

A. 👧 Es para básquet femenino
B. 👦 Es para básquet masculino
C. 🐣 Escuelita / categorías iniciales
D. 🔙 Ver otras actividades
E. 🏠 Menú principal`;
}

function responseFootballMenu(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a las categorías de fútbol. Panchito acomoda la pelota y seguimos 😄`
    : `⚽ ¡Vamos con fútbol!
${sportVibe('football')}`;
  return `${intro}

Para ubicarte mejor, elegí la categoría o escribime la edad/año de nacimiento:

A. Cuarta, Quinta y Sexta División
B. Séptima y Octava División
C. Novena y Décima División
D. Categorías 2017, 2018, 2019, 2020 y 2021
E. Femenino Sub 12 y Sub 14
F. 🔙 Ver otras actividades
G. 🏠 Menú principal`;
}

function responseGymnastics(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a las categorías de gimnasia. Panchito acomoda la colchoneta y seguimos 😄`
    : `🤸 ¡Qué buena disciplina!
${sportVibe('gymnastics')}`;
  return `${intro}

Decime la edad o elegí una categoría:

A. Pulguitas (3 y 4 años)
B. Escuela (5 a 7 años)
C. Promocional (8 a 10 años)
D. Pre federadas (11 años en adelante)
E. Federadas
F. 🔙 Ver otras actividades
G. 🏠 Menú principal`;
}

function responseSoftbol(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a los grupos de sóftbol. Panchito prepara el guante y seguimos 😄`
    : `🥎 ¡Vamos con sóftbol!
${sportVibe('softbol')}`;
  return `${intro}

¿Qué grupo querés consultar?

A. Pre infantil mixto
B. Infantil cadete mixto
C. Femenino
D. 🔙 Ver otras actividades
E. 🏠 Menú principal`;
}

function responsePaleta(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a los grupos de pelota a paleta. Panchito devuelve la consulta con buen revés 😄`
    : `🏓 ¡Linda elección! Pelota a paleta tiene mucha magia.
${sportVibe('paleta')}`;
  return `${intro}

¿Qué grupo querés consultar?

A. Niños y niñas de 6 a 12 años
B. Adultos
C. 🔙 Ver otras actividades
D. 🏠 Menú principal`;
}

function responseBasketFemenino(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a las categorías de básquet femenino. Panchito pica la pelota y seguimos 😄`
    : `🏀 Básquet femenino, ¡excelente!
${sportVibe('basket')}`;
  return `${intro}

Para no mandarte a cualquier categoría, decime la edad de la jugadora o elegí una opción:

A. Sub 17 y Primera
B. Sub 13 y Sub 15
C. Sub 11
D. 🔙 Volver a básquet
E. 🏠 Menú principal`;
}

function responseBasketMasculino(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a las categorías de básquet masculino. Panchito tira una asistencia y seguimos 😄`
    : `🏀 Básquet masculino, vamos ahí.
${sportVibe('basket')}`;
  return `${intro}

Decime la edad del jugador o elegí una categoría:

A. Sub 17
B. Sub 13
C. Sub 15
D. Primera división
E. Asociativo
F. 🔙 Volver a básquet
G. 🏠 Menú principal`;
}

function responseBasketInicial(mode='normal'){
  const intro = mode === 'back'
    ? `🔙 Volvemos a escuelita e iniciales. Panchito acomoda el tablero y seguimos 😄`
    : `🏀 Escuelita e iniciales.
Acá arrancan las primeras bandejas y los primeros pases 😄`;
  return `${intro}

¿Qué querés consultar?

A. Sub 9
B. Sub 11
C. Escuelita
D. Mosquitos
E. 🔙 Volver a básquet
F. 🏠 Menú principal`;
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
  return `📝 Vamos con precios e inscripción.
${topicVibe('signup')}

¿Qué necesitás?

A. 💰 Precio de una actividad
B. 📝 Cómo inscribirme a una actividad
C. 🎫 Cómo asociarme al club
D. 👧 Inscripción para un menor
E. 📞 Hablar con administración
F. 🏠 Volver al menú principal`;
}


function responseNatatorioMenu(isMinor=false){
  const intro = isMinor
    ? `🏊 Sí, el club cuenta con natatorio / pileta y puede haber actividades para niños y niñas.

La disponibilidad depende de la edad, el nivel, la temporada y los cupos vigentes.`
    : `Te ayudo con natatorio / pileta 🏊

La información puede variar según temporada, niveles y cupos vigentes.`;

  return `${intro}

¿Qué querés consultar?

A. Horarios
B. Inscripción
C. Edades y niveles
D. Cupos disponibles
E. Hablar con administración
F. Volver al menú principal`;
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
  return prompts[step] || prompts.name;
}

function claimSummary(draft={}){
  return `Reclamo cargado:
Nombre y apellido: ${draft.name || '-'}
Teléfono: ${draft.phone || '-'}
Área/actividad: ${draft.area || '-'}
Qué ocurrió: ${draft.detail || '-'}`;
}

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
  const menu = getMenuContext(s);
  const letter = clean(rawText).toUpperCase();

  // Menús que son formularios paso a paso: acá no debe entrar la memoria de actividad.
  // Esto corrige el error interno "Cannot access protectedMenus before initialization"
  // y evita que una palabra como "horarios" rompa el bot cuando venía de Natatorio.
  const protectedMenus = [
    'signup_name','signup_age','signup_dni','signup_socio','signup_phone','signup_email','signup_notes','signup_confirm',
    'admin_name','admin_phone','admin_topic','admin_message',
    'claim_name','claim_phone','claim_area','claim_detail'
  ];

  // PRIORIDAD SOCIAL: saludos y respuestas cortas no deben abrir menús ni actividades.
  // Ejemplo: "buen día" no puede convertirse en "horarios" por el normalizador.
  if(isGreetingText(rawText)){
    intent='saludo'; confidence=.99;
    // Al saludar volvemos al menú principal real. Esto evita que una letra A/B/C
    // quede atrapada en un submenú viejo como básquet femenino.
    s.data = { ...(s.data||{}), menu:'main', topic:'', currentActivity:'', currentCategory:'', disciplineDetail:null };
    setSession(s,'idle', s.data);
    reply = greetingMessage();
    return finish();
  }

  if(isSoftSocialText(rawText)){
    intent='respuesta_social'; confidence=.96;
    reply = softSocialMessage(s);
    return finish();
  }

  function isMainMenuLetter(){
    return isLetter(rawText, ['A','B','C','D','E','F','G','H']);
  }

  function routeMainMenuLetter(){
    // Router único del menú principal.
    // Esto evita que una letra quede atrapada en un estado viejo, por ejemplo
    // F después de cuotas no debe volver a cuotas: debe abrir Reclamos.
    const main = clean(rawText).toUpperCase();

    if(main === 'A'){
      intent='actividades'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'actividades',{}); setMenuContext(s,'activities');
      reply = responseActivityMenu();
      return finish();
    }

    if(main === 'B'){
      intent='precios_inscripcion'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'inscripcion',{}); setMenuContext(s,'prices');
      reply = responsePricesMenu();
      return finish();
    }

    if(main === 'C'){
      intent='cuotas_pagos'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'cuota',{}); setMenuContext(s,'payments');
      reply = responsePaymentsMenu();
      return finish();
    }

    if(main === 'D'){
      intent='natatorio'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'natatorio',{}); setMenuContext(s,'natatorio');
      reply = responseNatatorioMenu(false);
      return finish();
    }

    if(main === 'E'){
      intent='administracion'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'administracion',{});
      reply = goAdmin(data, s, phone, rawText, 'Usuario pidió hablar con administración desde menú principal');
      return finish();
    }

    if(main === 'F'){
      intent='reclamo_sugerencia'; confidence=.98;
      setSession(s,'idle',{ claimDraft: {} }); setTopic(s,'reclamo',{}); setMenuContext(s,'claim_name');
      s.data.claimDraft = {};
      reply = responseClaimMenu();
      return finish();
    }

    if(main === 'G'){
      intent='institucional'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'institucional',{}); setMenuContext(s,'institutional');
      reply = `📩 Gracias por escribirle al club.
${topicVibe('institutional')}

¿Qué querés enviar?

A. Consulta de prensa o medios
B. Dejar CV
C. Proponer un proyecto
D. Ofrecer productos o servicios
E. Sponsoreo, publicidad o auspicio
F. Consulta de estudiante o institución
G. Volver al menú principal`;
      return finish();
    }

    if(main === 'H'){
      intent='otra_consulta'; confidence=.96;
      setSession(s,'idle',{}); setTopic(s,'otra',{}); setMenuContext(s,'other');
      reply = `No hay problema 😊
${topicVibe('other')}

Contame brevemente qué necesitás y trato de orientarte.

A. Volver al menú principal
B. Hablar con administración

Quedo atento a tu consulta.`;
      return finish();
    }
  }

  // Si el último mensaje mostrado fue el menú principal, las letras A-H
  // SIEMPRE pertenecen al menú principal, no al submenú anterior.
  if(menu === 'main' && isMainMenuLetter()){
    return routeMainMenuLetter();
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
      reply = `De nada 😊 Gracias a vos por comunicarte con All Boys.

Te dejo el menú principal por si necesitás algo más.

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
      reply = `¡De nada! 😊

Gracias por comunicarte con All Boys.

Si necesitás información sobre actividades, horarios, inscripciones, cuotas o cualquier consulta del club, voy a estar para ayudarte.

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


  if(['signup_name','signup_age','signup_dni','signup_socio','signup_phone','signup_email','signup_notes','signup_confirm','signup_edit_name','signup_edit_age','signup_edit_phone','signup_done'].includes(menu)){
    if(containsAny(text,['menu','menú','inicio','salir','cancelar','volver'])){
      intent='inscripcion_cancelada'; confidence=.92;
      clearMenuContext(s);
      s.data.signupDraft = {};
      reply = panchitoMenu();
      return finish();
    }

    s.data.signupDraft = s.data.signupDraft || {};

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
      const info = extractAgeOrBirthYear(rawText);
      if(info){
        s.data.signupDraft.birthYear = info.birthYear || '';
        s.data.userAge = info.age;
        if(info.birthYear) s.data.userBirthYear = info.birthYear;

        const rec = phase6RecommendRule(data, s.data.signupDraft.activity || '', info, s.data.signupDraft.branch || s.data.userBranch || '');
        if(rec){
          s.data.signupDraft.category = rec.label || s.data.signupDraft.category;
          s.data.signupDraft.branch = rec.branch || s.data.signupDraft.branch || '';
          s.data.currentCategory = rec.label || s.data.currentCategory;
        }
      }
      const advice = categoryAgeAdvice(data, s.data.signupDraft.activity || '', s.data.signupDraft.category || '', rawText);
      setMenuContext(s,'signup_dni');
      reply = `Perfecto ✅${advice}

${signupStepPrompt('dni', s.data.signupDraft)}

Podés escribir MENÚ para cancelar.`;
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
      const info = extractAgeOrBirthYear(rawText);
      if(info){
        s.data.signupDraft.birthYear = info.birthYear || '';
        s.data.userAge = info.age;
        if(info.birthYear) s.data.userBirthYear = info.birthYear;
        const rec = phase6RecommendRule(data, s.data.signupDraft.activity || '', info, s.data.signupDraft.branch || s.data.userBranch || '');
        if(rec){
          s.data.signupDraft.category = rec.label || s.data.signupDraft.category;
          s.data.signupDraft.branch = rec.branch || s.data.signupDraft.branch || '';
          s.data.currentCategory = rec.label || s.data.currentCategory;
        }
      }
      setMenuContext(s,'signup_confirm');
      reply = `✅ Listo, actualicé la edad.

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

    if(menu === 'signup_confirm'){
      if(isLetter(rawText,['A']) || containsAny(text,['confirmar','confirmo','si','sí','dale','ok'])){
        intent='inscripcion_registrada'; confidence=.98;
        const dup=(data.registrations||[]).find(r=>
          (r.phone=== (s.data.signupDraft.phone||phone||'')) &&
          String(r.activity||'').toLowerCase()===String(s.data.signupDraft.activity||'').toLowerCase() &&
          String(r.category||'').toLowerCase()===String(s.data.signupDraft.category||'').toLowerCase() &&
          String(r.status||'').toLowerCase()!=='cancelada');
        if(dup){
          const st=(dup.status||'Pendiente');
          let msg='⚠️ Ya estás inscripto en esta actividad.';
          if(st==='Sin cupo') msg='⚠️ Ya figurás en la lista de espera de esta actividad.';
          else if(st==='Confirmada') msg='✅ Tu inscripción ya fue confirmada.';
          else msg='⚠️ Ya existe una solicitud registrada para esta actividad.';
          reply=`${msg}

Actividad: ${dup.activity} - ${dup.category}
Estado: ${st}

Si necesitás modificar datos, comunicate con Administración.`;
          setMenuContext(s,'signup_done');
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

  if(['admin','admin_name','admin_phone','admin_topic','admin_message','admin_done'].includes(menu)){
    if(containsAny(text,['menu','menú','inicio','salir','cancelar','volver'])){
      intent='menu'; confidence=.9;
      clearMenuContext(s);
      s.data.adminDraft = {};
      reply = panchitoMenu();
      return finish();
    }

    s.data.adminDraft = s.data.adminDraft || {};

    if(menu === 'admin' || menu === 'admin_name'){
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
      pending.topic = s.data.adminDraft.topic || '';
      pending.message = s.data.adminDraft.message || '';
      pending.priority = derivationPriority(s.data.adminDraft);
      pending.whatsappLink = replyToUserWhatsAppLink(s.data.adminDraft, phone);
      setMenuContext(s,'admin_done');
      reply = `✅ Consulta registrada

Estado: PENDIENTE
Tipo: ${pending.priority}
N°: DER-${String(pending.id).slice(-4)}

${resumen}

✅ Tu consulta fue enviada correctamente.
Administración se comunicará con vos a la brevedad.

${adminContact(data)}

¿Qué querés hacer ahora?
A. 📝 Cargar otra consulta
B. 🏠 Volver al menú principal`;
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
        setMenuContext(s,'admin_name');
        reply = `Dale, cargamos otra consulta.

${adminStepPrompt('name')}`;
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

  if(menu === 'activities' && isLetter(rawText, ['A','B','C','D','E','F'])){
    intent='submenu_actividades'; confidence=.96;
    if(letter==='A'){ setMenuContext(s,'gymnastics'); s.data.currentActivity='Gimnasia Artística'; reply=responseGymnastics(); return finish(); }
    if(letter==='B'){ setMenuContext(s,'basket'); s.data.currentActivity='Básquet'; reply=responseBasketMenu(); return finish(); }
    if(letter==='C'){ setMenuContext(s,'softbol'); s.data.currentActivity='Softbol'; reply=responseSoftbol(); return finish(); }
    if(letter==='D'){ setMenuContext(s,'paleta'); s.data.currentActivity='Pelota a Paleta'; reply=responsePaleta(); return finish(); }
    if(letter==='E'){ setMenuContext(s,'football'); s.data.currentActivity='Fútbol'; reply=responseFootballMenu(); return finish(); }
    if(letter==='F'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'gymnastics' && isLetter(rawText, ['A','B','C','D','E','F','G'])){
    intent='submenu_gimnasia'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','🤸 Pulguitas (3 y 4 años)','Gimnasia Artística',['Pulgas','Pulguitas'],'gymnastics'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','🤸 Escuela (5 a 7 años)','Gimnasia Artística',['Escuela'],'gymnastics'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','🤸 Promocional (8 a 10 años)','Gimnasia Artística',['Promocional'],'gymnastics'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setDiscipline(s,'discipline_detail','🤸 Pre federadas','Gimnasia Artística',['Pre federadas'],'gymnastics'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='E'){ setDiscipline(s,'discipline_detail','🤸 Federadas','Gimnasia Artística',['Federadas'],'gymnastics'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='F'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'softbol' && isLetter(rawText, ['A','B','C','D','E'])){
    intent='submenu_softbol'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','🥎 Pre infantil mixto','Softbol',['Pre infantil'],'softbol'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','🥎 Infantil cadete mixto','Softbol',['Infantil cadete'],'softbol'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','🥎 Femenino','Softbol',['Femenino'],'softbol'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'paleta' && isLetter(rawText, ['A','B','C','D'])){
    intent='submenu_paleta'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','🏓 Niños y niñas de 6 a 12 años','Pelota a Paleta',['Niños','niñas'],'paleta'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','🏓 Adultos','Pelota a Paleta',['Adultos'],'paleta'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='D'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'basket' && isLetter(rawText, ['A','B','C','D','E'])){
    intent='submenu_basquet'; confidence=.96;
    if(letter==='A'){ setMenuContext(s,'basket_fem'); s.data.currentActivity='Básquet'; reply=responseBasketFemenino(); return finish(); }
    if(letter==='B'){ setMenuContext(s,'basket_masc'); s.data.currentActivity='Básquet'; reply=responseBasketMasculino(); return finish(); }
    if(letter==='C'){ setMenuContext(s,'basket_init'); s.data.currentActivity='Básquet'; reply=responseBasketInicial(); return finish(); }
    if(letter==='D'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'basket_fem' && isLetter(rawText, ['A','B','C','D','E'])){
    intent='submenu_basquet_fem'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 17 y Primera','Básquet',['Femenino Sub 17','Femenino Primera'],'basket_fem'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 13 y Sub 15','Básquet',['Femenino Sub 13','Femenino Sub 15'],'basket_fem'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','🏀 Básquet Femenino Sub 11','Básquet',['Femenino Sub 11'],'basket_fem'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setMenuContext(s,'basket'); reply=responseBasketMenu(); return finish(); }
    if(letter==='E'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'basket_masc' && isLetter(rawText, ['A','B','C','D','E','F','G'])){
    intent='submenu_basquet_masc'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 17','Básquet',['Masculino Sub 17'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 13','Básquet',['Masculino Sub 13'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Sub 15','Básquet',['Masculino Sub 15'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setDiscipline(s,'discipline_detail','🏀 Básquet Masculino Primera división','Básquet',['Masculino Primera división','Primera división'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='E'){ setDiscipline(s,'discipline_detail','🏀 Básquet Asociativo','Básquet',['Asociativo'],'basket_masc'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='F'){ setMenuContext(s,'basket'); reply=responseBasketMenu(); return finish(); }
    if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'basket_init' && isLetter(rawText, ['A','B','C','D','E','F'])){
    intent='submenu_basquet_inicial'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','🏀 Básquet Sub 9','Básquet',['Sub 9'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','🏀 Básquet Sub 11','Básquet',['Sub 11'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','🏀 Básquet Escuelita','Básquet',['Escuelita'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setDiscipline(s,'discipline_detail','🏀 Básquet Mosquitos','Básquet',['Mosquitos'],'basket_init'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='E'){ setMenuContext(s,'basket'); reply=responseBasketMenu(); return finish(); }
    if(letter==='F'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'football' && isLetter(rawText, ['A','B','C','D','E','F','G'])){
    intent='submenu_futbol'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','⚽ Cuarta, Quinta y Sexta División','Fútbol',['Cuarta','Quinta','Sexta'],'football'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','⚽ Séptima y Octava División','Fútbol',['Séptima','Septima','Octava'],'football'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','⚽ Novena y Décima División','Fútbol',['Novena','Décima','Decima'],'football'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setMenuContext(s,'football_years'); reply=responseFootballD(); return finish(); }
    if(letter==='E'){ setDiscipline(s,'discipline_detail','⚽ Femenino Sub 12 y Sub 14','Fútbol',['Femenino'],'football'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='F'){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'football_years' && isLetter(rawText, ['A','B','C','D','E','F'])){
    intent='submenu_futbol_anios'; confidence=.96;
    if(letter==='A'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2017','Fútbol',['2017'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='B'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2018','Fútbol',['2018'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='C'){ setDiscipline(s,'discipline_detail','⚽ Categoría 2019','Fútbol',['2019'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='D'){ setDiscipline(s,'discipline_detail','⚽ Categorías 2020-2021','Fútbol',['2020','2021'],'football_years'); reply=disciplineAnswer(data,s,'all'); return finish(); }
    if(letter==='E'){ setMenuContext(s,'football'); reply=responseFootballMenu(); return finish(); }
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


  if(menu === 'natatorio' && isLetter(rawText, ['A','B','C','D','E','F'])){
    intent='submenu_natatorio'; confidence=.92;
    if(letter==='A'){ setMenuContext(s,'natatorio_after'); reply=responseNatatorioOption(data,'horarios'); return finish(); }
    if(letter==='B'){ reply=startSignupFlow(data, s, 'Natatorio / pileta', 'Inscripción a natatorio'); return finish(); }
    if(letter==='C'){ setMenuContext(s,'natatorio_after'); reply=responseNatatorioOption(data,'edades'); return finish(); }
    if(letter==='D'){ setMenuContext(s,'natatorio_after'); reply=responseNatatorioOption(data,'cupos'); return finish(); }
    if(letter==='E'){ reply=goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde natatorio'); return finish(); }
    if(letter==='F'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
  }

  if(menu === 'natatorio_after' && isLetter(rawText, ['A','B','C','D'])){
    intent='post_natatorio'; confidence=.92;
    if(letter==='A'){ reply=goAdmin(data, s, phone, rawText, 'Usuario pidió administración desde respuesta de natatorio'); return finish(); }
    if(letter==='B'){ setMenuContext(s,'natatorio'); reply=responseNatatorioMenu(false); return finish(); }
    if(letter==='C'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    if(letter==='D'){ setMenuContext(s,'free'); reply='Contame qué necesitás consultar y te ayudo.'; return finish(); }
  }

  if(menu === 'institutional' && isLetter(rawText, ['A','B','C','D','E','F','G'])){
    intent='submenu_institucional'; confidence=.92;
    if(letter==='G'){ clearMenuContext(s); reply=panchitoMenu(); return finish(); }
    const labels = {A:'Consulta de prensa o medios',B:'Dejar CV',C:'Proponer un proyecto',D:'Ofrecer productos o servicios',E:'Sponsoreo, publicidad o auspicio',F:'Consulta de estudiante o institución'};
    addPending(data, phone, rawText, 'institucional', labels[letter] || 'Consulta institucional');
    setMenuContext(s,'admin');
    reply = `${labels[letter] || 'Consulta institucional'} 📩\n\nPara que administración lo revise, escribí el detalle en un solo mensaje y, si corresponde, agregá contacto o archivo.\n\n${adminContact(data)}`;
    return finish();
  }

  if(menu === 'prices' && isLetter(rawText, ['A','B','C','D','E','F'])){
    intent='submenu_precios'; confidence=.94;
    if(letter==='A'){
      s.data.priceFlow = true;
      s.data.priceMode = 'price';
      setMenuContext(s,'activities');
      reply = `Perfecto. Primero elegí el deporte o disciplina para consultar el precio

A. Gimnasia artística 🤸
B. Básquet 🏀
C. Sóftbol 🥎
D. Pelota a paleta
E. Fútbol ⚽
F. Volver al menú principal`;
      return finish();
    }
    if(letter==='B'){
      s.data.priceFlow = true;
      s.data.priceMode = 'inscription';
      setMenuContext(s,'activities');
      reply = `Perfecto. Primero elegí el deporte o disciplina para consultar la inscripción 📝

A. Gimnasia artística 🤸
B. Básquet 🏀
C. Sóftbol 🥎
D. Pelota a paleta
E. Fútbol ⚽
F. Volver al menú principal`;
      return finish();
    }
    if(letter==='C'){
      addPending(data, phone, rawText, 'asociarse', 'Consulta cómo asociarse');
      setMenuContext(s,'general_after_prices');
      reply = `Para asociarte al club, administración te puede indicar los requisitos actualizados.

${adminContact(data)}${afterGeneralMenu()}`;
      return finish();
    }
    if(letter==='D'){
      s.data.priceFlow = true;
      s.data.priceMode = 'inscription';
      setMenuContext(s,'activities');
      reply = `Si es para un menor, primero elegí la actividad y categoría. Después te muestro cómo consultar la inscripción 📝

A. Gimnasia artística 🤸
B. Básquet 🏀
C. Sóftbol 🥎
D. Pelota a paleta
E. Fútbol ⚽
F. Volver al menú principal`;
      return finish();
    }
    if(letter==='E'){
      addPending(data, phone, rawText, 'administracion', 'Usuario pidió administración desde precios');
      setMenuContext(s,'general_after_prices');
      reply = `Claro 😊

Te derivo con administración.

${adminContact(data)}${afterGeneralMenu()}`;
      return finish();
    }
    if(letter==='F'){ s.data.priceFlow=false; s.data.priceMode=''; clearMenuContext(s); reply=panchitoMenu(); return finish(); }
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

  // Comandos de navegación dentro de submenús
  if(containsAny(text,['atras','atrás']) && menu){
    intent='atras'; confidence=.9;
    if(menu.includes('basket')){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    if(menu.includes('football')){ setMenuContext(s,'activities'); reply=responseActivityMenu(); return finish(); }
    clearMenuContext(s); reply=panchitoMenu(); return finish();
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

  if(containsAny(text,['voley','vóley','volley','patin','patín','patinaje'])){
    intent='actividad_derivar_admin'; confidence=.88;
    addPending(data, phone, rawText, 'actividad', 'Consulta directa de actividad no cargada en menú');
    reply = `Te ayudo con esa actividad 😊

Por ahora no tengo horarios confirmados para esa disciplina. Lo mejor es validarlo con administración.

${adminContact(data)}

También podés escribir MENÚ para volver al inicio.`;
    return finish();
  }

  if(containsAny(text,['admin','administracion','administración','secretaria','secretaría','humano','persona','hablar con alguien','atencion','atención','ventanilla']) || text==='e'){
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

  if(text==='f' || containsAny(text,['reclamo','queja','problema','sugerencia','inconveniente','mala atencion','mala atención','quiero reclamar','quiero sugerir'])){
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

  if(text==='g' || containsAny(text,['prensa','periodista','entrevista','acreditacion','acreditación','cv','curriculum','currículum','trabajo','profesor','entrenador','proyecto','propuesta','proveedor','sponsor','auspicio','publicidad','convenio','estudiante','investigacion','investigación'])){
    intent='institucional'; confidence=.9;
    addPending(data, phone, rawText, 'institucional', 'Prensa/CV/proveedor/propuesta');
    setMenuContext(s,'institutional');
    reply = `📩 Gracias por escribirle al club.
${topicVibe('institutional')}

¿Qué querés enviar?

A. Consulta de prensa o medios
B. Dejar CV
C. Proponer un proyecto
D. Ofrecer productos o servicios
E. Sponsoreo, publicidad o auspicio
F. Consulta de estudiante o institución
G. Volver al menú principal`;
    return finish();
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

A. Actividades, días y horarios 🏀⚽🤸
B. Precios e inscripción 📝
C. Cuotas y pagos 💳
D. Natatorio / pileta 🏊
E. Hablar con administración 📞`;
  } else {
    reply = `Perdón, no terminé de entender la consulta.

Podés elegir una opción:

A. Actividades, días y horarios 🏀⚽🤸
B. Precios e inscripción 📝
C. Cuotas y pagos 💳
D. Natatorio / pileta 🏊
E. Hablar con administración 📞
F. Reclamos o sugerencias 💬
G. Prensa, CV, proveedores o propuestas 📩
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


app.get('/api/registrations',(req,res)=>{ const data=db(); res.json(data.registrations||[]); });
app.put('/api/registrations/:id',(req,res)=>{
  const data=db();
  const id=Number(req.params.id);
  data.registrations=(data.registrations||[]).map(r=>r.id===id?{...r,...req.body,id,status:registrationStatusLabel(req.body.status||r.status),updatedAt:new Date().toISOString()}:r);
  save(data);
  res.json({ok:true});
});
app.delete('/api/registrations/:id',(req,res)=>{
  const data=db();
  data.registrations=(data.registrations||[]).filter(r=>r.id!==Number(req.params.id));
  save(data);
  res.json({ok:true});
});
app.get('/api/pending',(req,res)=>{ const data=db(); res.json(data.pendingQueries||[]); });
app.put('/api/pending/:id',(req,res)=>{ const data=db(); const id=Number(req.params.id); data.pendingQueries=(data.pendingQueries||[]).map(p=>p.id===id?{...p,...req.body,id,updatedAt:new Date().toISOString()}:p); save(data); res.json({ok:true}); });
app.delete('/api/pending/:id',(req,res)=>{ const data=db(); data.pendingQueries=(data.pendingQueries||[]).filter(p=>p.id!==Number(req.params.id)); save(data); res.json({ok:true}); });
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
function quickTwilioReply(rawText=''){
  // V41 Panchito Pro: respuesta rápida Twilio con saludo humano y menú natural.
  // Limpia signos y variantes para que "hola", "buen día", "menu" o "inicio" muestren siempre el menú completo.
  const t = clean(rawText).replace(/[!¡?¿.,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(!t) return panchitoMenu();
  const menuWords = ['menu','menú','inicio','empezar','arrancar','opciones','opcion','opción','0'];
  if(menuWords.includes(t)) return panchitoMenu();
  if(isGreetingText(t)) return panchitoMenu();
  if(['hola','holaa','buenas','buen dia','buen día','buenos dias','buenos días','buenas tardes','buenas noches'].includes(t)) return panchitoMenu();
  return '';
}
async function smartReplySafe(rawText, from){
  const quick = quickTwilioReply(rawText);
  if(quick){
    // Guardamos que el usuario está en menú principal aunque haya entrado por la respuesta rápida.
    // Así, si después responde A, B, C, etc., no se mezcla con un submenú anterior.
    try{
      const data = db();
      data.sessions = data.sessions || [];
      const s = getSession(data, normalizeTwilioPhone(from));
      s.state = 'idle';
      s.data = { ...(s.data||{}), menu:'main', topic:'', currentActivity:'', currentCategory:'', disciplineDetail:null };
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
    const xml = twilioXml(replyText);
    console.log('Respuesta Twilio enviada:', { from, intent: result?.intent, chars: replyText.length });
    res.type('text/xml').send(xml);
  }catch(e){
    console.error('Error en /whatsapp Twilio:', e);
    const fallback = 'Perdón, Panchito tuvo un inconveniente para responder. Escribí MENÚ o probá de nuevo en unos segundos.';
    res.type('text/xml').send(twilioXml(fallback));
  }
});

// /webhook compatible con Twilio Sandbox y Meta verification.
// En Twilio > WhatsApp Sandbox > Sandbox settings > When a message comes in:
// https://TU_URL_PUBLICA/webhook  (Method: POST)
app.get('/webhook',(req,res)=>{
  const verifyToken=process.env.WHATSAPP_VERIFY_TOKEN || 'clubbot-demo';
  if(req.query['hub.verify_token']===verifyToken) return res.send(req.query['hub.challenge']);
  res.type('text/plain').send('Panchito webhook OK. Para Twilio usá POST a esta URL.');
});
app.post('/webhook', async (req,res)=>{
  try{
    const incomingText = req.body?.Body || req.body?.body || req.body?.message || '';
    const from = normalizeTwilioPhone(req.body?.From || req.body?.WaId || 'whatsapp:demo');
    console.log('Webhook WhatsApp recibido:', { from, text: incomingText, body: JSON.stringify(req.body).slice(0,400) });

    const result = await smartReplySafe(incomingText, from);
    const replyText = result?.reply || result?.text || String(result || '');
    const xml = twilioXml(replyText);
    console.log('Respuesta Twilio enviada:', { from, intent: result?.intent, chars: replyText.length });
    res.type('text/xml').send(xml);
  }catch(e){
    console.error('Error en /webhook Twilio:', e);
    const fallback = 'Perdón, Panchito tuvo un inconveniente para responder. Escribí MENÚ o probá de nuevo en unos segundos.';
    res.type('text/xml').send(twilioXml(fallback));
  }
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

app.get('/health',(req,res)=>res.send('ClubBot IA Enterprise activo ✅'));
app.listen(PORT,()=>{
  console.log(`ClubBot IA Enterprise en http://localhost:${PORT}`);
  console.log('Panchito V40 menú gracioso activo - hola/menu muestran opciones completas');
});
