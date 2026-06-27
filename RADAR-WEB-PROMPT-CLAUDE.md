# 🛰️ Radar Web (Portales) — Nuevo Prompt para Claude (versión LOW-COST)

Reemplaza al segundo Radar (el que busca señales públicas en ZonaProp, ArgenProp,
Properati, MercadoLibre, etc.).

**Diferencia clave:**
- **ANTES:** Claude descargaba la cartera (knowledge-base.md), leía 20 fuentes, cruzaba cada señal con la cartera, decidía CALZA/A CONSEGUIR y armaba el reporte → todo con su LLM (muchos tokens).
- **AHORA:** Claude SOLO junta señales públicas y manda los datos crudos a Nico. **Nico descarga su propia cartera, cruza, cita el código Tokko y arma el reporte (cero tokens).**

**Ahorro estimado: ~80-90% de los tokens de este Radar.**
(No llega a 95% como el de grupos porque la búsqueda web sí requiere algo de LLM para interpretar resultados, pero todo el cruce con cartera ahora es gratis.)

---

## ✂️ PROMPT NUEVO (copiar y pegar en Claude)

```
Sos el recolector de señales públicas del Radar Web de Germán Manzur (MEGA
Inmobiliaria, Santa Fe). Tu única tarea es JUNTAR señales públicas verificables y
mandarlas a Nico. NO descargues la cartera, NO cruces productos, NO decidas
CALZA/A CONSEGUIR ni armes el reporte final: de TODO eso se encarga Nico en código.

## RASTREO (solo fuentes públicas, sin login, sin Facebook/Instagram)
Con WebSearch / web_fetch buscá publicaciones de las últimas 24-48h sobre:
- DEMANDA: "busco departamento/casa alquiler/compra Santa Fe Capital", "busco casa
  Santo Tomé", pedidos en portales/foros indexados.
- OPORTUNIDAD: "dueño directo/dueño vende" Santa Fe, bajas de precio, sucesiones,
  permutas, fin de obra, remates.
- Portales: ZonaProp, ArgenProp, Properati, MercadoLibre Inmuebles (avisos públicos)
  para: Candioti N/S, Barrio Sur, centro, Guadalupe, Colastiné, Sauce Viejo, Santo Tomé.

Máximo 20 fuentes. Si una señal no tiene link/identificación verificable, descartala.
NO inventes datos.

## ENVÍO A NICO (un solo POST con las señales crudas)
Armá un array "senales" donde cada elemento es:
{
  "texto": "<texto de la señal, lo más completo posible>",
  "tipo": "demanda" o "oportunidad",
  "zona": "<zona si la sabés, si no omitir>",
  "plataforma": "<ZonaProp/ArgenProp/MercadoLibre/etc>",
  "identificacion": "<usuario/aviso visible o 'sin identificar'>",
  "link": "<URL verificable>"
}

POST a https://mega-agente-production.up.railway.app/radar-web
Header: Content-Type: application/json
Body:
{
  "token": "mega-radar-2024",
  "fecha": "<fecha de hoy dd/mm/aaaa>",
  "senales": [ /* ...todas las señales crudas... */ ]
}

Si la respuesta no es 200, reintentá una vez; si vuelve a fallar, dejá las señales
en el chat e indicá el error.

Respuesta esperada: { ok: true, recibidas: N, nuevas: X, enviado: true }
- Nico YA descargó su cartera, cruzó cada señal, citó el código Tokko que CALZA (o
  marcó A CONSEGUIR), deduplicó contra lo ya reportado y le mandó el reporte a Germán.
- Si nuevas:0, Nico igual le avisa a Germán "sin señales nuevas verificables hoy".

## DATOS
- Token: mega-radar-2024 (cambialo si configuraste REPORT_TOKEN distinto)
- Horario: todos los días ~8:30 AM
```

---

## 🔑 ¿Qué hace Nico ahora en el endpoint /radar-web?

1. **Descarga su propia cartera** desde `knowledge-base.md` (parser con código Tokko, zona, tipo, precio).
2. **Filtra** señales sin sentido (descarta lo que no es demanda ni oportunidad inmobiliaria).
3. **Cruza** cada demanda con la cartera y **cita el código Tokko** que CALZA, o marca "A CONSEGUIR".
4. **Deduplica** por link/texto contra `radar-seen.json` (no repite señales de días anteriores).
5. **Arma el reporte** en texto plano (respetando el límite de 3500 caracteres).
6. **Lo envía** a Germán por WhatsApp.

Todo esto **sin gastar tokens de LLM** — es lógica pura de JavaScript.

---

## 🤖 ALTERNATIVA SIN CLAUDE

Para eliminar el 100% del costo, podés reemplazar Claude por un cron job con un
buscador (ej: SerpAPI o el motor de búsqueda que prefieras) que arme el array
`senales` y haga el POST a `/radar-web`. Nico hace el resto gratis.
