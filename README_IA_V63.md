# V63 IA controlada

Esta versión conecta Panchito a OpenAI de forma segura:

- Primero respeta menús y reglas del club.
- Solo usa IA cuando no entiende la consulta por reglas.
- No inventa horarios/precios/profesores; si no sabe, deriva a administración.
- Usa `OPENAI_API_KEY` desde Render Environment.
- Modelo por defecto: `gpt-4.1-mini`. Se puede cambiar con `OPENAI_MODEL`.

Importante: ChatGPT Plus no incluye crédito de API. Para que responda con IA en Render, la cuenta de OpenAI debe tener API key válida y facturación/crédito API.
