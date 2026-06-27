# 🏠 MEGA Agente WhatsApp — Nico

**Stack:** Node.js + Groq LLM (GPT-OSS 20B) + Meta WhatsApp Cloud API  
**Asesor:** Germán Manzur — MEGA Desarrollos Inmobiliarios, Santa Fe

**Nico** es un asistente virtual de WhatsApp que califica leads inmobiliarios en tiempo real, deriva contactos calientes a Germán Manzur, y responde consultas frecuentes **sin consumir tokens del LLM** (ahorro 60-75% vs. configuración inicial).

---

## 📋 REQUISITOS PREVIOS

- Node.js v18 o superior → https://nodejs.org
- **Cuenta de Groq** (LLM ultrarrápido, free tier disponible) → https://console.groq.com
- Cuenta de Meta for Developers → https://developers.facebook.com
- Un número de WhatsApp Business (puede ser el mismo que usás)
- Un servidor con URL pública (Railway, Render, Fly.io o VPS)

---

## ⚙️ PASO 1 — INSTALACIÓN LOCAL

```bash
# 1. Clonar o copiar la carpeta del proyecto
cd mega-whatsapp-agent

# 2. Instalar dependencias
npm install

# 3. Copiar el archivo de variables de entorno
cp .env.example .env

# 4. Editar .env con tus claves reales
nano .env   # o abrí con tu editor preferido
```

---

## 🔑 PASO 2 — OBTENER LAS CLAVES

### Groq API Key (LLM ultrarrápido y económico)
1. Entrá a https://console.groq.com/keys
2. Hacé clic en "Create API Key"
3. Copiá y pegala en `.env` → `GROQ_API_KEY`
4. **Free tier:** 30 requests/minuto, sin tarjeta de crédito (perfecto para empezar)

### Meta WhatsApp Cloud API
1. Entrá a https://developers.facebook.com
2. Creá una nueva App → tipo "Business"
3. Agregá el producto **WhatsApp** a tu app
4. En **WhatsApp > API Setup**:
   - Anotá el `Phone Number ID` → pegalo en `.env` → `WHATSAPP_PHONE_NUMBER_ID`
   - Generá un token de acceso permanente → pegalo en `.env` → `WHATSAPP_ACCESS_TOKEN`

---

## 🌐 PASO 3 — EXPONER EL SERVIDOR (WEBHOOK)

Meta necesita una URL pública HTTPS para enviarte los mensajes.

### Opción A — Railway (recomendado, gratis para empezar)
```bash
# Instalá Railway CLI
npm install -g @railway/cli

# Login y deploy
railway login
railway init
railway up
```
Railway te dará una URL tipo: `https://mega-agent-xxxx.railway.app`

### Opción B — Render (también gratuito)
1. Subí el proyecto a GitHub
2. Creá un nuevo "Web Service" en https://render.com
3. Render te da una URL pública automáticamente

### Opción C — ngrok (solo para pruebas locales)
```bash
npm install -g ngrok
ngrok http 3000
# Usá la URL https que te da ngrok (cambia cada vez que reiniciás)
```

---

## 📡 PASO 4 — CONFIGURAR EL WEBHOOK EN META

1. En el panel de Meta → **WhatsApp > Configuration > Webhook**
2. Hacé clic en **Edit**
3. Completá:
   - **Callback URL:** `https://tu-url-publica.com/webhook`
   - **Verify Token:** el mismo valor que pusiste en `.env` → `VERIFY_TOKEN`
4. Hacé clic en **Verify and Save**
5. En **Webhook fields**, suscribite a: `messages`

---

## 🚀 PASO 5 — INICIAR EL AGENTE

```bash
# Producción
npm start

# Desarrollo (con auto-reload)
npm run dev
```

Verificá que funcione visitando: `https://tu-url/` → debería mostrar `🟢 MEGA Agente WhatsApp — Activo`

---

## 🧪 PASO 6 — PRUEBA FINAL

1. Desde cualquier celular, mandá un WhatsApp al número configurado
2. El agente debe responder en segundos
3. Revisá los logs del servidor para ver los mensajes procesados

---

## 💡 FUNCIONALIDADES DEL AGENTE

| Función | Detalle |
|---|---|
| ✅ Calificación de leads | Detecta automáticamente leads fríos/tibios/calientes |
| ✅ Respuestas instantáneas sin LLM | FAQ para consultas frecuentes (contacto, créditos, permutas) → ahorro directo de tokens |
| ✅ Caché de respuestas | Detecta consultas duplicadas y reutiliza respuestas → ahorro adicional |
| ✅ Memoria de conversación | Persistencia en disco, sobrevive a redeploys de Railway |
| ✅ Derivación automática | Leads calientes se envían a Germán +54 342 428-7842 |
| ✅ Transcripción de audio | Whisper v3 Turbo de Groq (2.8x más barato que v3 estándar) |
| ✅ Follow-up automático | Recordatorio a leads tibios sin actividad (comando `//followup` o cron job) |
| ✅ Panel de control | Comandos `//stats`, `//leads`, `//calientes` para Germán |

---

## 💰 COSTOS ESTIMADOS

### Modelo LLM (Groq GPT-OSS 20B)
- **Input:** $0.075 por millón de tokens
- **Output:** $0.30 por millón de tokens
- **Prompt caching automático:** 50% descuento en tokens repetidos (hasta 2h)
- **Whisper v3 Turbo:** $0.04 por hora de audio transcrito

### Ahorro vs. Configuración Original
- **Modelo 120B → 20B:** 50% más barato
- **FAQ + Response cache:** evita ~28% de llamadas al LLM
- **Prompt caching:** ~35% adicional en tokens de input
- **Ahorro total: 60-75%** del costo original

### Costo Real Mensual
- **100 mensajes/día:** ~$1.50/mes (vs. $5/mes antes)
- **300 mensajes/día:** ~$4.50/mes (vs. $15/mes antes)
- **Free tier de Groq:** suficiente para empezar sin tarjeta de crédito
- **Railway / Render:** plan gratuito incluye 500 horas/mes

---

## 🛠️ COMANDOS DE ADMINISTRACIÓN (SOLO PARA GERMÁN)

Si escribís a Nico desde el número configurado como propietario (`+54 342 428-7842`), podés usar estos comandos:

| Comando | Función |
|---|---|
| `//stats` | Resumen: total de leads, calientes/tibios/fríos, % conversión, top 3 zonas |
| `//leads` | Últimos 10 leads registrados |
| `//calientes` | Últimos 10 leads calientes con zona y presupuesto |
| `//agentes` | Agentes inmobiliarios guardados |
| `//tel <nombre>` | Busca un lead o agente por nombre |
| `//followup` | Envía recordatorio automático a leads tibios sin actividad (2+ días) |
| `//ayuda` | Lista de comandos disponibles |

**Nota:** El comando `//followup` también se puede ejecutar manualmente desde el servidor:
```bash
node follow-up-tibios.js
```

O configurar como **cron job diario** en Railway (Settings > Cron Jobs) para automatizar el seguimiento.

---

## ❓ PROBLEMAS FRECUENTES

**El webhook no se verifica:**
→ Asegurate de que el servidor esté corriendo y la URL sea HTTPS pública
→ Verificá que `VERIFY_TOKEN` en `.env` sea idéntico al que pusiste en Meta

**El agente no responde:**
→ Revisá que `WHATSAPP_ACCESS_TOKEN` no haya expirado (generá uno permanente)
→ Revisá los logs: `npm start` muestra todos los errores

**Respuestas lentas:**
→ Normal en planes gratuitos (cold start). Upgradeá a plan pago si es necesario

---

## 📞 SOPORTE

Germán Manzur — MEGA Desarrollos Inmobiliarios  
WhatsApp: +54 342 428-7842
