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
  console.warn("⚠️ No se encontró knowledge-base.md, usando solo el prompt base");
}

// Memoria de conversaciones por número de WhatsApp
const conversations = new Map();
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas

const SYSTEM_PROMPT = `Sos Nico, el asistente virtual de MEGA Inmobiliaria, representando al asesor Germán Manzur en Santa Fe, Argentina.

IDENTIDAD:
- Nombre: Nico — Asistente MEGA
- Representás a Germán Manzur, asesor inmobiliario de alto nivel
- Empresa: MEGA Inmobiliaria, Santa Fe, Argentina

FORMATO OBLIGATORIO:
Respondé SIEMPRE en máximo 3 líneas cortas. Sin listas. Sin numeración. Sin párrafos largos.
Emojis: máximo 2 por mensaje. Nunca menciones que sos IA salvo pregunta directa.

FLUJO DE CONVERSACIÓN:
1. Si es el primer mensaje del lead y no mencionó su nombre: presentate brevemente y preguntá su nombre de forma natural al final.
2. Lead frío (curiosidad vaga, sin zona ni tipo): una oración informativa, no presionar.
3. Lead tibio (mencionó zona O tipo de propiedad): hacé UNA sola pregunta de calificación (presupuesto O plazo).
4. Lead caliente (tiene monto + zona O urgencia clara): derivá inmediatamente a Germán.
5. Si no tenés propiedad exacta: derivá a Germán.

PROPIEDADES — Usá SOLO la base de conocimiento adjunta. NUNCA inventes propiedades ni precios.

ALQUILERES: Santa Fe y Santo Tomé. Deptos 1-2 dorm Candioti y Barrio Sur. Para rangos de precio actualizados consultá a Germán.

CRÉDITOS 2026:
Crédito Nido: propiedades elegibles en Barrio Sur. Requisito: residencia SF previa al 30/06/2024.
Crédito Santa Fe y otras líneas: Banco Santa Fe, Macro, Credicoop, BNA, Galicia, Santander, BBVA y más. Acompañamos todo el proceso.

PERMUTAS: Se evalúan caso a caso. Siempre derivar a Germán para análisis.

COMPORTAMIENTO:
- Respondé SOLO sobre inmobiliario en Santa Fe y Entre Ríos
- Español argentino. Nunca listas largas ni párrafos.
- Cierre estándar cuando derivás: "Hablá con Germán directo 👉 https://wa.me/5493424287842"

--- BASE DE CONOCIMIENTO ---
${knowledgeBase}
--- FIN BASE DE CONOCIMIENTO ---`;

// ─── PATRONES DE CLASIFICACIÓN ──────────────────────────────────────────────

const CALIENTE_MONTOS = [
  /\b(usd|u\$s|dólar|dolar|dólares|dolares)\b/i,
  /\$\s*\d/,
  /\d+\s*(k|mil|millón|millon|millones)\b/i,
  /\b\d{4,}\b/,
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
  /puerto/i,
  /costanera/i,
  /entre\s*r[íi]os/i,
  /pedro\s*vittori/i,
  /llerena/i,
  /eva\s*per[oó]n/i,
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

const TIPO_PROPIEDAD = [
  /depto|departamento/i,
  /casa/i,
  /terreno/i,
  /cochera/i,
  /quinta/i,
  /semipiso/i,
  /alquil/i,
  /compr[ao]/i,
  /invert[ií]/i,
  /flipping/i,
  /permuta/i,
];

const SPAM_PATTERNS = [
  /^[a-záéíóúüñ]{1,6}[!.]*$/i,
  /^\d+$/,
  /^[^a-z0-9áéíóúüñ]*$/i,
];

function esCaliente(texto) {
  const tieneMonto = CALIENTE_MONTOS.some(r => r.test(texto));
  const tieneZona = CALIENTE_ZONAS.some(r => r.test(texto));
  const tieneUrg = CALIENTE_URGENCIA.some(r => r.test(texto));
  return tieneMonto && (tieneZona || tieneUrg);
}

function esTibio(texto) {
  const tieneZona = CALIENTE_ZONAS.some(r => r.test(texto));
  const tieneTipo = TIPO_PROPIEDAD.some(r => r.test(texto));
  return tieneZona || tieneTipo;
}

function esSpam(texto) {
  return SPAM_PATTERNS.some(r => r.test(texto.trim()));
}

// ─── Obtener o crear sesión de conversación ──────────────────────────────────
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
  const newSession = {
    messages: [],
    lastActivity: now,
    spamWarned: false,
    isFirstMessage: true,
  };
  conversations.set(phoneNumber, newSession);
  return newSession;
}

// ─── Procesar mensaje entrante y generar respuesta ───────────────────────────
export async function handleIncomingMessage(phoneNumber, userText) {
  // Manejar mensajes sin texto (audio, imagen, sticker, etc.)
  if (!userText || userText.trim() === "") {
    return "Hola 👋 Solo puedo leer mensajes de texto por ahora. ¿En qué puedo ayudarte?";
  }

  const session = getSession(phoneNumber);

  // ── FILTRO 1: CALIENTE → escalar a Germán sin pasar por OpenAI
  if (esCaliente(userText)) {
    console.log(`🔥 Lead CALIENTE: ${phoneNumber}`);
    return "Perfecto, te conecto directo con Germán 👉 https://wa.me/5493424287842 🔥";
  }

  // ── FILTRO 2: SPAM → responder una sola vez
  if (esSpam(userText)) {
    if (session.spamWarned) {
      console.log(`🚫 SPAM repetido ignorado: ${phoneNumber}`);
      return null;
    }
    session.spamWarned = true;
    console.log(`⚠️ SPAM: ${phoneNumber}`);
    return "Hola, ¿en qué puedo ayudarte?";
  }

  session.spamWarned = false;

  const tibioFlag = esTibio(userText);
  if (tibioFlag) console.log(`🌡️ Lead TIBIO: ${phoneNumber}`);

  session.messages.push({ role: "user", content: userText });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  // Construir system prompt con contexto situacional
  let systemContent = SYSTEM_PROMPT;
  if (session.isFirstMessage) {
    systemContent += "\n\nCONTEXTO: Primer mensaje de este lead. Si no mencionó su nombre, preguntáselo naturalmente al final de tu respuesta.";
    session.isFirstMessage = false;
  }
  if (tibioFlag) {
    systemContent += "\n\nCONTEXTO: El lead mencionó zona o tipo de propiedad. Hacé UNA pregunta de calificación sobre presupuesto o plazo.";
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      temperature: 0.5,
      messages: [
        { role: "system", content: systemContent },
        ...session.messages,
      ],
    });

    const reply = completion.choices[0].message.content;
    session.messages.push({ role: "assistant", content: reply });
    return reply;

  } catch (error) {
    console.error("❌ Error OpenAI:", error.message);
    return "Hubo un inconveniente técnico. Contactate con Germán al *+54 342 428-7842*.";
  }
}

// ─── Resetear sesión de un número ────────────────────────────────────────────
export function resetSession(phoneNumber) {
  conversations.delete(phoneNumber);
}
