# Panchito v52 - Fase 6 Conversación inteligente

Cambios aplicados sobre la versión subida:

- Motor de conversación inteligente antes de caer en menús rígidos.
- Detecta deporte + edad + intención en una misma frase.
- Ejemplo: "Mi hijo tiene 11 años y quiere jugar al fútbol".
- Recomienda categoría real cargada y respeta rama masculino/femenino.
- Si el usuario después escribe "horarios", "costo", "inscripción" o "profe", responde usando el contexto guardado.
- Si el usuario cambia de deporte, cambia el contexto automáticamente.
- Correcciones de escritura agregadas: fubol/futbool, bascket/basquett, natacoin, insripcion.
- No pisa la consulta de deuda/cuota social: "quiero saber si debo cuota" sigue pidiendo DNI/socio.

Comandos:

npm install
npm run dev

Para instalador Windows:

npm run dist:win
