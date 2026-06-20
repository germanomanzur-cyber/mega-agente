import OpenAI from "openai";
import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Knowledge base ───────────────────────────────────────────────────────────
const knowledgeBase = readFileSync(
  path.join(__dirname, "knowledge-base.md"),
  "utf-8"
);

// ─── Memoria persistente en n8n (tabla clientes) ──────────────────────────────
// El bot corre en Railway con filesystem efimero: cada redeploy (incluido el
// commit nocturno del recompilador a las 03:00) borra leads.json. Para no
// olvidar con quien habla, la memoria durable vive en la Data Table "clientes"
// de n8n. saveLead hace upsert via /memoria-guardar y al bootear restauramos
// leads.json desde /memoria-todos.
const N8N_BASE = "https://n8n-production-65677.up.railway.app/webhook";
const N8N_MEMORY_SAVE = `${N8N_BASE}/memoria-guardar`;
const N8N_MEMORY_DUMP = `${N8N_BASE}/memoria-todos`;

// ─── Lead storage (persiste en Railway) ─────────────────────────────────────
const LEADS_FILE = path.join(__dirname, "leads.json");

function loadLeads() {
  try {
    if (existsSync(LEADS_FILE)) {
      return JSON.parse(readFileSync(LEADS_FILE, "utf-8"));
    }
  } catch (_) {}
  return [];
}

function pushClienteToN8n(lead) {
  // Fire-and-forget: nunca debe romper el flujo del bot.
  try {
    fetch(N8N_MEMORY_SAVE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        numero: lead.phone || "",
        nombre: lead.name || "",
        zona: lead.zona || "",
        tipo: lead.tipo || "",
        presupuesto: lead.presupuesto || "",
        timing: lead.timing || "",
        interes: lead.interesEn || "",
        tier: lead.tier || "",
        ultimo_mensaje: lead.lastMessage || "",
      }),
    }).catch(() => {});
  } catch (_) {}
}

function saveLead(lead) {
  try {
    const leads = loadLeads();
    const idx = leads.findIndex((l) => l.phone === lead.phone);
    if (idx >= 0) {
      leads[idx] = { ...leads[idx], ...lead, updatedAt: new Date().toISOString() };
    } else {
      leads.push({ ...lead, createdAt: new Date().toISOString() });
    }
    writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando lead:", e.message);
  }
  // Replicar a la memoria durable de n8n (no bloquea).
  pushClienteToN8n(lead);
}

export function getLeads() {
  return loadLeads();
}

// ─── Restaurar memoria durable desde n8n al bootear ───────────────────────────
async function restoreMemoryFromN8n() {
  try {
    const r = await fetch(N8N_MEMORY_DUMP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return;
    const leads = loadLeads();
    for (const row of rows) {
      if (!row || !row.numero) continue;
      const mapped = {
        phone: row.numero,
        name: row.nombre || null,
        zona: row.zona || null,
        tipo: row.tipo || null,
        presupuesto: row.presupuesto || null,
        timing: row.timing || null,
        interesEn: row.interes || null,
        tier: row.tier || "frio",
        lastMessage: row.ultimo_mensaje || "",
      };
      const idx = leads.findIndex((l) => l.phone === row.numero);
      if (idx >= 0) leads[idx] = { ...leads[idx], ...mapped };
      else leads.push(mapped);
    }
    writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8");
    console.log(`[NICO] Memoria restaurada desde n8n: ${rows.length} clientes`);
  } catch (e) {
    console.error("[NICO] Error restaurando memoria:", e.message);
  }
}
restoreMemoryFromN8n();

// ─── Sesiones en memoria ───────────────────────────────────────────────────────
const conversations = new Map();
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas

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
    profile: {
      name: null,
      zona: null,
      tipo: null,
      presupuesto: null,
      timing: null,
      interesEn: null,
      canal: "whatsapp",
      firstContact: new Date().toISOString(),
    },
    tier: "frio",
    qualifyStep: 0,
    handoffSent: false,
    returning: false,
  };

  // Rehidratar perfil desde la memoria persistente (no olvidar con quien habla).
  try {
    const saved = loadLeads().find((l) => l.phone === phoneNumber);
    if (saved) {
      newSession.profile.name = saved.name || null;
      newSession.profile.zona = saved.zona || null;
      newSession.profile.tipo = saved.tipo || null;
      newSession.profile.presupuesto = saved.presupuesto || null;
      newSession.profile.timing = saved.timing || null;
      newSession.profile.interesEn = saved.interesEn || null;
      if (saved.tier) newSession.tier = saved.tier;
      newSession.returning = true;
    }
  } catch (_) {}

  conversations.set(phoneNumber, newSession);
  return newSession;
}

export function resetSession(phoneNumber) {
  conversations.delete(phoneNumber);
}

export function getAndClearPendingHandoff(phoneNumber) {
  const session = conversations.get(phoneNumber);
  if (session?.pendingHandoff) {
    const msg = session.pendingHandoff;
    session.pendingHandoff = null;
    return msg;
  }
  return null;
}

// ─── Detección de intención ───────────────────────────────────────────────────
const ZONAS = [
  "candioti", "amarras", "center", "cabral", "constituyentes",
  "sauce viejo", "fraga", "aeropuerto", "barrio sur", "puerto",
  "centro", "norte", "sur", "este", "oeste", "nueva cordoba",
  "rosario", "santa fe", "sf",
];

const TIPOS_OPERACION = [
  "comprar", "compra", "vender", "venta", "alquilar", "alquiler",
  "invertir", "inversión", "inversion", "flipping", "crédito", "credito",
  "nido", "uva", "financiamiento",
];

function esCaliente(texto) {
  const t = texto.toLowerCase();
  const tieneMonto =
    /\b(usd|dolar|dólar|\$|mil|millón|millon|k\b|precio|presupuesto|cuánto cuesta|cuanto vale)/i.test(t);
  const tieneZona = ZONAS.some((z) => t.includes(z));
  const tieneUrgencia =
    /\b(ya|hoy|urgente|cuanto antes|lo antes posible|esta semana|inmediato|necesito|quiero ver|puedo visitar|visita)/i.test(t);
  const tieneContacto =
    /\b(teléfono|telefono|llamar|reunión|reunion|turno|visitar|agenda|cita|escribime|mandame|pasame)/i.test(t);
  return tieneMonto && (tieneZona || tieneUrgencia || tieneContacto);
}

function esTibio(texto) {
  const t = texto.toLowerCase();
  const tieneZona = ZONAS.some((z) => t.includes(z));
  const tieneTipo = TIPOS_OPERACION.some((op) => t.includes(op));
  const tieneInteres =
    /\b(busco|buscando|necesito|quiero|me interesa|interesado|mirando|consultando|averiguando|información|info)\b/i.test(t);
  return tieneZona || tieneTipo || tieneInteres;
}

function esSpam(texto) {
  if (!texto || texto.trim().length < 3) return true;
  if (/^\d+$/.test(texto.trim())) return true;
  if (texto.trim().length < 5 && !/\b(ok|si|no|ya|dale|bien|gracias)\b/i.test(texto)) return true;
  const letras = (texto.match(/[a-záéíóúñ]/gi) || []).length;
  return letras < 2;
}

// ─── Extracción de datos del perfil ──────────────────────────────────────────
function extractName(text) {
  const patterns = [
    /(?:me llamo|soy|mi nombre es|mi nombre:?)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})?)/i,
    /hola[,!.]?\s+(?:soy\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/i,
    /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})[\s,!.]/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractZona(text) {
  const t = text.toLowerCase();
  return ZONAS.find((z) => t.includes(z)) || null;
}

function extractPresupuesto(text) {
  const m = text.match(
    /(?:usd|u\$s|dolar|dólar|\$)\s*[\d.,]+k?|[\d.,]+\s*(?:mil|k)\s*(?:dolar|dólar|usd|u\$s)?/i
  );
  return m ? m[0].trim() : null;
}

function extractTipo(text) {
  const t = text.toLowerCase();
  if (/\b(comprar|compra|quiero comprar|busco para comprar)\b/.test(t)) return "compra";
  if (/\b(vender|venta|quiero vender|vendo)\b/.test(t)) return "venta";
  if (/\b(alquilar|alquiler|rent|arrendar)\b/.test(t)) return "alquiler";
  if (/\b(invertir|inversión|inversion|flipping)\b/.test(t)) return "inversión";
  if (/\b(crédito|credito|nido|uva|financiamiento)\b/.test(t)) return "crédito";
  return null;
}

function extractTiming(text) {
  const t = text.toLowerCase();
  if (/\b(ya|hoy|ahora|urgente|esta semana|lo antes posible|inmediato)\b/.test(t)) return "inmediato";
  if (/\b(mes|pronto|este año|a corto plazo|próximo|proximo)\b/.test(t)) return "corto plazo";
  if (/\b(mirando|explorando|viendo|averiguando|a futuro|no hay apuro|sin urgencia)\b/.test(t)) return "explorando";
  return null;
}

function extractPropertyInterest(text) {
  const properties = [
    "amarras center", "sargento cabral", "constituyentes", "candioti",
    "sauce viejo", "fraga", "aeropuerto", "barrio sur",
  ];
  const t = text.toLowerCase();
  return properties.find((p) => t.includes(p)) || null;
}

function updateProfile(session, userText) {
  const p = session.profile;
  if (!p.name) p.name = extractName(userText);
  if (!p.zona) p.zona = extractZona(userText);
  if (!p.presupuesto) p.presupuesto = extractPresupuesto(userText);
  if (!p.tipo) p.tipo = extractTipo(userText);
  if (!p.timing) p.timing = extractTiming(userText);
  if (!p.interesEn) p.interesEn = extractPropertyInterest(userText);
}

function buildLeadSummary(phone, session) {
  const p = session.profile;
  const lines = [
    `🔥 *LEAD ${session.tier.toUpperCase()} — NICO*`,
    `📱 Teléfono: +${phone}`,
    p.name ? `👤 Nombre: ${p.name}` : null,
    p.tipo ? `🎯 Operación: ${p.tipo}` : null,
    p.zona ? `📍 Zona: ${p.zona}` : null,
    p.presupuesto ? `💰 Presupuesto: ${p.presupuesto}` : null,
    p.timing ? `⏱ Timing: ${p.timing}` : null,
    p.interesEn ? `🏠 Interés en: ${p.interesEn}` : null,
    ``,
    `_Primer contacto: ${p.firstContact ? new Date(p.firstContact).toLocaleString("es-AR") : "—"}_`,
  ];
  return lines.filter(Boolean).join("\n");
}

function nextQualifyQuestion(session) {
  const p = session.profile;
  const step = session.qualifyStep;
  if (step === 0 && !p.zona) return "¿En qué zona de Santa Fe estás buscando?";
  if (step === 0 && p.zona && !p.tipo) return "¿Estás buscando para comprar, alquilar o invertir?";
  if (!p.presupuesto) return "¿Tenés pensado un presupuesto o rango de precio?";
  if (!p.timing) return "¿Estás buscando para ya o todavía explorando opciones?";
  return null;
}

export async function handleIncomingMessage(phoneNumber, userText) {
  const session = getSession(phoneNumber);

  if (!userText || userText.trim() === "") {
    return "Recibí tu mensaje 👍 Si querés enviarme texto puedo ayudarte mejor sobre propiedades en Santa Fe.";
  }
  if (userText === "__AUDIO__") {
    return "Gracias por el audio 🎙️ Por el momento solo puedo responder mensajes de texto. ¿Me contás en qué puedo ayudarte?";
  }
  if (userText === "__IMAGE__") {
    return "Recibí tu imagen 📸 Si tenés alguna consulta sobre propiedades, escribime y con gusto te ayudo.";
  }

  if (esSpam(userText)) {
    if (!session.spamWarned) {
      session.spamWarned = true;
      return "Hola, soy Nico, el asistente de Germán Manzur en MEGA Inmobiliaria 🏠 ¿En qué puedo ayudarte hoy?";
    }
    return null;
  }

  updateProfile(session, userText);

  if (esCaliente(userText)) {
    session.tier = "caliente";
    const summary = buildLeadSummary(phoneNumber, session);
    saveLead({ phone: phoneNumber, ...session.profile, tier: "caliente", lastMessage: userText });
    session.pendingHandoff = summary;
    session.handoffSent = true;
    return `¡Perfecto${session.profile.name ? `, ${session.profile.name}` : ""}! 🔥 Tengo todo lo que necesitás. Germán te contacta en minutos al *+54 342 4287842* para darte la información completa y coordinar una visita.\n\nTambién podés escribirle directamente: https://wa.me/5493424287842`;
  }

  if (session.isFirstMessage) {
    session.isFirstMessage = false;
    session.messages.push({ role: "user", content: userText });

    if (esTibio(userText)) {
      session.tier = "tibio";
      const q = nextQualifyQuestion(session);
      session.qualifyStep++;
      const systemPrompt = buildSystemPrompt(session);
      const aiResp = await callOpenAI(session.messages, systemPrompt);
      session.messages.push({ role: "assistant", content: aiResp });
      saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText });
      if (q) return `${aiResp}\n\n${q}`;
      return aiResp;
    }

    if (session.returning && session.profile.name) {
      const greetingBack = `¡Hola de nuevo, ${session.profile.name}! 👋 Soy *Nico*, de MEGA Inmobiliaria. ¿Seguimos con lo que estabas viendo${session.profile.zona ? ` en ${session.profile.zona}` : ""} o te ayudo con algo nuevo?`;
      session.messages.push({ role: "assistant", content: greetingBack });
      return greetingBack;
    }

    const greeting = `Hola, soy *Nico* 🤖, el asistente de *Germán Manzur* en MEGA Inmobiliaria.\nTrabajamos con las mejores propiedades de Santa Fe: Amarras Center, Candioti, Puerto SF y más.\n\n¿Con quién tengo el gusto?`;
    session.messages.push({ role: "assistant", content: greeting });
    return greeting;
  }

  if (!session.profile.name && session.messages.length <= 2) {
    const name = extractName(userText) || (userText.trim().split(" ")[0].length > 2 ? userText.trim().split(" ")[0] : null);
    if (name) session.profile.name = name;
  }

  if (esTibio(userText) && session.tier === "frio") {
    session.tier = "tibio";
    saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText });
  }

  if (session.tier === "tibio" && session.qualifyStep < 2) {
    session.messages.push({ role: "user", content: userText });
    const systemPrompt = buildSystemPrompt(session);
    const aiResp = await callOpenAI(session.messages, systemPrompt);
    session.messages.push({ role: "assistant", content: aiResp });
    const q = nextQualifyQuestion(session);
    session.qualifyStep++;
    if (q && session.qualifyStep <= 2) {
      saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText });
      return `${aiResp}\n\n${q}`;
    }
    if (!session.handoffSent) {
      session.handoffSent = true;
      const summary = buildLeadSummary(phoneNumber, session);
      session.pendingHandoff = summary;
      saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText });
      return `${aiResp}\n\nPara darte la atención que merecés, te voy a conectar directamente con Germán. Podés escribirle por WhatsApp: https://wa.me/5493424287842 📲`;
    }
    return aiResp;
  }

  session.messages.push({ role: "user", content: userText });
  const systemPrompt = buildSystemPrompt(session);
  const aiResp = await callOpenAI(session.messages, systemPrompt);
  session.messages.push({ role: "assistant", content: aiResp });

  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-18);
  }

  saveLead({ phone: phoneNumber, ...session.profile, tier: session.tier, lastMessage: userText });
  return aiResp;
}

function buildSystemPrompt(session) {
  const p = session.profile;
  const contextLines = [];
  if (p.name) contextLines.push(`El lead se llama ${p.name}.`);
  if (p.zona) contextLines.push(`Zona de interés: ${p.zona}.`);
  if (p.tipo) contextLines.push(`Tipo de operación: ${p.tipo}.`);
  if (p.presupuesto) contextLines.push(`Presupuesto aproximado: ${p.presupuesto}.`);
  if (p.timing) contextLines.push(`Timing: ${p.timing}.`);
  if (p.interesEn) contextLines.push(`Propiedad de interés: ${p.interesEn}.`);

  const leadContext = contextLines.length
    ? `\n\nCONTEXTO DEL LEAD ACTUAL:\n${contextLines.join("\n")}`
    : "";

  const returningContext = session.returning
    ? `\n\nESTE CLIENTE YA HABLÓ ANTES CON VOS: saludalo por su nombre si lo sabés y NO vuelvas a preguntar datos que ya están en el contexto. Retomá la conversación donde quedó.`
    : "";

  return `Sos Nico, asistente de ventas inmobiliarias de Germán Manzur (MEGA Inmobiliaria, Santa Fe).

PERSONALIDAD: Profesional, cálido, directo. Sin rodeos. Sin emojis excesivos. Máx 3 frases por respuesta.

TU OBJETIVO: Calificar al lead (zona, presupuesto, tipo de operación, timing) y conectar a los interesados reales con Germán al +54 342 4287842.

PRIORIDADES DE CARTERA:
1. Primero ofrecer propiedades de la cartera directa de Germán (están en la base de conocimiento).
2. Luego mencionar el portafolio MEGA general.
3. Por último derivar a portales externos.

REGLAS:
- Si preguntan precio, siempre dar el número de la knowledge base. Nunca decir "consultar".
- Si preguntan por créditos Nido/UVA, dar la info de la knowledge base sobre bancos.
- Nunca inventar propiedades que no están en la base de conocimiento.
- Si no tenés la info, decí que Germán la tiene y derivá al WA.
- Respuestas cortas. Si el lead es caliente, derivar a Germán INMEDIATAMENTE.${leadContext}${returningContext}

BASE DE CONOCIMIENTO:
${knowledgeBase}`;
}

async function callOpenAI(messages, systemPrompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.slice(-12),
      ],
      max_tokens: 160,
      temperature: 0.4,
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("OpenAI error:", error.message);
    return "En este momento no puedo responder. Escribile directamente a Germán: https://wa.me/5493424287842";
  }
}
