# 🏠 MEGA Agente WhatsApp — Guía de Instalación

**Stack:** Node.js + OpenAI GPT-4o mini + Meta WhatsApp Cloud API  
**Asesor:** Germán Manzur — MEGA Desarrollos Inmobiliarios, Santa Fe

---

## 📋 REQUISITOS PREVIOS

- Node.js v18 o superior → https://nodejs.org
- Cuenta de OpenAI con crédito → https://platform.openai.com
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

### OpenAI API Key
1. Entrá a https://platform.openai.com/api-keys
2. Hacé clic en "Create new secret key"
3. Copiá y pegala en `.env` → `OPENAI_API_KEY`

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
| ✅ Consultas sobre cartera | Ventas, alquileres, inversión, créditos |
| ✅ Memoria de conversación | Recuerda el contexto por 2 horas |
| ✅ Derivación automática | Redirige a +54 342 428-7842 cuando es necesario |
| ✅ Mensajes no-texto | Responde educadamente y deriva al asesor |
| ✅ Control de costos | Historial limitado a 20 mensajes por sesión |

---

## 💰 COSTOS ESTIMADOS

- **GPT-4o mini:** ~$0.15 por millón de tokens de entrada / $0.60 por millón de salida
- Estimado real: **menos de USD 5/mes** con 200-300 conversaciones mensuales
- **Railway / Render:** plan gratuito suficiente para comenzar

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
