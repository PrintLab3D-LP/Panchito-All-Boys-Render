# v51 - Motor de categorías reales por edad y rama

Mejora aplicada:

- No recomienda categorías inventadas.
- Respeta la rama/género del recorrido elegido.
  - Si el usuario viene por fútbol masculino, no recomienda femenino.
  - Si viene por fútbol femenino, no recomienda masculino.
  - En básquet respeta masculino/femenino cuando ya fue elegido.
- Si la edad es demasiado baja, no fuerza una categoría.
  - Ejemplo: fútbol con 1 año indica que todavía no hay categoría real disponible.
- La recomendación se calcula contra categorías existentes en `data/db.json`.

Ejemplos corregidos:

- Fútbol > Cuarta/Quinta/Sexta + 1 año → no recomienda Femenino Sub 11/Sub 12.
- Básquet Masculino Sub 15 + 11 años → recomienda la categoría masculina real más cercana, no una femenina.
- Si no hay categoría real para la edad, deriva a coordinación/administración.
