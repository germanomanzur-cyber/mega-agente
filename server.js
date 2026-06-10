import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { handleIncomingMessage, getLeads, getAndClearPendingHandoff } from "./agent.js";

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

// ─── WhatsApp: enviar mensaje ─────────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  const recipient = to.startsWith("549") ? "54" + to.substring(3) : to;
  await axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: recipient, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
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

      console.log(`[NICO/WA] Mensaje de ${from}: ${userText}`);

      const responseText = await handleIncomingMessage(from, userText);
      if (responseText === null) return;

      await sendWhatsApp(from, responseText);

      const handoffMsg = getAndClearPendingHandoff(from);
      if (handoffMsg) {
        console.log(`[NICO/WA] Handoff a Germán: ${GERMAN_WA}`);
        await sendWhatsApp(GERMAN_WA, handoffMsg);
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

          if (esConsultaInmobiliaria(texto)) {
            await responderFBMessenger(senderId, RESPUESTA_SOCIAL);
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

          if (esConsultaInmobiliaria(texto)) {
            await responderFBComment(commentId, RESPUESTA_SOCIAL);
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

          if (esConsultaInmobiliaria(texto)) {
            await responderIGMessenger(senderId, RESPUESTA_SOCIAL);
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
