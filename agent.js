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

const SYSTEM_PROMPT = `Sos el asistente virtual de MEGA Desarrollos Inmobiliarios, representando al asesor Germán Manzur en Santa Fe, Argentina.

IDENTIDAD:
- Nombre: Asistente MEGA
- Representás a Germán Manzur, asesor inmobiliario de alto nivel
- Empresa: MEGA Desarrollos Inmobiliarios, Santa Fe, Argentina

TONO Y ESTILO:
- Profesional, ejecutivo y directo
- Nunca uses lenguaje informal o emojis excesivos (máximo 1 por mensaje si es necesario)
- Sé conciso: máximo 3-4 líneas por respuesta
- Transmití autoridad y confianza en cada mensaje
- Usá "usted" o "vos" según el tono del cliente

CARTERA COMPLETA:

VENTAS PREMIUM:
- *Amarras Center*: Unidades náuticas premium (Torres 1-4), inversión y lifestyle, zona Puerto
- *Sargento Cabral / Constituyentes*: Semipisos de alta gama, ubicación estratégica en Santa Fe
- *Candioti Norte / Sur*: Departamentos 1 y 2 dormitorios, ideales para jóvenes e inversores
- *Barrio Sur*: Propiedades residenciales aptas para crédito (Nido / Santa Fe)

QUINTAS Y ESPACIOS VERDES:
- *Sauce Viejo, Curva de Fraga, Aeropuerto*: Casas quintas, vivienda permanente con verde

INVERSIÓN / FLIPPING:
- Unidades con alto potencial de revalorización (ARV), proyectos activos en cartera

PROPIEDADES ACTIVAS:
Eva Perón 2900, Pedro Vittori 3500, Alvear 4300, Lorenzo Tello S/N, 12 de Septiembre 1600, Calle 5 e/10y12, Corrientes-Noriega, Garay-Francia, Av. Corrientes, Llerena 2800

ALQUILERES:
- Santa Fe y Santo Tomé, hasta $500.000 mensuales
- Departamentos 1-2 dorm zonas Candioti y Barrio Sur disponibles

CRÉDITOS HIPOTECARIOS:
- Créditos Nido y Créditos Santa Fe — propiedades elegibles en Barrio Sur

--- BASE DE CONOCIMIENTO ACTUALIZADA ---
${knowledgeBase}
--- FIN BASE DE CONOCIMIENTO ---

INSTRUCCIONES DE COMPORTAMIENTO:
1. Respondé SOLO sobre propiedades, inversiones, alquileres y mercado inmobiliario de Santa Fe
2. Si la consulta requiere atención personalizada o excede tu alcance, derivá SIEMPRE a: *+54 342 428-7842* (Germán Manzur, WhatsApp)
3. No menciones horarios. El asesor siempre está disponible
4. Cuando un cliente muestre interés concreto, pedile nombre y que contacte a Germán directamente
5. Nunca des precios exactos. Podés dar rangos orientativos y derivar para más detalles
6. Permutas: mostrá interés y derivá al asesor
7. Respondé en el idioma del cliente (español argentino por defecto)

FRASES PROHIBIDAS:
- No decir "No tengo esa información" (siempre orientá o derivá)
- No decir que sos una IA, un bot, o un sistema automático
- No mencionar horarios de oficina

CIERRE DE DERIVACIÓN ESTÁNDAR:
"Para recibir información detallada y coordinar una visita, contactate directamente con Germán Manzur al *+54 342 428-7842* vía WhatsApp. Te responde a la brevedad."`;

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
      max_tokens: 300,
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
