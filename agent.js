import OpenAI from "openai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cargar base de conocimiento desde archivo
const __dirname = dirname(fileURLToPath(import.meta.url));
let knowledgeBase = "";
try {
  knowledgeBase = readFileSync(join(__dirname, "knowledge-base.md"), "utf-8");
  console.log("✅ Base de conocimiento cargada correctamente");
} catch {
  console.warn("⚠️  No se encontró knowledge-base.md, usando solo el prompt base");
}

// Memoria de conversaciones por número de WhatsApp
// Cada entrada guarda el historial de la sesión (se resetea tras 2hs de inactividad)
const conversations = new Map();
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas

const SYSTEM_PROMPT = `Sos Nico, el asistente virtual de MEGA Desarrollos Inmobiliarios, representando al asesor Germán Manzur en Santa Fe, Argentina.

IDENTIDAD:
- Nombre: Nico — Asistente MEGA
- Representás a Germán Manzur, asesor inmobiliario de alto nivel
- Empresa: MEGA Desarrollos Inmobiliarios, Santa Fe, Argentina

FORMATO OBLIGATORIO:
Respondé SIEMPRE en máximo 3 líneas cortas. Sin listas. Sin numeración. Sin párrafos largos.
Emojis: máximo 2 por mensaje. Nunca menciones que sos IA salvo pregunta directa.

PROPIEDADES — SOLO CARTERA REAL (PROHIBIDO inventar otras):
• Av. Corrientes / Arroyo Aguiar — Casa — USD 45.000
• Corrientes-Noriega — Casa — USD 92.000
• Garay Sur — Cochera — USD 15.000
• Eva Perón 2973 — Casa — USD 270.000
• Llerena 2840 — Casa — USD 165.000
• Calle 5 e/10 y 12, Sauce Viejo — Terreno — USD 16.000
• 12 de Septiembre 1622, Santo Tomé — Depto — USD 38.000
• Lorenzo Tello / Villa CA — Quinta — USD 180.000
• Alvear 4336 — Casa — USD 190.000
• Pedro Vittori 3537 p5 — Depto — USD 135.000
• O'Higgins 3515 — Casa — USD 35.000

ALQUILERES: Santa Fe y Santo Tomé, hasta $500.000/mes. Deptos 1-2 dorm Candioti y Barrio Sur.

CRÉDITOS 2026:
Línea flexible (solo mensura): Banco Santa Fe, Macro, Credicoop, Municipal.
Línea tradicional (plano de obra): BNA, Galicia, Santander, BBVA, Hipotecario, Supervielle, Patagonia, BICA, ICBC.
Credicoop: hasta $300M | 20 años | TNA 8-9% | 1ra vivienda.
NIDO 2026: hasta $100M | residencia SF previa al 30/06/2024.

COMPORTAMIENTO:
- Respondé SOLO sobre inmobiliario en Santa Fe
- Lead frío (curiosidad vaga): una oración informativa, no presionar
- Lead tibio (tiene zona o tipo): hacer UNA sola pregunta (presupuesto O plazo)
- Si no tenés propiedad exacta para lo que pide: derivá a Germán
- Cierre estándar: "Hablá con Germán directo 👉 https://wa.me/5493424287842"
- Español argentino. Nunca listas largas ni párrafos.

--- BASE DE CONOCIMIENTO ACTUALIZADA ---
${knowledgeBase}
--- FIN BASE DE CONOCIMIENTO ---`;

// ─── PRE-FILTRO DE CLASIFICACIÓN (código, no prompt) ─────────────────────────

const CALIENTE_MONTOS = [
  /\b(usd|u\$s|dólar|dolar|dólares|dolares)\b/i,
  /\$\s*\d/,
  /\d+\s*(k|mil|millón|millon|millones)\b/i,
  /\b\d{4,}\b/,          // números de 4+ dígitos (precios)
];

const CALIENTE_ZONAS = [
  /barrio\s*sur/i,
  /candioti/i,
  /sauce\s*viejo/i,
  /fraga/i,
  /aeropuerto/i,
  /sargento\s*cabral/i,
  /constituyentes/i,
  /amarras/i,
  /santo\s*tom[eé]/i,
  /santa\s*fe/i,
];

const CALIENTE_URGENCIA = [
  /este\s*mes/i,
  /este\s*año/i,
  /urgente/i,
  /cuanto\s*antes/i,
  /ya\s*mismo/i,
  /para\s*mudarme/i,
  /para\s*mudarnos/i,
  /necesito\s*ya/i,
  /antes\s*de\s*fin/i,
  /en\s*los\s*pr[oó]ximos/i,
  /plazo\s*(de\s*)?\d/i,
];

const SPAM_PATTERNS = [
  /^[a-záéíóúüñ]{1,6}[!.]*$/i,   // una sola palabra corta (hola, buenas, ok, etc.)
  /^\d+$/,                         // solo números
  /^[^a-z0-9áéíóúüñ]*$/i,         // solo símbolos/espacios
];

function esCaliente(texto) {
  const tieneMonto = CALIENTE_MONTOS.some(r => r.test(texto));
  const tieneZona  = CALIENTE_ZONAS.some(r => r.test(texto));
  const tieneUrg   = CALIENTE_URGENCIA.some(r => r.test(texto));
  // caliente = monto + (zona o urgencia), o los tres
  return tieneMonto && (tieneZona || tieneUrg);
}

function esSpam(texto) {
  return SPAM_PATTERNS.some(r => r.test(texto.trim()));
}

// ─── Obtener o crear sesión de conversación ───────────────────────────────────
function getSession(phoneNumber) {
  const now = Date.now();

  if (conversations.has(phoneNumber)) {
    const session = conversations.get(phoneNumber);
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      conversations.delete(phoneNumber);
    } else {
      session.lastActivity = now;
      return session;
    }
  }

  const newSession = { messages: [], lastActivity: now, spamWarned: false };
  conversations.set(phoneNumber, newSession);
  return newSession;
}

// ─── Procesar mensaje entrante y generar respuesta ───────────────────────────
export async function handleIncomingMessage(phoneNumber, userText) {
  const session = getSession(phoneNumber);

  // ── FILTRO 1: CALIENTE → escalar a Germán sin pasar por OpenAI
  if (esCaliente(userText)) {
    console.log(`🔥 Lead CALIENTE detectado: ${phoneNumber}`);
    return "Perfecto, te conecto directo con Germán 👉 https://wa.me/5493424287842 🔥";
  }

  // ── FILTRO 2: SPAM → responder una sola vez
  if (esSpam(userText)) {
    if (session.spamWarned) {
      console.log(`🚫 SPAM repetido ignorado: ${phoneNumber}`);
      return null; // no responder
    }
    session.spamWarned = true;
    console.log(`⚠️ SPAM detectado: ${phoneNumber}`);
    return "Hola, ¿en qué puedo ayudarte?";
  }

  // Si pasó filtros de spam, resetear flag
  session.spamWarned = false;

  // Agregar mensaje del usuario al historial
  session.messages.push({ role: "user", content: userText });

  // Limitar historial a los últimos 20 mensajes (10 turnos)
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...session.messages
      ]
    });

    const reply = completion.choices[0].message.content;

    session.messages.push({ role: "assistant", content: reply });

    return reply;

  } catch (error) {
    console.error("❌ Error OpenAI:", error.message);
    return "Hubo un inconveniente técnico. Contactate con Germán directamente al *+54 342 428-7842*.";
  }
}

// ─── Resetear sesión de un número (usado por test-local.js) ──────────────────
export function resetSession(phoneNumber) {
  conversations.delete(phoneNumber);
}
