import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { handleIncomingMessage } from "./agent.js";

dotenv.config();

const app = express();
app.use(express.json());

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PORT
} = process.env;
// Health check para Railway
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "mega-agente" });
});

// Webhook de verificación para Meta
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

// Recepción de mensajes
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (message) {
    const from = message.from;
    const text = message.text?.body;

    console.log(`Mensaje recibido de ${from}: ${text}`);

    // Normalizar número Argentina: quitar el 9 para Meta
    const to = from.startsWith("549") ? "54" + from.substring(3) : from;

    try {
      // Procesar con agent.js (pre-filtros + OpenAI)
      const responseText = await handleIncomingMessage(from, text);

      // Si es null (spam repetido) no responder
      if (responseText === null) {
        return res.sendStatus(200);
      }

      // Enviar respuesta a WhatsApp
      await axios.post(
        `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: to,
          type: "text",
          text: { body: responseText },
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
      );

    } catch (error) {
      console.error("Error procesando el mensaje:", error.response?.data || error.message);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT || 3000, () => {
  console.log(`MEGA Agente activo en puerto ${PORT || 3000}`);
});
