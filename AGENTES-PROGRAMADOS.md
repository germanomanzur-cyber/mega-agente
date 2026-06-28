# 🤖 Agentes programados de Nico (migrados de Claude → plataforma Abacus)

> Memoria de configuración. Todo corre como **tareas programadas (daemons) en código puro, cero tokens LLM**.
> Producción: https://mega-agente-production.up.railway.app
> Repo: github.com/germanomanzur-cyber/mega-agente (público)
> Token único de lectura/reporte: `mega-radar-2024`

---

## Las 4 tareas activas

| # | Tarea | Frecuencia | Horario (AR) | Script | Qué hace |
|---|-------|-----------|--------------|--------|----------|
| 1 | **Nico - Sync inventario web** | Diaria | 04:00 | `tasks/sync-inventario.mjs` | Scrapea inmobiliariamega.com.ar (302 props), reescribe SOLO la sección `## INVENTARIO COMPLETO MEGA WEB` del `knowledge-base.md`, commitea a `main` SOLO si hay cambios y avisa por WhatsApp |
| 2 | **Nico - Monitor diario** | Diaria | 05:30 | `tasks/monitor-diario.mjs` | Chequea `/health`, resume conversaciones de ayer/hoy (🔴 caliente / 🟡 tibio / ⚪ frío), detecta códigos REF y derivaciones, manda resumen por WhatsApp. Si Nico está caído → avisa incidente |
| 3 | **Nico - Reporte semanal de leads** | Semanal (lunes) | 08:00 | `tasks/reporte-leads.py` | Lee leads de últimos 7 días, arma Excel (hoja Leads + hoja Resumen), lo surfacea en la UI |
| 4 | **Recordatorio: revisar token GitHub nico-railway-sync** | Mensual (día 1) | 09:00 | — | Recuerda renovar el token `nico-railway-sync` (el de n8n) antes que expire, con pasos |

**Nota de horarios:** sync (04:00) corre después del n8n (03:00) para no pisarse; monitor (05:30) corre después del sync para tener datos frescos.

---

## Variables de entorno que usan las tareas

```
REPORT_URL=https://mega-agente-production.up.railway.app
REPORT_TOKEN=mega-radar-2024
GERMAN_PHONE=5493424287842
REPO=germanomanzur-cyber/mega-agente
# Solo el sync necesita además GITHUB_TOKEN (token fresco vía Git_Tool en cada corrida, para poder commitear)
```

---

## Cambio en `server.js` (PR #8)

Se agregó el helper `tokenLecturaValido()`: los endpoints de solo lectura (`/leads`, `/chats.json`, `/chats`) ahora aceptan **tanto `VERIFY_TOKEN` como `REPORT_TOKEN`**. Así todas las tareas usan un solo token (`mega-radar-2024`).
> Requiere redeploy en Railway para tomar efecto. ✅ YA DEPLOYADO Y FUNCIONANDO.

---

## Qué NO se toca

- **Workflow n8n "Recompilador Cartera→Qdrant" (03:00):** sigue corriendo igual, mantiene la cartera prioritaria de Germán en el `knowledge-base.md` (todo lo que está ANTES de la sección INVENTARIO). El sync de las 04:00 NUNCA toca esa parte.
- **Token `nico-railway-sync`:** es el token de GitHub que usa n8n (NO confundir con el token fresco que usa el daemon de sync). Renovarlo cada ~1 año.

### Cómo renovar el token de n8n (si vence)
1. Ir a https://github.com/settings/personal-access-tokens
2. Buscar `nico-railway-sync`
3. Regenerar con: **Expiration = 1 year**, **Repository access = Only select = germanomanzur-cyber/mega-agente**, **Permissions → Contents = Read and write**
4. Copiar el nuevo token (`ghu_...`) y pegarlo en la credencial **"GitHub account"** del panel n8n: https://n8n-production-65677.up.railway.app
5. Guardar

---

_Última actualización: 28/06/2026 — migración completa de los 4 agentes de Claude._
