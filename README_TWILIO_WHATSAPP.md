# Panchito + Twilio WhatsApp Sandbox

## 1) Instalar y ejecutar el bot

```bash
npm install
npm start
```

El bot queda local en:

```txt
http://localhost:3000
```

## 2) Exponerlo con ngrok para pruebas

En otra terminal:

```bash
ngrok http 3000
```

Copiá la URL HTTPS que te da ngrok, por ejemplo:

```txt
https://algo.ngrok-free.app
```

## 3) Configurar Twilio Sandbox

En Twilio > WhatsApp Sandbox, en **When a message comes in**, pegá:

```txt
https://algo.ngrok-free.app/whatsapp
```

Método: **POST**.

Guardá los cambios.

## 4) Probar desde WhatsApp

Ya vinculado al Sandbox con el código `join ...`, escribile al número de Twilio:

```txt
menu
```

Panchito tiene que responder desde WhatsApp.

## Rutas agregadas

- `GET /whatsapp`: prueba rápida para ver si la URL está viva.
- `POST /whatsapp`: webhook de Twilio que recibe `Body` y `From`, llama al motor `smartReply()` y responde en XML TwiML.
