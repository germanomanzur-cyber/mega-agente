import OpenAI from "openai";
import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const knowledgeBase = readFileSync(
path.join(__dirname, "knowledge-base.md"),
"utf-8"
);

const N8N_BASE = "https://n8n-production-65677.up.railway.app/webhook";
const N8N_MEMORY_SAVE = `${N8N_BASE}/memoria-guardar`;
const N8N_MEMORY_DUMP = `${N8N_BASE}/memoria-todos`;

// ─── Tokko Broker ─────────────────────────────────────────────────────────────
const TOKKO_API_KEY = process.env.TOKKO_API_KEY || null;
const TOKKO_BASE_URL = process.env.TOKKO_API_URL || "https://api.tokkobroker.com/api/v1";

async function searchTokko(tipo, zona) {
  if (!TOKKO_API_KEY) return null;
  try {
    const opType = tipo === "alquiler" ? 2 : 1;
    const url = `${TOKKO_BASE_URL}/property/?key=${TOKKO_API_KEY}&format=json&limit=6&order_by=-id&operation_types=${opType}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    const props = data.objects || [];
    if (!props.length) return null;
    const zonaLow = zona ? zona.toLowerCase() : null;
    const filtered = zonaLow ? props.filter(p => JSON.stringify(p).toLowerCase().includes(zonaLow)) : props;
    const list = (filtered.length ? filtered : props).slice(0, 3);
    return list.map(p => {
      const op = p.operations?.[0];
      const price = op?.prices?.[0]?.price ? `USD ${Number(op.prices[0].price).toLocaleString("es-AR")}` : "Consultar precio";
      const surface = p.total_surface ? `${p.total_surface}m²` : "";
      const addr = p.address || p.title || "Sin dirección";
      const link = p.public_url ? ` → ${p.public_url}` : "";
      return `- ${addr}${surface ? " | " + surface : ""} | ${price}${link}`;
    }).join("\n");
  } catch (e) {
    console.error("[NICO/TOKKO] Error:", e.message);
    return null;
  }
}

const LEADS_FILE = path.join(__dirname, "leads.json");
function loadLeads() { try { if (existsSync(LEADS_FILE)) return JSON.parse(readFileSync(LEADS_FILE, "utf-8")); } catch (_) {} return []; }
function pushClienteToN8n(lead) { try { fetch(N8N_MEMORY_SAVE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numero: lead.phone || "", nombre: lead.name || "", zona: lead.zona || "", tipo: lead.tipo || "", presupuesto: lead.presupuesto || "", timing: lead.timing || "", interes: lead.interesEn || "", tier: lead.tier || "", ultimo_mensaje: lead.lastMessage || "", props_mostradas: lead.propsMostradas || "" }) }).catch(() => {}); } catch (_) {} }
function saveLead(lead) { try { const leads = loadLeads(); const idx = leads.findIndex((l) => l.phone === lead.phone); if (idx >= 0) leads[idx] = { ...leads[idx], ...lead, updatedAt: new Date().toISOString() }; else leads.push({ ...lead, createdAt: new Date().toISOString() }); writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8"); } catch (e) { console.error("Error guardando lead:", e.message); } pushClienteToN8n(lead); }
export function getLeads() { return loadLeads(); }

async function restoreMemoryFromN8n() {
  try {
    const r = await fetch(N8N_MEMORY_DUMP, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) return;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return;
    const leads = loadLeads();
    for (const row of rows) {
      if (!row || !row.numero) continue;
      const mapped = { phone: row.numero, name: row.nombre || null, zona: row.zona || null, tipo: row.tipo || null, presupuesto: row.presupuesto || null, timing: row.timing || null, interesEn: row.interes || null, tier: row.tier || "frio", lastMessage: row.ultimo_mensaje || "", propsMostradas: row.props_mostradas || "" };
      const idx = leads.findIndex((l) => l.phone === row.numero);
      if (idx >= 0) leads[idx] = { ...leads[idx], ...mapped }; else leads.push(mapped);
    }
    writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8");
    console.log(`[NICO] Memoria restaurada desde n8n: ${rows.length} clientes`);
  } catch (e) { console.error("[NICO] Error restaurando memoria:", e.message); }
}
restoreMemoryFromN8n();

const conversations = new Map();
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function getSession(phoneNumber) {
  const now = Date.now();
  if (conversations.has(phoneNumber)) { const session = conversations.get(phoneNumber); if (now - session.lastActivity > SESSION_TIMEOUT_MS) conversations.delete(phoneNumber); else { session.lastActivity = now; return session; } }
  const newSession = { messages: [], lastActivity: now, spamWarned: false, isFirstMessage: true, tokkoResults: null, profile: { name: null, zona: null, tipo: null, presupuesto: null, timing: null, interesEn: null, propsMostradas: "", canal: "whatsapp", firstContact: new Date().toISOString() }, tier: "frio", qualifyStep: 0, handoffSent: false, returning: false };
  try { const saved = loadLeads().find((l) => l.phone === phoneNumber); if (saved) { newSession.profile.name = saved.name || null; newSession.profile.zona = saved.zona || null; newSession.profile.tipo = saved.tipo || null; newSession.profile.presupuesto = saved.presupuesto || null; newSession.profile.timing = saved.timing || null; newSession.profile.interesEn = saved.interesEn || null; newSession.profile.propsMostradas = saved.propsMostradas || ""; if (saved.tier) newSession.tier = saved.tier; newSession.returning = true; } } catch (_) {}
  conversations.set(phoneNumber, newSession);
  return newSession;
}

export function resetSession(phoneNumber) { conversations.delete(phoneNumber); }
export function getAndClearPendingHandoff(phoneNumber) { const session = conversations.get(phoneNumber); if (session?.pendingHandoff) { const msg = session.pendingHandoff; session.pendingHandoff = null; return msg; } return null; }

const ZONAS = ["candioti", "amarras", "center", "cabral", "constituyentes", "sauce viejo", "fraga", "aeropuerto", "barrio sur", "puerto", "centro", "norte", "sur", "este", "oeste", "nueva cordoba", "rosario", "santa fe", "sf"];
const TIPOS_OPERACION = ["comprar", "compra", "vender", "venta", "alquilar", "alquiler", "invertir", "inversión", "inversion", "flipping", "crédito", "credito", "nido", "uva", "financiamiento"];

function esCaliente(texto) { const t = texto.toLowerCase(); const tieneMonto = /\b(usd|dolar|dólar|\$|mil|millón|millon|k\b|precio|presupuesto|cuánto cuesta|cuanto vale)/i.test(t); const tieneZona = ZONAS.some((z) => t.includes(z)); const tieneUrgencia = /\b(ya|hoy|urgente|cuanto antes|lo antes posible|esta semana|inmediato|necesito|quiero ver|puedo visitar|visita)/i.test(t); const tieneContacto = /\b(teléfono|telefono|llamar|reunión|reunion|turno|visitar|agenda|cita|escribime|mandame|pasame)/i.test(t); return tieneMonto && (tieneZona || tieneUrgencia || tieneContacto); }
function esTibio(texto) { const t = texto.toLowerCase(); return ZONAS.some((z) => t.includes(z)) || TIPOS_OPERACION.some((op) => t.includes(op)) || /\b(busco|buscando|necesito|quiero|me interesa|interesado|mirando|consultando|averiguando|información|info)\b/i.test(t); }
function esSpam(texto) { if (!texto || texto.trim().length < 3) return true; if (/^\d+$/.test(texto.trim())) return true; if (texto.trim().length < 5 && !/\b(ok|si|no|ya|dale|bien|gracias)\b/i.test(texto)) return true; return (texto.match(/[a-záéíóúñ]/gi) || []).length < 2; }
function extractName(text) { const patterns = [/(?:me llamo|soy|mi nombre es|mi nombre:?)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})?)/i, /hola[,!.]?\s+(?:soy\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/i, /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})[\s,!.]/]; for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); } return null; }
function extractZona(text) { const t = text.toLowerCase(); return ZONAS.find((z) => t.includes(z)) || null; }
function extractPresupuesto(text) { const m = text.match(/(?:usd|u\$s|dolar|dólar|\$)\s*[\d.,]+k?|[\d.,]+\s*(?:mil|k)\s*(?:dolar|dólar|usd|u\$s)?/i); return m ? m[0].trim() : null; }
function extractTipo(text) { const t = text.toLowerCase(); if (/\b(comprar|compra|quiero comprar|busco para comprar)\b/.test(t)) return "compra"; if (/\b(vender|venta|quiero vender|vendo)\b/.test(t)) return "venta"; if (/\b(alquilar|alquiler|rent|arrendar)\b/.test(t)) return "alquiler"; if (/\b(invertir|inversión|inversion|flipping)\b/.test(t)) return "inversión"; if (/\b(crédito|credito|nido|uva|financiamiento)\b/.test(t)) return "crédito"; return null; }
function extractTiming(text) { const t = text.toLowerCase(); if (/\b(ya|hoy|ahora|urgente|esta semana|lo antes posible|inmediato)\b/.test(t)) return "inmediato"; if (/\b(mes|pronto|este año|a corto plazo|próximo|proximo)\b/.test(t)) return "corto plazo"; if (/\b(mirando|explorando|viendo|averiguando|a futuro|no hay apuro|sin urgencia)\b/.test(t)) return "explorando"; return null; }
function extractPropertyInterest(text) { const props = ["amarras center", "sargento cabral", "constituyentes", "candioti", "sauce viejo", "fraga", "aeropuerto", "barrio sur"]; return props.find((p) => text.toLowerCase().includes(p)) || null; }
function updateProfile(session, userText) { const p = session.profile; if (!p.name) p.name = extractName(userText); if (!p.zona) p.zona = extractZona(userText); if (!p.presupuesto) p.presupuesto = extractPresupuesto(userText); if (!p.tipo) p.tipo = extractTipo(userText); if (!p.timing) p.timing = extractTiming(userText); if (!p.interesEn) p.interesEn = extractPropertyInterest(userText); }
function buildLeadSummary(phone, session) { const p = session.profile; return ["🔥 *LEAD " + session.tier.toUpperCase() + " — NICO*", "📱 Teléfono: +" + phone, p.name ? "👤 Nombre: " + p.name : null, p.tipo ? "🎯 Operación: " + p.tipo : null, p.zona ? "📍 Zona: " + p.zona : null, p.presupuesto ? "💰 Presupuesto: " + p.presupuesto : null, p.timing ? "⏱ Timing: " + p.timing : null, p.interesEn ? "🏠 Interés en: " + p.interesEn : null, "", "_Primer contacto: " + (p.firstContact ? new Date(p.firstContact).toLocaleString("es-AR") : "—") + "_"].filter(Boolean).join("\n"); }
function nextQualifyQuestion(session) { const p = session.profile; const step = session.qualifyStep; if (step === 0 && !p.zona) return "¿En qué zona de Santa Fe estás buscando?"; if (step === 0 && p.zona && !p.tipo) return "¿Estás buscando para comprar, alquilar o invertir?"; if (!p.presupuesto) return "¿Tenés pensado un presupuesto o rango de precio?"; if (!p.timing) return "¿Estás buscando para ya o todavía explorando opciones?"; return null; }

export async function handleIncomingMessage(phoneNumber, userText) {
  const session = getSession(phoneNumber);
  if (!userText || userText.trim() === "") return "Recibí tu mensaje 👍 Si querés enviarme texto puedo ayudarte mejor sobre propiedades en Santa Fe.";
  if (userText === "__AUDIO__") return "Gracias por el audio 🎙️ Por el momento solo puedo responder mensajes de texto. ¿Me contás en qué puedo ayudarte?";
  if (userText === "__IMAGE__") return "Recibí tu imagen 📸 Si tenés alguna consulta sobre propiedades, escribime y con gusto te ayudo.";
  if (esSpam(userText)) { if (!session.spamWarned) { session.spamWarned = true; return "Hola, soy Nico, el asistente de Germán Manzur en MEGA Inmobiliaria 🏠 ¿En qué puedo ayudarte hoy?"; } return null; }
  updateProfile(session, userText);
  if (!session.tokkoResults && session.profile.tipo) session.tokkoResults = await searchTokko(session.profile.tipo, session.profile.zona);
  if (esCaliente(userText)) {
    session.tier = "caliente";
    saveLead({ phone: phoneNumber, ...session.profile, tier: "caliente", lastMessage: userText });
    session.pendingHandoff = buildLeadSummary(phoneNumber, session); session.handoffSent = true;
    return "¡Perfecto" + (session.profile.name ? ", " + session.profile.name : "") + "! 🔥 Tengo todo lo que necesitás. Germán te contacta en minutos al *+54 342 4287842* para darte la información completa y coordinar una visita.\n\nTambién podés escribirle directamente: https://wa.me/5493424287842";
  }
  if (session.isFirstMessage) {
    session.isFirstMessage = false; session.messages.push({ role: "user", content: userText });
    if (esTibio(userText)) {
      session.tier = "tibio"; const q = nextQualifyQuestion(session); session.qualifyStep++;
      const aiResp = await callOpenAI(session.messages, buildSystemPrompt(session));
      session.messages.push({ role: "assistant", content: aiResp }); trackShownProps(session, aiResp);
      saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText });
      return q ? aiResp + "\n\n" + q : aiResp;
    }
    if (session.returning && session.profile.name) {
      const g = "¡Hola de nuevo, " + session.profile.name + "! 👋 Soy *Nico*, de MEGA Inmobiliaria. ¿Seguimos con lo que estabas viendo" + (session.profile.zona ? " en " + session.profile.zona : "") + " o te ayudo con algo nuevo?";
      session.messages.push({ role: "assistant", content: g }); return g;
    }
    const greeting = "Hola, soy *Nico* 🤖, el asistente de *Germán Manzur* en MEGA Inmobiliaria.\nTrabajamos con las mejores propiedades de Santa Fe: Amarras Center, Candioti, Puerto SF y más.\n\n¿Con quién tengo el gusto?";
    session.messages.push({ role: "assistant", content: greeting }); return greeting;
  }
  if (!session.profile.name && session.messages.length <= 2) { const name = extractName(userText) || (userText.trim().split(" ")[0].length > 2 ? userText.trim().split(" ")[0] : null); if (name) session.profile.name = name; }
  if (esTibio(userText) && session.tier === "frio") { session.tier = "tibio"; saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText }); }
  if (session.tier === "tibio" && session.qualifyStep < 2) {
    session.messages.push({ role: "user", content: userText });
    const aiResp = await callOpenAI(session.messages, buildSystemPrompt(session));
    session.messages.push({ role: "assistant", content: aiResp }); trackShownProps(session, aiResp);
    const q = nextQualifyQuestion(session); session.qualifyStep++;
    if (q && session.qualifyStep <= 2) { saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText }); return aiResp + "\n\n" + q; }
    if (!session.handoffSent) { session.handoffSent = true; session.pendingHandoff = buildLeadSummary(phoneNumber, session); saveLead({ phone: phoneNumber, ...session.profile, tier: "tibio", lastMessage: userText }); return aiResp + "\n\nPara darte la atención que merecés, te voy a conectar directamente con Germán. Podés escribirle por WhatsApp: https://wa.me/5493424287842 📲"; }
    return aiResp;
  }
  session.messages.push({ role: "user", content: userText });
  const aiResp = await callOpenAI(session.messages, buildSystemPrompt(session));
  session.messages.push({ role: "assistant", content: aiResp }); trackShownProps(session, aiResp);
  if (session.messages.length > 20) session.messages = session.messages.slice(-18);
  saveLead({ phone: phoneNumber, ...session.profile, tier: session.tier, lastMessage: userText });
  return aiResp;
}

function trackShownProps(session, text){ try { const flat=String(text).split("\n").join(" "); const segs=flat.split("http"); if(segs.length<2) return; let cur=(session.profile.propsMostradas||"").split("|").filter(Boolean); for(let i=1;i<segs.length;i++){ if(segs[i].indexOf("propiedad")!==-1){ const u=("http"+segs[i]).split(" ")[0]; if(cur.indexOf(u)===-1) cur.push(u); } } session.profile.propsMostradas=cur.slice(-15).join("|"); } catch(e){} }

function buildSystemPrompt(session) {
  const p = session.profile;
  const ctx = [];
  if (p.name) ctx.push("El lead se llama " + p.name + ".");
  if (p.zona) ctx.push("Zona de interés: " + p.zona + ".");
  if (p.tipo) ctx.push("Tipo de operación: " + p.tipo + ".");
  if (p.presupuesto) ctx.push("Presupuesto aproximado: " + p.presupuesto + ".");
  if (p.timing) ctx.push("Timing: " + p.timing + ".");
  if (p.interesEn) ctx.push("Propiedad de interés: " + p.interesEn + ".");
  const leadCtx = ctx.length ? "\n\nCONTEXTO DEL LEAD ACTUAL:\n" + ctx.join("\n") : "";
  const returningCtx = session.returning ? "\n\nESTE CLIENTE YA HABLÓ ANTES CON VOS: saludalo por su nombre si lo sabés y NO vuelvas a preguntar datos que ya están en el contexto. Retomá la conversación donde quedó." : "";
  const shownCtx = (p.propsMostradas||"") ? "\n\nPROPIEDADES QUE YA LE MOSTRASTE (no repitas):\n" + p.propsMostradas.split("|").join("\n") : "";
  const tokkoCtx = session.tokkoResults ? "\n\nPROPIEDADES EN TOKKO (tiempo real, priorizar):\n" + session.tokkoResults : "";
  return `Sos Nico, asistente de ventas inmobiliarias de Germán Manzur (MEGA Inmobiliaria, Santa Fe).

PERSONALIDAD: Profesional, cálido, directo. Sin rodeos. Sin emojis excesivos. Máx 3 frases por respuesta.

TU OBJETIVO: Calificar al lead (zona, presupuesto, tipo de operación, timing) y conectar a los interesados reales con Germán al +54 342 4287842.

PRIORIDADES DE CARTERA:
1. Primero ofrecer propiedades de la cartera directa de Germán (están en la base de conocimiento).
2. Si hay resultados de Tokko, mencionarlos como opciones adicionales del portafolio MEGA.
3. Por último derivar a portales externos.

REGLAS:
- Si preguntan precio, siempre dar el número de la knowledge base. Nunca decir "consultar".
- Si preguntan por créditos Nido/UVA, dar la info de la knowledge base sobre bancos.
- Nunca inventar propiedades que no están en la base de conocimiento ni en Tokko.
- Si no tenés la info, decí que Germán la tiene y derivá al WA.
- Respuestas cortas. Si el lead es caliente, derivar a Germán INMEDIATAMENTE.${leadCtx}${returningCtx}${shownCtx}${tokkoCtx}

BASE DE CONOCIMIENTO:
${knowledgeBase}`;
}

async function callOpenAI(messages, systemPrompt) {
  try { const r = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-12)], max_tokens: 160, temperature: 0.4 }); return r.choices[0].message.content.trim(); }
  catch (error) { console.error("OpenAI error:", error.message); return "En este momento no puedo responder. Escribile directamente a Germán: https://wa.me/5493424287842"; }
}

export function saveLeadWaName(phone, waName) {
  if (!phone || !waName) return;
  try { const leads = loadLeads(); const idx = leads.findIndex((l) => l.phone === phone); if (idx >= 0) { if (!leads[idx].waName) { leads[idx].waName = waName; leads[idx].updatedAt = new Date().toISOString(); writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8"); } } else { leads.push({ phone, waName, tier: "frio", createdAt: new Date().toISOString() }); writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8"); } } catch (e) { console.error("Error guardando waName:", e.message); }
}
export function searchLeadByName(nombre) { if (!nombre) return []; const q = String(nombre).trim().toLowerCase(); if (!q) return []; try { return loadLeads().filter((l) => (l.name || "").toLowerCase().includes(q) || (l.waName || "").toLowerCase().includes(q)); } catch (_) { return []; } }

const AGENTES_FILE = path.join(__dirname, "agentes.json");
function loadAgentes() { try { if (existsSync(AGENTES_FILE)) return JSON.parse(readFileSync(AGENTES_FILE, "utf-8")); } catch (_) {} return []; }
export function getAgentes() { return loadAgentes(); }
export function saveAgente(data) {
  try { const { nombre, phone, inmobiliaria, zona, fuente, propiedad } = data || {}; if (!phone && !nombre) return; const agentes = loadAgentes(); const idx = agentes.findIndex((a) => (phone && a.phone === phone) || (!phone && nombre && a.nombre === nombre)); if (idx >= 0) { const a = agentes[idx]; if (nombre) a.nombre = nombre; if (inmobiliaria) a.inmobiliaria = inmobiliaria; if (zona) a.zona = zona; if (fuente) a.fuente = fuente; if (propiedad) { a.propiedades = a.propiedades || []; a.propiedades.push(propiedad); } a.updatedAt = new Date().toISOString(); } else agentes.push({ nombre: nombre || null, phone: phone || null, inmobiliaria: inmobiliaria || "", zona: zona || null, fuente: fuente || null, propiedades: propiedad ? [propiedad] : [], createdAt: new Date().toISOString() }); writeFileSync(AGENTES_FILE, JSON.stringify(agentes, null, 2), "utf-8"); } catch (e) { console.error("Error guardando agente:", e.message); }
}
export function searchAgenteByName(nombre) { if (!nombre) return []; const q = String(nombre).trim().toLowerCase(); if (!q) return []; try { return loadAgentes().filter((a) => (a.nombre || "").toLowerCase().includes(q) || (a.inmobiliaria || "").toLowerCase().includes(q)); } catch (_) { return []; } }
