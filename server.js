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
} = process.env;

const GERMAN_WA = GERMAN_PHONE || "5493424287842";

async function sendWhatsApp(to, body) {
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

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "mega-agente" });
});

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

app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  let userText = message.text?.body || null;

  if (message.type === "audio") userText = "__AUDIO__";
  if (message.type === "image") userText = "__IMAGE__";

  console.log(`[NICO] Mensaje de ${from}: ${userText}`);

  try {
    const responseText = await handleIncomingMessage(from, userText);

    if (responseText === null) return res.sendStatus(200);

    await sendWhatsApp(from, responseText);

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

app.listen(PORT || 3000, () => {
  console.log(`🟢 MEGA Agente Nico activo en puerto ${PORT || 3000}`);
  console.log(`   Alerts de leads → WA ${GERMAN_WA}`);
});
