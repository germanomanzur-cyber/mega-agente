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
  GERMAN_PHONE, // número de Germán para recibir alerts: 5493424287842
} = process.env;

// Número de Germán (fallback si no está en .env)
const GERMAN_WA = GERMAN_PHONE || "5493424287842";

// ─── Función para enviar mensaje de WA (reusable) ─────────────────────────────
async function sendWhatsApp(to, body) {
  // Meta API: para Argentina quitar el 9 intermedio si el número empieza con 549
  const recipient = to.startsWith("549") ? "54" + to.substring(3) : to;
  await axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "text",
      text: { body },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "mega-agente" });
});

// ─── Webhook verificación (Meta) ──────────────────────────────────────────────
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

// ─── Webhook recepción de mensajes ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  let userText = message.text?.body || null;

  // Normalizar mensajes de audio e imagen
  if (message.type === "audio") userText = "__AUDIO__";
  if (message.type === "image") userText = "__IMAGE__";

  console.log(`[NICO] Mensaje de ${from}: ${userText}`);

  try {
    // Procesar con agent.js
    const responseText = await handleIncomingMessage(from, userText);

    // Spam silencioso — no responder
    if (responseText === null) return res.sendStatus(200);

    // Responder al lead
    await sendWhatsApp(from, responseText);

    // Verificar si hay un handoff pendiente para Germán
    const handoffMsg = getAndClearPendingHandoff(from);
    if (handoffMsg) {
      console.log(`[NICO] Enviando handoff a Germán: ${GERMAN_WA}`);
      await sendWhatsApp(GERMAN_WA, handoffMsg);
    }
  } catch (error) {
    console.error("[NICO] Error:", error.response?.data || error.message);
  }

  res.sendStatus(200);
});

// ─── Panel de leads (solo para Germán) ───────────────────────────────────────
// Acceso: GET /leads?token=TU_VERIFY_TOKEN
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

  res.json({ stats, leads: leads.slice(-50) }); // últimos 50 leads
});

// ─── Endpoint de reporte externo (radar inmobiliario) ────────────────────────
// POST /report  { "token": "...", "message": "..." }
// Usado por el radar automático para enviarle alertas a Germán por WA
app.post("/report", async (req, res) => {
  const { token, message } = req.body || {};
  const REPORT_TOKEN = process.env.REPORT_TOKEN || VERIFY_TOKEN;

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
  console.log(`   Alerts de leads → WA ${GERMAN_WA}`);
});
