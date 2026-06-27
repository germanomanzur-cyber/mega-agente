// zona-filter+fichas v2
import OpenAI from "openai";
import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { matchFAQ } from "./faq.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ─── Knowledge base ───────────────────────────────────────────────────────────
const knowledgeBase = readFileSync(
  path.join(__dirname, "knowledge-base.md"),
  "utf-8"
);

// ─── Lead storage ─────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LEADS_FILE = path.join(DATA_DIR, "leads.json");

function loadLeads() {
  try {
    if (existsSync(LEADS_FILE)) {
      const data = JSON.parse(readFileSync(LEADS_FILE, "utf-8"));
      // Type-safety: el resto del código asume un array. Si el archivo se
      // corrompe o contiene otro tipo, devolvemos [] para no romper findIndex/filter.
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error("Error leyendo leads.json:", e.message);
  }
  return [];
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
}

export function getLeads() {
  return loadLeads();
}

export function saveLeadWaName(phone, waName) {
  saveLead({ phone, waName });
}

export function searchLeadByName(nombre) {
  const leads = loadLeads();
  const q = (nombre || "").toLowerCase().trim();
  if (!q) return [];
  return leads.filter(
    (l) =>
      (l.name && l.name.toLowerCase().includes(q)) ||
      (l.waName && l.waName.toLowerCase().includes(q))
  );
}

// ─── Agente storage ───────────────────────────────────────────────────────────
const AGENTS_FILE = path.join(DATA_DIR, "agentes.json");

function loadAgentes() {
  try {
    if (existsSync(AGENTS_FILE)) {
      const data = JSON.parse(readFileSync(AGENTS_FILE, "utf-8"));
      // Type-safety: garantizamos siempre un array (ver loadLeads).
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error("Error leyendo agentes.json:", e.message);
  }
  return [];
}

export function saveAgente(agente) {
  try {
    const agentes = loadAgentes();
    const idx = agentes.findIndex((a) => a.phone === agente.phone);
    if (idx >= 0) {
      agentes[idx] = { ...agentes[idx], ...agente, updatedAt: new Date().toISOString() };
    } else {
      agentes.push({ ...agente, createdAt: new Date().toISOString() });
    }
    writeFileSync(AGENTS_FILE, JSON.stringify(agentes, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando agente:", e.message);
  }
}

export function getAgentes() {
  return loadAgentes();
}

export function searchAgenteByName(nombre) {
  const agentes = loadAgentes();
  const q = (nombre || "").toLowerCase().trim();
  if (!q) return [];
  return agentes.filter((a) => a.nombre && a.nombre.toLowerCase().includes(q));
}

export function extractAgentesFromText(text) {
  if (!text) return [];
  const agents = [];
  const phoneRe = /(?:wa\.me\/|whatsapp\.com\/|\+?549?)(\d{10,13})/g;
  let m;
  while ((m = phoneRe.exec(text)) !== null) {
    agents.push({ phone: m[1], nombre: null });
  }
  return agents;
}

// ─── Sesiones en memoria (con respaldo en disco) ───────────────────────────────
const conversations = new Map();
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

// Persistencia de sesiones: Railway reinicia el proceso en cada redeploy y eso
// borraba TODAS las conversaciones en curso (un lead perdía su contexto a mitad
// de charla). Guardamos en disco para sobrevivir reinicios. No consume tokens.
function persistSessions() {
  try {
    const obj = {};
    for (const [k, v] of conversations.entries()) obj[k] = v;
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj), "utf-8");
  } catch (e) {
    console.error("Error guardando sesiones:", e.message);
  }
}

function loadSessionsFromDisk() {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const now = Date.now();
    let restauradas = 0;
    for (const [k, v] of Object.entries(data)) {
      // Solo restauramos sesiones que no hayan expirado.
      if (v && typeof v === "object" && v.lastActivity && now - v.lastActivity < SESSION_TIMEOUT_MS) {
        conversations.set(k, v);
        restauradas++;
      }
    }
    if (restauradas) console.log(`[NICO] ${restauradas} sesiones restauradas desde disco`);
  } catch (e) {
    console.error("Error cargando sesiones:", e.message);
  }
}

loadSessionsFromDisk();

// Respaldo periódico + flush al apagar (Railway envía SIGTERM en cada redeploy).
const _persistInterval = setInterval(persistSessions, 20000);
if (_persistInterval.unref) _persistInterval.unref();
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => {
    persistSessions();
    process.exit(0);
  });
}

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
  };
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
    `*LEAD ${session.tier.toUpperCase()} - NICO*`,
    `Telefono: +${phone}`,
    p.name ? `Nombre: ${p.name}` : null,
    p.tipo ? `Operacion: ${p.tipo}` : null,
    p.zona ? `Zona: ${p.zona}` : null,
    p.presupuesto ? `Presupuesto: ${p.presupuesto}` : null,
    p.timing ? `Timing: ${p.timing}` : null,
    p.interesEn ? `Interes en: ${p.interesEn}` : null,
    ``,
    `_Primer contacto: ${p.firstContact ? new Date(p.firstContact).toLocaleString("es-AR") : "-"}_`,
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

// Convierte un texto de presupuesto a número en USD aproximado.
// Ej: "USD 150.000" -> 150000, "150 mil" -> 150000, "150k" -> 150000.
// Se usa para filtrar el inventario por rango de precio y así reducir los
// tokens que se inyectan al LLM (menos texto = menos costo).
function parseUSD(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  const m = s.match(/([\d][\d.,]*)\s*(millones?|millón|millon|mill|mil|k)?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/\./g, "").replace(/,/g, "."));
  if (isNaN(n)) return null;
  const unit = m[2] || "";
  if (unit.startsWith("mill") || unit === "millón") n *= 1000000;
  else if (unit === "k" || unit === "mil") n *= 1000;
  return n > 0 ? n : null;
}

// Filtra KB por zona exacta del lead antes de enviarlo al LLM
function filterKBByZona(kb, zona) {
  if (!zona || zona.trim().length < 3) return kb;
  const z = zona.toLowerCase().trim();
  const blocks = kb.split(/\n(?=##)/);
  const matches = blocks.filter(b => b.toLowerCase().includes(z));
  if (matches.length === 0) return '';
  let result = matches.join('\n\n');
  if (result.length > 3500) result = result.substring(0, 3500) + '\n...[mas propiedades disponibles]';
  return result;
}

export async function handleIncomingMessage(phoneNumber, userText) {
  const session = getSession(phoneNumber);

  if (!userText || userText.trim() === "") {
    return "Recibí tu mensaje. Si querés enviarme texto puedo ayudarte mejor sobre propiedades en Santa Fe.";
  }
  if (userText === "__AUDIO__") {
    return "Gracias por el audio. Por el momento solo puedo responder mensajes de texto. ¿Me contás en qué puedo ayudarte?";
  }
  if (userText === "__IMAGE__") {
    return "Recibí tu imagen. Si tenés alguna consulta sobre propiedades, escribime y con gusto te ayudo.";
  }

  if (esSpam(userText)) {
    if (!session.spamWarned) {
      session.spamWarned = true;
      return "Hola, soy Nico, el asistente de Germán Manzur en MEGA Inmobiliaria. ¿En qué puedo ayudarte hoy?";
    }
    return null;
  }

  updateProfile(session, userText);

  if (esCaliente(userText)) {
    session.tier = "caliente";
    const summary = buildLeadSummary(phoneNumber, session);
    saveLead({ phone: phoneNumber, ...session.profile, tier: "caliente", lastMessage: userText });
    session.handoffSent = true;
    session.messages.push({ role: "user", content: userText });
    const _sysP = buildSystemPrompt(session) + "\n\nEl lead es CALIENTE: lista hasta 5 propiedades reales que coincidan con su zona y presupuesto (de a 5 si pide mas), con direccion, precio USD, m2 y link de ficha. Si no hay match en cartera ni inventario, decilo honestamente. Cerra avisando que German Manzur se contacta en breve al +54 342 4287842. Sin emojis.";
    const _aiR = await callOpenAI(session.messages, _sysP);
    session.messages.push({ role: "assistant", content: _aiR });
    session.pendingHandoff = summary + '\n\n--- PROPIEDADES MOSTRADAS AL CLIENTE ---\n' + _aiR;
    return _aiR;
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

    const greeting = `Hola, soy *Nico*, el asistente de *Germán Manzur* en MEGA Inmobiliaria.\nTrabajamos con las mejores propiedades de Santa Fe: Amarras Center, Candioti, Puerto SF y más.\n\n¿Con quién tengo el gusto?`;
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
      return `${aiResp}\n\nPara darte la atención que merecés, te voy a conectar directamente con Germán. Podés escribirle por WhatsApp: https://wa.me/5493424287842`;
    }
    return aiResp;
  }

  // Respuesta instantánea SIN LLM para consultas informativas frecuentes.
  // Solo aplica a leads fríos (los tibios/calientes ya se manejaron arriba),
  // por lo que no interfiere con la calificación. Ahorra una llamada a Groq.
  if (session.tier === "frio") {
    const faq = matchFAQ(userText);
    if (faq) {
      session.messages.push({ role: "user", content: userText });
      session.messages.push({ role: "assistant", content: faq });
      if (session.messages.length > 20) session.messages = session.messages.slice(-18);
      saveLead({ phone: phoneNumber, ...session.profile, tier: "frio", lastMessage: userText });
      persistSessions();
      return faq;
    }
  }

  session.messages.push({ role: "user", content: userText });
  const systemPrompt = buildSystemPrompt(session);
  const aiResp = await callOpenAI(session.messages, systemPrompt);
  session.messages.push({ role: "assistant", content: aiResp });

  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-18);
  }

  saveLead({ phone: phoneNumber, ...session.profile, tier: session.tier, lastMessage: userText });
  persistSessions();
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

  return `IMPORTANTE - REGLAS QUE MANDAN SOBRE TODO LO DEMAS:\n- Responde SIEMPRE en espanol rioplatense (argentino). NUNCA en ingles, bajo ninguna circunstancia.\n- Tono AMISTOSO, calido y cercano. Empeza SIEMPRE tu respuesta con un saludo corto y cordial (ej: "Hola! Soy Nico de MEGA Inmobiliaria.") antes de dar cualquier informacion. Nunca arranques tirando datos sin saludar primero.\n- Sin emojis. Solo texto plano.\n- Maximo 3-4 frases. Si listas propiedades: MAXIMO 5 por mensaje y, si piden mas, de a 5 (NUNCA mas de 5 por mensaje). Por propiedad, formato breve: direccion, precio USD, m2, link de ficha.\n- Se concreto, con datos exactos de la cartera. Nada de relleno generico.\n\nSos Nico, asistente de ventas inmobiliarias de Germán Manzur (MEGA Inmobiliaria, Santa Fe).

PERSONALIDAD: Profesional, cálido, directo. Sin rodeos. Sin emojis excesivos. Máx 3 frases por respuesta.

TU OBJETIVO: Calificar al lead (zona, presupuesto, tipo de operación, timing) y conectar a los interesados reales con Germán al +54 342 4287842.

PRIORIDADES DE BUSQUEDA (ampliar en este orden si el lead pide mas o no hay match en la cartera):
1. Cartera directa de German (PRIORIDAD 1).
2. Inventario MEGA web, 302 propiedades (PRIORIDAD 2).
3. Tokko Broker.
4. Mercado Unico SF.
5. Remax.
Tokko, Mercado Unico y Remax NO tienen datos en vivo: si se agotan cartera e inventario MEGA, ofrece que German busca ahi y deriva al +54 342 4287842. NUNCA inventes propiedades de esos portales.

REGLAS:
- Si preguntan precio, siempre dar el número de la knowledge base. Nunca decir "consultar".
- Si preguntan por créditos Nido/UVA, dar la info de la knowledge base sobre bancos.
- Nunca inventar propiedades que no están en la base de conocimiento.
- Si no tenés la info, decí que Germán la tiene y derivá al WA.
- Respuestas cortas. Si el lead es caliente, derivar a Germán INMEDIATAMENTE.${leadContext}

BASE DE CONOCIMIENTO (cartera directa + inventario MEGA segun lo que pida el lead):
${(()=>{const kb=knowledgeBase;const a=kb.indexOf("PRIORIDAD 1"),b=kb.indexOf("PRIORIDAD 2");const cartera=(a>=0&&b>a)?kb.slice(a-3,b):kb.slice(0,3800);const um=(([...session.messages].reverse().find(m=>m.role==="user"))||{}).content||"";const t=um.toLowerCase();let pre=[];if(/departamento|depto|dpto|monoambiente|semipiso/.test(t))pre=["- Departamento","- Monoambiente","- Semipiso"];else if(/terreno|lote/.test(t))pre=["- Terreno","- Lote"];else if(/local|galpon|oficina/.test(t))pre=["- Local","- Galpon","- Oficina"];else if(/quinta/.test(t))pre=["- Quinta"];else if(/casa|ph|duplex|chalet/.test(t))pre=["- Casa","- PH","- Duplex"];const i=kb.indexOf("INVENTARIO COMPLETO");let inv="";if(i>=0){const LS=kb.slice(i).split("\n");let z="";const out=[];for(const l of LS){const h=l.match(/^###\s+(.+)/);if(h){z=h[1].trim();continue;}if(l.startsWith("- ")&&(!pre.length||pre.some(p=>l.startsWith(p))))out.push("["+z+"] "+l);}let _bud=parseUSD(session.profile&&session.profile.presupuesto);let _sel=out;if(_bud){const _f=out.filter(li=>{const _m=li.match(/USD\s*([\d.]+)/);if(!_m)return false;const _p=parseInt(_m[1].replace(/\./g,""),10);return _p>=_bud*0.6&&_p<=_bud*1.4;});if(_f.length>=3)_sel=_f;}inv=_sel.join("\n");if(inv.length>4500)inv=inv.slice(0,4500)+"\n...(hay mas; pedir mas detalles)";}return "PRIORIDAD 1 - CARTERA DIRECTA DE GERMAN (ofrecer SIEMPRE primero):\n"+cartera+(inv?"\n\nPRIORIDAD 2 - INVENTARIO MEGA WEB (ofrecer si pide mas o no hay match; filtra por zona y presupuesto del lead):\n"+inv:"");})()}

REGLAS CRITICAS:
- NUNCA uses emojis. Solo texto plano.\n- Si el lead especifica un TIPO (departamento, casa, terreno, lote, local, quinta, ph), ofrece UNICAMENTE propiedades de ese tipo. No mezcles otros tipos aunque esten en la cartera.\n- Si la cartera directa no alcanza para llegar a 5, COMPLETA hasta 5 con el inventario MEGA web (PRIORIDAD 2) que coincida en tipo, zona y presupuesto. Deriva a German SOLO si no hay NINGUNA opcion del tipo y zona pedidos ni en cartera ni en inventario.
- Si el usuario pide propiedades: lista MAXIMO 5 propiedades REALES de la knowledge base (las mas acordes a zona, presupuesto y tipo). Por cada una: direccion, precio USD, m2 y caracteristicas. Si el lead pide ver mas, mostra las SIGUIENTES 5 (nunca mas de 5 por mensaje) y al cerrar cada tanda ofrece: "Te muestro 5 mas?" o derivacion a German Manzur.
- NUNCA inventes propiedades ni datos que no esten en la knowledge base.
- Responde siempre en español argentino, de forma profesional y concisa.`;
}

async function callOpenAI(messages, systemPrompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.slice(-10),
      ],
      max_tokens: 1500,
      reasoning_effort: "low",
      temperature: 0.4,
    });
    // Null-safety: si la API no devuelve choices/content válidos, usamos el fallback.
    const content = response?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      throw new Error("Respuesta vacía del modelo");
    }
    return content.trim();
  } catch (error) {
    console.error("OpenAI error:", error.message);
    return "En este momento no puedo responder. Escribile directamente a Germán: https://wa.me/5493424287842";
  }
}
