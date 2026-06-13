import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { handleIncomingMessage, getLeads, getAndClearPendingHandoff, saveLeadWaName, searchLeadByName } from "./agent.js";
import { logMessage, getChats } from "./chatlog.js";

dotenv.config();

const app = express();
app.use(express.json());

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PORT,
  GERMAN_PHONE,
  PAGE_ACCESS_TOKEN,   // Token de la página de Facebook/Instagram
  FB_PAGE_ID,          // ID de la página de Facebook (ej: "germanmanzurasesorinmobiliario")
  REPORT_TOKEN: REPORT_TOKEN_ENV,
} = process.env;

const GERMAN_WA = GERMAN_PHONE || "5493424287842";
const REPORT_TOKEN = REPORT_TOKEN_ENV || VERIFY_TOKEN;

// ─── Comandos privados de Germán (solo su número) ────────────────────────────
const LOOKUP_RE = /(?:pasame|dame|mandame|buscame)?\s*(?:n[úu]mero|tel(?:[eé]fono)?|contacto|wsp|num)\s+(?:de\s+)?(.+)/i;
const LOOKUP_RE2 = /(?:qui[eé]n es|datos de|info de)\s+(.+)/i;

function parsearComandoGerman(texto) {
  if (!texto) return null;
  const t = texto.trim();
  const m1 = t.match(LOOKUP_RE);
  if (m1) return { tipo: "lookup", nombre: m1[1].trim().replace(/\?$/, "") };
  const m2 = t.match(LOOKUP_RE2);
  if (m2) return { tipo: "lookup", nombre: m2[1].trim().replace(/\?$/, "") };
  return null;
}

// ─── Respuesta automática para redes sociales ─────────────────────────────────
const RESPUESTA_SOCIAL = `¡Hola! Soy Germán Manzur de MEGA Inmobiliaria Santa Fe 🏠 Vi tu consulta y tengo propiedades disponibles en esa zona. Escribime por WhatsApp y te mando los detalles: https://wa.me/5493424287842`;

// ─── Detectar si un texto es consulta inmobiliaria ────────────────────────────
function esConsultaInmobiliaria(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  const keywords = [
    "busco", "busca", "necesito", "alquilo", "compro", "buscamos",
    "casa", "departamento", "dpto", "propiedad", "inmueble", "terreno",
    "alquiler", "venta", "compra", "zona", "ambientes", "dormitorios",
    "cochera", "patio", "jardín", "pileta", "usd", "pesos", "precio",
    "m2", "metros", "planta baja", "pb", "monoambiente"
  ];
  const matches = keywords.filter(k => t.includes(k));
  return matches.length >= 2;
}

// ─── Notificar lead caliente a n8n ──────────────────────────────────────────
const N8N_LEAD_WEBHOOK = "https://german33.app.n8n.cloud/webhook/lead-nico";

async function notificarLeadN8n(lead) {
  try {
    await axios.post(N8N_LEAD_WEBHOOK, {
      nombre: lead.nombre || "",
      numero: lead.numero || "",
      plataforma: lead.plataforma || "whatsapp",
      busqueda: lead.busqueda || "",
      zona: lead.zona || "",
      presupuesto: lead.presupuesto || "",
      nivel: lead.nivel || "",
      refs: lead.refs || "",
    });
    console.log("[NICO] Lead caliente notificado a n8n");
  } catch (e) {
    console.error("[NICO] Error notificando lead a n8n:", e.message);
  }
}

// ─── WhatsApp: enviar mensaje ─────────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  const recipient = to.startsWith("549") ? "54" + to.substring(3) : to;
  await axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: recipient, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
  if (to === GERMAN_WA) logMessage("wa", GERMAN_WA, "nico", body);
}

// ─── Facebook Messenger: responder DM ────────────────────────────────────────
async function responderFBMessenger(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("[NICO] PAGE_ACCESS_TOKEN no configurado — no se puede responder en FB");
    return;
  }
  await axios.post(
    `https://graph.facebook.com/v21.0/${FB_PAGE_ID || "me"}/messages`,
    { recipient: { id: recipientId }, message: { text: message } },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

// ─── Facebook: responder comentario ──────────────────────────────────────────
async function responderFBComment(commentId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("[NICO] PAGE_ACCESS_TOKEN no configurado — no se puede comentar en FB");
    return;
  }
  await axios.post(
    `https://graph.facebook.com/v21.0/${commentId}/comments`,
    { message },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

// ─── Instagram: responder DM ──────────────────────────────────────────────────
async function responderIGMessenger(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("[NICO] PAGE_ACCESS_TOKEN no configurado — no se puede responder en IG");
    return;
  }
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages`,
    { recipient: { id: recipientId }, message: { text: message } },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "mega-agente" });
});

// ─── Webhook: verificación (Meta — mismo endpoint para WA, FB, IG) ────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook: recepción de eventos (WA + FB + IG) ────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;
  res.sendStatus(200); // responder rápido a Meta

  try {
    // ── WhatsApp Business ──────────────────────────────────────────────────────
    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];
      if (!message) return;

      const from = message.from;
      let userText = message.text?.body || null;
      if (message.type === "audio") userText = "__AUDIO__";
      if (message.type === "image") userText = "__IMAGE__";

        // ─ Guardar nombre WA del perfil (solo leads, no Germán)
        const waProfileName = changes?.value?.contacts?.[0]?.profile?.name;
        if (waProfileName && from !== GERMAN_WA) saveLeadWaName(from, waProfileName);

        // ─ Interceptar mensajes de Germán — comandos privados
        if (from === GERMAN_WA) {
          const cmd = parsearComandoGerman(userText);
          if (cmd?.tipo === "lookup") {
            const resultados = searchLeadByName(cmd.nombre);
            let reply;
            if (resultados.length === 0) {
              reply = "No encontre leads con ese nombre. Proba nombre parcial o revisa /leads";
            } else if (resultados.length === 1) {
              const l = resultados[0];
              const nombre = l.waName || l.name || "Sin nombre";
              reply = "*" + nombre + "*\n" + "wa.me/" + l.phone + "\n" + (l.tier || "-") + " · " + (l.zona || "-") + " · " + (l.presupuesto || "-");
            } else {
              const lista = resultados.slice(0, 5).map((l) => {
                const n = l.waName || l.name || "Sin nombre";
                return "• *" + n + "* -> wa.me/" + l.phone + " (" + (l.tier || "-") + ")";
              }).join("\n");
              reply = resultados.length + " resultados para '" + cmd.nombre + "':\n" + lista;
            }
            await sendWhatsApp(GERMAN_WA, reply);
            logMessage("wa", GERMAN_WA, "nico", reply);
          }
          // si no es comando de lookup, continuar con el agente normalmente
        }

      console.log(`[NICO/WA] Mensaje de ${from}: ${userText}`);

            logMessage("wa", from, "user", userText);
const responseText = await handleIncomingMessage(from, userText);
      if (responseText === null) return;

      await sendWhatsApp(from, responseText);
      logMessage("wa", from, "nico", responseText);

      const handoffMsg = getAndClearPendingHandoff(from);
      if (handoffMsg) {
        console.log(`[NICO/WA] Handoff a Germán: ${GERMAN_WA}`);
        await sendWhatsApp(GERMAN_WA, handoffMsg);
        const lead = getLeads().find((l) => l.phone === from);
        if (lead?.tier === "caliente") {
          await notificarLeadN8n({
            nombre: lead.name || "",
            numero: from,
            plataforma: "whatsapp",
            busqueda: lead.lastMessage || "",
            zona: lead.zona || "",
            presupuesto: lead.presupuesto || "",
            nivel: lead.tier,
            refs: lead.interesEn || "",
          });
        }
      }
    }

    // ── Facebook Page (Messenger DMs + comentarios en posts) ──────────────────
    else if (body.object === "page") {
      for (const entry of body.entry || []) {
        // DMs de Messenger
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const texto = event.message?.text;
          if (!senderId || !texto) continue;

          console.log(`[NICO/FB-DM] Mensaje de ${senderId}: ${texto}`);

                    logMessage("fb", senderId, "user", texto);
if (esConsultaInmobiliaria(texto)) {
            await responderFBMessenger(senderId, RESPUESTA_SOCIAL);
                        logMessage("fb", senderId, "nico", RESPUESTA_SOCIAL);
await sendWhatsApp(GERMAN_WA,
              `📘 FB Messenger — consulta nueva:\n"${texto}"\nUserID: ${senderId}`
            );
            console.log(`[NICO/FB-DM] Respondido y alerta enviada a Germán`);
          }
        }

        // Comentarios en posts de la página
        for (const change of entry.changes || []) {
          if (change.field !== "feed") continue;
          const val = change.value;
          if (val.item !== "comment" || val.verb !== "add") continue;

          const texto = val.message;
          const commentId = val.comment_id;
          const autor = val.from?.name || "Alguien";

          console.log(`[NICO/FB-COMMENT] ${autor} comentó: ${texto}`);
          logMessage("fb", commentId, "user", texto);

          if (esConsultaInmobiliaria(texto)) {
            await responderFBComment(commentId, RESPUESTA_SOCIAL);
            logMessage("fb", commentId, "nico", RESPUESTA_SOCIAL);
            await sendWhatsApp(GERMAN_WA,
              `📘 FB Comentario — ${autor}:\n"${texto}"`
            );
            console.log(`[NICO/FB-COMMENT] Respondido y alerta enviada a Germán`);
          }
        }
      }
    }

    // ── Instagram (DMs + comentarios) ─────────────────────────────────────────
    else if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        // DMs de Instagram
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const texto = event.message?.text;
          if (!senderId || !texto) continue;

          console.log(`[NICO/IG-DM] Mensaje de ${senderId}: ${texto}`);
          logMessage("ig", senderId, "user", texto);

          if (esConsultaInmobiliaria(texto)) {
            await responderIGMessenger(senderId, RESPUESTA_SOCIAL);
            logMessage("ig", senderId, "nico", RESPUESTA_SOCIAL);
            await sendWhatsApp(GERMAN_WA,
              `📸 IG Mensaje — consulta nueva:\n"${texto}"\nIGSID: ${senderId}`
            );
            console.log(`[NICO/IG-DM] Respondido y alerta enviada a Germán`);
          }
        }

        // Comentarios en posts de Instagram
        for (const change of entry.changes || []) {
          if (change.field !== "comments") continue;
          const val = change.value;
          const texto = val.text;
          const mediaId = val.media?.id;
          const autor = val.from?.username || "alguien";

          console.log(`[NICO/IG-COMMENT] @${autor} comentó en ${mediaId}: ${texto}`);

          if (esConsultaInmobiliaria(texto)) {
            await sendWhatsApp(GERMAN_WA,
              `📸 IG Comentario — @${autor}:\n"${texto}"\nPost: ${mediaId}`
            );
            console.log(`[NICO/IG-COMMENT] Alerta enviada a Germán`);
          }
        }
      }
    }

  } catch (error) {
    console.error("[NICO] Error en webhook:", error.response?.data || error.message);
  }
});

// ─── Panel de leads ───────────────────────────────────────────────────────────
app.get("/leads", (req, res) => {
  const token = req.query.token;
  if (token !== VERIFY_TOKEN) return res.status(401).json({ error: "No autorizado" });
  const leads = getLeads();
  const stats = {
    total: leads.length,
    calientes: leads.filter((l) => l.tier === "caliente").length,
    tibios: leads.filter((l) => l.tier === "tibio").length,
    frios: leads.filter((l) => l.tier === "frio").length,
  };
  res.json({ stats, leads: leads.slice(-50) });
});

// ─── Endpoint reporte externo (radar inmobiliario) ───────────────────────────
app.post("/report", async (req, res) => {
  const { token, message } = req.body || {};
  if (!token || token !== REPORT_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  if (!message) {
    return res.status(400).json({ error: "message requerido" });
  }
  try {
    await sendWhatsApp(GERMAN_WA, message);
    console.log(`[NICO] Reporte enviado a Germán (${GERMAN_WA})`);
    res.json({ ok: true });
  } catch (error) {
    console.error("[NICO] Error enviando reporte:", error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT || 3000, () => {
  console.log(`🟢 MEGA Agente Nico activo en puerto ${PORT || 3000}`);
  console.log(`   WA alerts → ${GERMAN_WA}`);
  console.log(`   Social media: ${PAGE_ACCESS_TOKEN ? "✅ configurado" : "⚠️  PAGE_ACCESS_TOKEN no configurado"}`);
});

// --- Politica de privacidad (requerida para publicar la app Meta) ---
app.get("/privacy", (req, res) => {
  res.send('<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Politica de Privacidad - MEGA Agente</title><style>body{font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#222;line-height:1.6}h1{color:#0a7d54}h2{margin-top:28px}</style></head><body><h1>Politica de Privacidad — MEGA Agente (Nico)</h1><p>Ultima actualizacion: junio 2026</p><p>MEGA Agente ("Nico") es un asistente virtual inmobiliario operado por German Manzur, asesor de MEGA Inmobiliaria, Santa Fe, Argentina.</p><h2>Datos que recopilamos</h2><p>Al conversar con Nico por WhatsApp, Facebook Messenger o Instagram recopilamos: nombre, numero de telefono o identificador de la plataforma, el contenido de los mensajes enviados y sus preferencias de busqueda inmobiliaria.</p><h2>Uso de los datos</h2><p>Usamos estos datos exclusivamente para responder consultas, recomendar propiedades y dar seguimiento comercial. No vendemos ni compartimos sus datos con terceros, salvo los proveedores tecnologicos necesarios para operar el servicio (Meta Platforms, OpenAI y Railway).</p><h2>Conservacion</h2><p>Los datos se conservan mientras exista una relacion comercial activa o hasta que usted solicite su eliminacion.</p><h2>Eliminacion de datos</h2><p>Puede solicitar la eliminacion de sus datos escribiendo ELIMINAR MIS DATOS en el chat, o contactando a germanomanzur@gmail.com o al WhatsApp +54 9 342 428-7842. Procesamos las solicitudes dentro de los 30 dias.</p><h2>Contacto</h2><p>German Manzur — germanomanzur@gmail.com — WhatsApp +54 9 342 428-7842 — Santa Fe, Argentina.</p></body></html>');
});

// --- Panel de conversaciones (protegido con ?token=VERIFY_TOKEN) ---
app.get("/chats.json", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.status(401).json({ error: "No autorizado" });
  res.json(getChats());
});

app.get("/chats", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.status(401).send("No autorizado");
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nico - Conversaciones</title><style>
*{box-sizing:border-box;margin:0}body{font-family:Arial,Helvetica,sans-serif;height:100vh;display:flex;flex-direction:column;background:#ece5dd}
header{background:#075e54;color:#fff;padding:12px 18px;font-size:17px;font-weight:bold}
#wrap{flex:1;display:flex;min-height:0}
#side{width:320px;background:#fff;border-right:1px solid #ddd;overflow-y:auto}
.conv{padding:12px 14px;border-bottom:1px solid #eee;cursor:pointer}
.conv:hover{background:#f5f5f5}.conv.sel{background:#e8f5e9}
.conv .who{font-weight:bold;font-size:14px}.conv .prev{color:#666;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv .meta{color:#999;font-size:11px;margin-top:2px}
#main{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:6px}
.msg{max-width:70%;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}
.msg .at{display:block;font-size:10px;color:#777;margin-top:4px;text-align:right}
.user{background:#fff;align-self:flex-start}
.nico{background:#dcf8c6;align-self:flex-end}
#empty{color:#888;margin:auto}
</style></head><body>
<header>Nico &mdash; Conversaciones</header>
<div id="wrap"><div id="side"></div><div id="main"><div id="empty">Cargando...</div></div></div>
<script>
var DATA={},SEL=null;
var TOKEN=new URLSearchParams(location.search).get("token");
function fmt(s){var d=new Date(s);return d.toLocaleDateString("es-AR")+" "+d.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});}
function load(){fetch("/chats.json?token="+TOKEN).then(function(r){return r.json()}).then(function(d){DATA=d;render();});}
function render(){
var side=document.getElementById("side");side.innerHTML="";
var keys=Object.keys(DATA).sort(function(a,b){var ma=DATA[a].messages,mb=DATA[b].messages;return new Date(mb[mb.length-1].at)-new Date(ma[ma.length-1].at);});
keys.forEach(function(k){var c=DATA[k];var last=c.messages[c.messages.length-1];
var div=document.createElement("div");div.className="conv"+(k===SEL?" sel":"");
var who=document.createElement("div");who.className="who";who.textContent=(c.channel==="wa"?"WhatsApp ":"Messenger ")+c.userId;
var prev=document.createElement("div");prev.className="prev";prev.textContent=last.text;
var meta=document.createElement("div");meta.className="meta";meta.textContent=c.messages.length+" mensajes - "+fmt(last.at);
div.appendChild(who);div.appendChild(prev);div.appendChild(meta);
div.onclick=function(){SEL=k;render();};side.appendChild(div);});
var main=document.getElementById("main");main.innerHTML="";
if(!SEL||!DATA[SEL]){var e=document.createElement("div");e.id="empty";e.textContent=keys.length?"Selecciona una conversacion":"Sin conversaciones todavia";main.appendChild(e);return;}
DATA[SEL].messages.forEach(function(m){var d=document.createElement("div");d.className="msg "+(m.role==="nico"?"nico":"user");d.textContent=m.text;
var at=document.createElement("span");at.className="at";at.textContent=(m.role==="nico"?"Nico - ":"")+fmt(m.at);d.appendChild(at);main.appendChild(d);});
main.scrollTop=main.scrollHeight;}
load();setInterval(load,8000);
</script></body></html>`);
});
