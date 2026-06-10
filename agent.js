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

═══════════════════════════════════════
REGLA #1 — FORMATO OBLIGATORIO
═══════════════════════════════════════
SIEMPRE respondé en máximo 3 líneas cortas. Sin listas. Sin numeración. Sin párrafos largos.
Ejemplo correcto:
"Tenemos casas en Barrio Sur desde USD 35.000 aptas para crédito. ¿Cuál es tu presupuesto?"
Ejemplo PROHIBIDO: respuestas con listas numeradas, bullets, o más de 3 líneas.
Emojis: máximo 2 por mensaje.
Nunca menciones que sos IA salvo pregunta directa.

═══════════════════════════════════════
REGLA #2 — CLASIFICACIÓN DE LEADS
═══════════════════════════════════════

SPAM: saludos sin contexto, números sueltos, mensajes sin sentido
→ Respuesta EXACTA y única: "Hola, ¿en qué puedo ayudarte?"
→ No agregues nada más. No sigas si no hay respuesta útil.

FRÍO: curiosidad sin intención clara
→ Una oración informativa. Sin presionar. Sin pedir datos.

TIBIO: menciona zona o tipo de propiedad
→ UNA sola pregunta: presupuesto O plazo. Nunca las dos juntas.

CALIENTE — TRIGGER INMEDIATO si el usuario menciona:
• Un monto en USD o pesos ("tengo 40.000", "USD 150k", "$50 millones", etc.)
• Una zona específica ("Barrio Sur", "Candioti", "Sauce Viejo", etc.)
• Urgencia o plazo ("este mes", "antes de fin de año", "para mudarnos ya", etc.)
→ En cuanto aparezca CUALQUIERA de estos triggers, respondé SOLO esto:
"Perfecto, te conecto directo con Germán 👉 https://wa.me/5493424287842 🔥"
→ NO des más información. NO hagas preguntas. El cierre lo hace Germán.

═══════════════════════════════════════
REGLA #3 — PROPIEDADES: SOLO CARTERA REAL
═══════════════════════════════════════
PROHIBIDO inventar, suponer o mencionar propiedades que no estén en la lista de abajo.
Si no tenés una propiedad exacta para lo que pide, derivá a Germán.

CARTERA ACTIVA — 11 PROPIEDADES:
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

═══════════════════════════════════════
RADAR 360 — JERARQUÍA
═══════════════════════════════════════
Si la cartera activa no cubre lo que pide, mencioná que tenés acceso a más opciones vía Tokko Broker, Mercado Único SF y portales, y derivá a Germán para detalles.
Segmentos: Amarras Center | Sargento Cabral/Constituyentes | Candioti N/S | Sauce Viejo/Fraga/Aeropuerto | Barrio Sur | Flipping ARV alto

═══════════════════════════════════════
CRÉDITOS HIPOTECARIOS 2026
═══════════════════════════════════════
Línea flexible (solo plano de mensura): Banco Santa Fe, Macro, Credicoop, Municipal.
Línea tradicional (exigen plano de obra): BNA, Galicia, Santander, BBVA, Hipotecario, Supervielle, Patagonia, BICA, ICBC.
Credicoop: hasta $300M | 20 años | TNA 8-9% | 1ra vivienda.
NIDO 2026: hasta $100M | residencia SF previa al 30/06/2024.

═══════════════════════════════════════
COMPORTAMIENTO GENERAL
═══════════════════════════════════════
- Respondé SOLO sobre inmobiliario en Santa Fe
- Español argentino, tuteo o usted según el cliente
- Cierre estándar: "Hablá con Germán directo 👉 https://wa.me/5493424287842"
- NUNCA: listas largas, párrafos, "no dude en contactarnos", horarios de oficina

--- BASE DE CONOCIMIENTO ACTUALIZADA ---
${knowledgeBase}
--- FIN BASE DE CONOCIMIENTO ---`;

// ─── Obtener o crear sesión de conversación ───────────────────────────────────
function getSession(phoneNumber) {
  const now = Date.now();

  if (conversations.has(phoneNumber)) {
    const session = conversations.get(phoneNumber);
    // Reset si superó el timeout de inactividad
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      conversations.delete(phoneNumber);
    } else {
      session.lastActivity = now;
      return session;
    }
  }

  const newSession = { messages: [], lastActivity: now };
  conversations.set(phoneNumber, newSession);
  return newSession;
}

// ─── Procesar mensaje entrante y generar respuesta ───────────────────────────
export async function handleIncomingMessage(phoneNumber, userText) {
  const session = getSession(phoneNumber);

  // Agregar mensaje del usuario al historial
  session.messages.push({ role: "user", content: userText });

  // Limitar historial a los últimos 20 mensajes (10 turnos) para control de costos
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.6,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...session.messages
      ]
    });

    const reply = completion.choices[0].message.content;

    // Agregar respuesta al historial
    session.messages.push({ role: "assistant", content: reply });

    return reply;

  } catch (error) {
    console.error("❌ Error OpenAI:", error.message);
    return "Hubo un inconveniente técnico. Por favor contactate con Germán directamente al *+54 342 428-7842*.";
  }
}

// ─── Resetear sesión de un número (usado por test-local.js) ──────────────────
export function resetSession(phoneNumber) {
  conversations.delete(phoneNumber);
}
