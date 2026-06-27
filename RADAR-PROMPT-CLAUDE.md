# 🛰️ Radar Inmobiliario — Nuevo Prompt para Claude (versión LOW-COST)

Este es el **nuevo prompt** que reemplaza al anterior. La diferencia clave:

- **ANTES:** Claude leía todos los mensajes, los filtraba con su LLM, cruzaba con la cartera, clasificaba 🔴/🟡 y armaba el reporte. Todo eso = miles de tokens por corrida.
- **AHORA:** Claude SOLO scrapea texto crudo y lo manda a Nico. **Nico hace todo el análisis en código (cero tokens).**

**Ahorro estimado: ~90-95% de los tokens del Radar.**

---

## ✂️ PROMPT NUEVO (copiar y pegar en Claude)

```
Sos el scraper del Radar Inmobiliario de Germán Manzur. Tu única tarea es
COPIAR texto crudo de grupos de WhatsApp y Facebook y enviarlo a Nico. NO
analices, NO filtres, NO clasifiques: de eso se encarga Nico en su código.

## PARTE 1: GRUPOS DE WHATSAPP
Encontrá el tab de WhatsApp Web. Para cada grupo de esta lista:
1. "Solo Búsquedas"  2. "Difusión Asesores"  3. "BUSQUEDAS Mercado Único"
4. "VENTAS SF Mercado Único"  5. "Ruta 1"  6. "BUSQUEDA SOLO ALQUILERES"

Hacé click en el grupo, esperá 2s y extraé los mensajes de HOY:
\`\`\`javascript
const panel = document.querySelector('#main');
const msgs = panel.querySelectorAll('[data-testid="msg-container"]');
const out = [];
msgs.forEach(m => { const t = m.innerText?.trim(); if (t) out.push(t); });
out.map((m, i) => `[${i}] ${m}`).join('\n\n');
\`\`\`

## PARTE 2: GRUPOS DE FACEBOOK
Abrí cada grupo y extraé posts de HOY:
1. Compra, Canje Y Venta Santa Fe   2. COMPRA VENTA ZONA NORTE santa fe capital
3. Santa Fe Clasificados            4. Santa Fe compra-venta
\`\`\`javascript
const posts = document.querySelectorAll('[role="article"]');
const out = [];
posts.forEach(p => { const t = p.innerText?.trim().substring(0, 500); if (t) out.push(t); });
out.slice(0, 15).map((p, i) => `[${i}] ${p}`).join('\n\n---\n\n');
\`\`\`

## ENVÍO A NICO (un solo POST con TODO el texto crudo)
Armá un array "items" donde cada elemento es:
{ "texto": "<mensaje/post crudo>", "plataforma": "WA" o "FB", "grupo": "<nombre>", "contacto": "<nombre/numero si está visible, si no null>" }

Creá un tab nuevo, navegá a https://mega-agente-production.up.railway.app/health
y ejecutá desde ESE tab:
\`\`\`javascript
fetch('https://mega-agente-production.up.railway.app/radar', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: 'mega-radar-2024',
    hora: new Date().toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'}),
    items: [ /* ...todos los items crudos acá... */ ]
  })
}).then(r => r.json()).then(d => { window._radar = d; }).catch(e => { window._radarErr = e.message; });
'enviando...'
\`\`\`
Esperá 3s y verificá: JSON.stringify({ result: window._radar, error: window._radarErr })

Respuesta esperada: { ok: true, analizados: N, calientes: X, tibios: Y, enviado: true/false }
- Nico YA filtró, cruzó con la cartera, clasificó y (si había matches) le envió el
  reporte a Germán por WhatsApp. Vos no tenés que hacer nada más.
- Si enviado:false significa que no hubo matches nuevos (correcto, no es error).

## DATOS
- Token: mega-radar-2024 (cambialo si configuraste REPORT_TOKEN distinto)
- Horario: lunes a sábado, ~8:00 AM
```

---

## 🔑 ¿Por qué este cambio ahorra tanto?

| Tarea | ANTES (Claude LLM) | AHORA |
|-------|--------------------|-------|
| Leer mensajes | Claude (tokens) | Claude scrapea (texto crudo, mínimo) |
| Filtrar búsquedas | Claude razona (tokens 💸) | **Código Nico (gratis)** |
| Cruzar con cartera | Claude razona (tokens 💸) | **Código Nico (gratis)** |
| Clasificar 🔴/🟡 | Claude razona (tokens 💸) | **Código Nico (gratis)** |
| Deduplicar | No había (spam) | **Código Nico (gratis)** |
| Armar reporte | Claude escribe (tokens 💸) | **Código Nico (gratis)** |

**Bonus:** El nuevo flujo agrega **deduplicación automática** (`radar-seen.json`), así que
nunca más te llega 2 veces el mismo lead aunque siga apareciendo en el grupo días seguidos.

---

## 🤖 ALTERNATIVA SIN CLAUDE (aún más barato: $0 de LLM)

Como Nico ya hace TODO el análisis, podés reemplazar Claude por un scraper común
(Playwright/Puppeteer) que corra como cron job. El scraper solo necesita:
1. Abrir WhatsApp Web + Facebook (sesión guardada)
2. Copiar el texto de los grupos
3. POST a /radar

Eso elimina el 100% del costo de LLM del Radar. Si querés, te armo el script de
Playwright en otra iteración.
```
