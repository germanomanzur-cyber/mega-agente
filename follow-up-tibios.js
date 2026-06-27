// follow-up-tibios.js — Recordatorio automático a leads tibios sin actividad reciente.
//
// Detecta leads tibios que no han contestado en 2-3 días y les envía un mensaje
// amable de recordatorio por WhatsApp. SIN consumir tokens del LLM (texto fijo).
// Pensado para ejecutar como cron job diario (ej: Railway scheduled task, cron
// en server Linux, o llamado manual desde //followup en modo Germán).

import { getLeads } from "./agent.js";
import axios from "axios";
import "dotenv/config";

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const DIAS_SIN_RESPUESTA = 2; // Días desde lastActivity para enviar follow-up
const DIAS_ENTRE_FOLLOWUPS = 5; // Esperar al menos 5 días antes de otro follow-up

// Mensaje de recordatorio (sin LLM, texto fijo)
const MENSAJE_FOLLOWUP = `Hola! Soy Nico de MEGA Inmobiliaria.

Te había pasado algunas propiedades que podrían interesarte en Santa Fe. ¿Tuviste chance de verlas? Si querés coordinar una visita o necesitás más info, escribime.

También podés hablar directo con Germán Manzur al +54 342 4287842.

Saludos!`;

async function enviarWhatsApp(phoneNumber, mensaje) {
  try {
    const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phoneNumber,
        type: "text",
        text: { body: mensaje },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
    );
    console.log(`[FOLLOW-UP] Mensaje enviado a ${phoneNumber}`);
    return true;
  } catch (err) {
    console.error(`[FOLLOW-UP ERROR] ${phoneNumber}:`, err.message);
    return false;
  }
}

export async function ejecutarFollowUpTibios() {
  const leads = getLeads();
  const ahora = Date.now();
  const tibios = leads.filter((l) => l.tier === "tibio");

  console.log(`[FOLLOW-UP] Revisando ${tibios.length} leads tibios...`);

  let enviados = 0;
  for (const lead of tibios) {
    // Skip si no tiene lastActivity o phone
    if (!lead.lastActivity || !lead.phone) continue;

    const diasSinRespuesta = (ahora - lead.lastActivity) / (1000 * 60 * 60 * 24);

    // Skip si respondió recientemente
    if (diasSinRespuesta < DIAS_SIN_RESPUESTA) continue;

    // Skip si ya le enviamos follow-up reciente
    if (lead.lastFollowUp) {
      const diasDesdeUltimoFollowUp = (ahora - lead.lastFollowUp) / (1000 * 60 * 60 * 24);
      if (diasDesdeUltimoFollowUp < DIAS_ENTRE_FOLLOWUPS) continue;
    }

    // Enviar follow-up
    const exito = await enviarWhatsApp(lead.phone, MENSAJE_FOLLOWUP);
    if (exito) {
      // Actualizar timestamp de follow-up (en memoria, no persiste automáticamente;
      // si necesitás persistir, integrar con saveLead() de agent.js)
      lead.lastFollowUp = ahora;
      enviados++;
    }
  }

  console.log(`[FOLLOW-UP] Enviados ${enviados} recordatorios a leads tibios.`);
  return { total: tibios.length, enviados };
}

// Si se ejecuta directamente (node follow-up-tibios.js), ejecuta el follow-up
if (import.meta.url === `file://${process.argv[1]}`) {
  ejecutarFollowUpTibios()
    .then(({ total, enviados }) => {
      console.log(`Finalizado: ${enviados}/${total} follow-ups enviados.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error ejecutando follow-up:", err);
      process.exit(1);
    });
}
