import "dotenv/config";
import express from "express";
import { handleIncomingMessage } from "./agent.js";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mega_inmobiliaria_token";

// ─── Verificación del webhook (Meta requiere este paso) ───────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    return res.status(200).send(challenge);
  }
  console.warn("⚠️  Token de verificación incorrecto");
  res.sendStatus(403);
});

// ─── Recepción de mensajes entrantes ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Confirmar recepción a Meta inmediatamente (evita reintentos)
  res.sendStatus(200);

  try {
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignorar notificaciones de estado (delivered, read, etc.)
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message) return;

    // Solo procesar mensajes de texto
    if (message.type !== "text") {
      await sendWhatsAppMessage(
        message.from,
        "Por el momento solo proceso mensajes de texto. Para consultas por imagen o audio, contactate con Germán al *+54 342 428-7842*."
      );
      return;
    }

    const from = message.from;
    const text = message.text.body;

    console.log(`📩 Mensaje de ${from}: ${text}`);

    const reply = await handleIncomingMessage(from, text);
    await sendWhatsAppMessage(from, reply);

  } catch (error) {
    console.error("❌ Error procesando mensaje:", error.message);
  }
});

// ─── Enviar mensaje por Meta Cloud API ───────────────────────────────────────
export async function sendWhatsAppMessage(to, text) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("❌ Error enviando mensaje a WhatsApp:", err);
  } else {
    console.log(`✅ Mensaje enviado a ${to}`);
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("🟢 MEGA Agente WhatsApp — Activo"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
