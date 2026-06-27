# ClubBot All Boys v4 Premium

Demo comercial para clubes: panel premium + bot IA local + base de socios/cuotas/actividades + entrenamiento de conocimiento + importador CSV.

## Probar
```bash
npm install
npm start
```
Abrir: http://localhost:3000

## Demo bot
Probá: `hola`, `cuánto debo`, `12345678`, `87654321`, `horarios fútbol`, `quiero asociarme`, `medios de pago`.

## Próximo paso real
Conectar WhatsApp Business Cloud API de Meta: webhook + token + servidor HTTPS.


## v5.1 Menú real
- Bienvenida más profesional: '¿En qué puedo ayudarte?'
- Menú numerado del 1 al 7.
- El bot entiende opciones numéricas y texto libre.


## V6
- Base preparada para Documentos IA
- Próximo paso: carga de PDFs y búsqueda documental


## V7 Web IA

Incluye base de conocimiento cargada desde la web oficial:
https://cluballboyslapampa.org/

Nuevas rutas:
- POST /api/train/website
- GET /api/train/website/preview
- /entrenar-web.html

La IA local ahora puede responder sobre:
- Sede: Hilario Lagos 435, Santa Rosa
- Natatorio Ismael Amit
- Gimnasia artística
- Fútbol femenino
- La Cantina
- Carnet Digital
- Contacto publicado


## V8 Chat Premium

Mejoras:
- Mensaje inicial más humano.
- Menú visual con opciones reales, no sólo números.
- Tarjetas rápidas con texto natural.
- Avatar con escudo en cada respuesta del bot.
- Fondo de chat con marca de agua del escudo.
- Hora y tilde en mensajes.
- Respuesta específica para pileta/natatorio.
- Base de conocimiento reforzada para consultas naturales.


## V9 IA Humana

Mejoras:
- Respuestas menos robóticas.
- Frases más humanas para cuota, deuda, natatorio, actividades y administración.
- Avatar del bot reemplazado por icono deportivo azul/amarillo con AB + pelota.
- Se evita el escudo chico tipo rojo/blanco en las burbujas del chat.


## V10 Robot Chat

Cambios:
- Robot All Boys en el encabezado del chat.
- Escudo oficial de All Boys en cada mensaje del bot.
- Se conserva la identidad institucional del club y se suma presencia de asistente IA.


## V11 Memoria IA

Mejoras:
- El bot recuerda contexto de natatorio/pileta.
- Si el usuario pregunta "y se puede meter", responde en contexto.
- Si dice "para mi hijo", continúa la conversación.
- Robot IA en los mensajes del chat.
- Escudo queda como identidad del club en branding.
- Respuestas más humanas.


## V12 Contexto DNI

Mejoras:
- Si el bot queda en consulta de cuota, recuerda ese contexto.
- Permite consultar varios DNI o números de socio seguidos.
- Si escriben "y también 12345678", entiende que es otra consulta de socio.
- Si no encuentra el socio, responde claro y no se va a otra intención.
- Respuestas de cuota más humanas.


## V13 DNI en texto

Corrección:
- Detecta DNI o número de socio aunque venga mezclado con texto.
- Ejemplos válidos:
  - 12345678
  - y el 12345678
  - fijate el DNI 12345678
  - también 12345678
- Si no lo encuentra, responde claro y sigue esperando otro número.


## V14 Corrección real de contexto DNI

Se reemplazó smartReply completo para evitar el bug donde el fallback de DNI quedaba dentro del if(member).
Ahora cualquier mensaje con un número de 4 a 12 dígitos se trata como posible DNI/número de socio:
- "12345678"
- "y el 12345678"
- "el de mi hermano 12345678"
- "fijate dni 12345678"


## V15 Sistema Pulido
- Respuestas más humanas.
- Mejor memoria para natatorio.
- Mejor flujo para 'mi hijo', 'se puede meter', 'inscripción', 'cuánto sale'.
- Mejor flujo para cuotas y varios DNI seguidos.
- Más datos demo.


## V16 Panchito Fase 1

Incluye:
- Panchito como identidad del bot.
- Menú con letras A-H según relevamiento del club.
- Actividades reales cargadas.
- Alias real: allboyseslapampa.
- WhatsApp real del club: 2954-592313.
- Natatorio deriva a coordinador/administración.
- Consultas pendientes para administración.
- Casos: reclamos, sugerencias, prensa, CV, proveedores, sponsors, urgencias y otra consulta.
- Estructura preparada para conectar luego Digital Club / Excel / CSV / API.


## V17.1 Contexto de menús

Corrección:
- Las letras A/B/C ahora dependen del submenú activo.
- Si Panchito muestra Actividades, B responde Básquet y no Precios.
- Submenús con estado para Actividades, Básquet, Fútbol, Precios y Pagos.
- Comando ATRÁS vuelve al menú anterior.
