#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// MONITOR DIARIO DE NICO  (reemplaza al agente de Claude, cero tokens LLM)
// ─────────────────────────────────────────────────────────────────────────────
// 1. Chequea /health. Si falla -> avisa INCIDENTE por WhatsApp.
// 2. Lee /chats.json, toma las conversaciones con actividad de ayer (y hoy),
//    excluye la del propio German, clasifica cada una (caliente/tibio/frio),
//    detecta que busca, codigos [REF] y si Nico derivo a German.
// 3. Manda el resumen a German por WhatsApp (POST /report).
//
// Toda la clasificacion corre en codigo (sin LLM).
//
// USO:   REPORT_TOKEN=mega-radar-2024 node tasks/monitor-diario.mjs
// ENV:
//   REPORT_URL    (default https://mega-agente-production.up.railway.app)
//   REPORT_TOKEN  (default 'mega-radar-2024')
//   GERMAN_PHONE  (default '5493424287842')  -> se excluye del resumen
//   TZ_OFFSET     (default '-03:00' Argentina)
//   DRY_RUN=1     (no postea, solo imprime el resumen)
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_URL = (process.env.REPORT_URL || "https://mega-agente-production.up.railway.app").replace(/\/$/, "");
const REPORT_TOKEN = process.env.REPORT_TOKEN || "mega-radar-2024";
const GERMAN_PHONE = process.env.GERMAN_PHONE || "5493424287842";
const TZ = "America/Argentina/Buenos_Aires";
const DRY_RUN = process.env.DRY_RUN === "1";

// ── fecha en horario argentino (YYYY-MM-DD) ─────────────────────────────────
function arDate(d) {
  // en-CA da formato YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function arPretty(d) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

// ── clasificacion de interes (heuristica por palabras clave) ────────────────
const KW_CALIENTE = [
  "compr", "señ", "sena", "reserv", "visit", "ver la propiedad", "ver la casa", "ir a ver",
  "cuando puedo ver", "cuándo puedo ver", "coordin", "efectivo", "credito aprob", "crédito aprob",
  "hipotecario aprob", "quiero", "me la quedo", "hago la oferta", "ofrezco", "disponible para mudar",
  "llamame", "llámame", "mi numero", "mi número", "pasame", "agend",
];
const KW_TIBIO = [
  "info", "informacion", "información", "precio", "cuanto", "cuánto", "valor", "disponible",
  "consult", "interesa", "metros", "ambientes", "dormitorios", "cochera", "financ", "credito", "crédito",
  "permuta", "expensas", "fotos", "ubicacion", "ubicación", "zona",
];

function clasificar(userText) {
  const t = userText.toLowerCase();
  if (KW_CALIENTE.some((k) => t.includes(k))) return "caliente";
  if (KW_TIBIO.some((k) => t.includes(k))) return "tibio";
  return "frio";
}

// ── extraccion de perfil (que busca) ────────────────────────────────────────
const ZONAS = [
  "centro", "candioti", "guadalupe", "norte", "sur", "parque", "colastine", "colastiné", "sauce viejo",
  "santo tome", "santo tomé", "rincon", "rincón", "recreo", "arroyo leyes", "arroyo aguiar", "parana",
  "paraná", "oro verde", "monte vera", "bajada grande", "villa california", "san benito", "colonia avellaneda",
];
const TIPOS = ["casa", "departamento", "depto", "ph", "terreno", "lote", "quinta", "local", "oficina", "galpon", "galpón", "cochera", "duplex", "dúplex"];

function extraer(userTexts) {
  const t = userTexts.join(" ").toLowerCase();
  const zona = ZONAS.find((z) => t.includes(z)) || "";
  const tipo = TIPOS.find((x) => t.includes(x)) || "";
  // presupuesto: USD/u$s/$ seguido de numero, o "120 mil", "120000"
  let pres = "";
  const mUsd = t.match(/(u\$s|usd|us\$|d[oó]lares)\s*([\d.,]+)/);
  const mMil = t.match(/([\d.,]+)\s*(mil|k|lucas|palos|millones?)/);
  const mNum = t.match(/\$\s*([\d.][\d.,]{3,})/);
  if (mUsd) pres = `USD ${mUsd[2]}`;
  else if (mMil) pres = `${mMil[1]} ${mMil[2]}`;
  else if (mNum) pres = `$${mNum[1]}`;
  const partes = [tipo, zona, pres].filter(Boolean);
  return partes.join(" / ");
}

// ── codigos REF mencionados por Nico ────────────────────────────────────────
function refs(nicoTexts) {
  const txt = nicoTexts.join(" ");
  const set = new Set();
  // [REF], [MHO7720758], Ref: ABC, codigos Tokko (M + letras + numeros)
  for (const m of txt.matchAll(/\[([A-Z0-9][A-Z0-9\-\s]{1,20})\]/g)) {
    // limpiar prefijo "REF " dentro del corchete -> nos quedamos con el codigo real
    set.add(m[1].trim().replace(/^REF[:\s.]+/i, "").trim());
  }
  for (const m of txt.matchAll(/\b(M[A-Z]{2}\d{5,})\b/g)) set.add(m[1]);
  for (const m of txt.matchAll(/\bref[:\s.]+([A-Z0-9\-]{3,})/gi)) set.add(m[1]);
  return [...set];
}

function derivado(nicoTexts) {
  const txt = nicoTexts.join(" ").toLowerCase();
  return txt.includes("5493424287842") || txt.includes("wa.me/549342") ||
    /\bgerm[aá]n\b/.test(txt) && /(contact|deriv|escrib|llam|coordina|pasa el)/.test(txt);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "nico-monitor" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function report(message) {
  if (DRY_RUN) { console.log("=== DRY_RUN, no se postea ===\n" + message); return { ok: true, dry: true }; }
  const r = await fetch(`${REPORT_URL}/report`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: REPORT_TOKEN, message }),
  });
  return { ok: r.ok, status: r.status };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const hoy = new Date();
  const fechaPretty = arPretty(hoy);
  const ayer = new Date(hoy.getTime() - 24 * 3600 * 1000);
  const diasObjetivo = new Set([arDate(hoy), arDate(ayer)]);

  // 1. SALUD
  let saludOk = false;
  try {
    const h = await getJSON(`${REPORT_URL}/health`);
    saludOk = h && h.status === "ok";
  } catch (e) { saludOk = false; }

  if (!saludOk) {
    const msg = `⚠️ NICO — INCIDENTE ${fechaPretty}\nEl bot NO responde (/health caido o lento).\nRevisar Deploy Logs en Railway (proyecto gallant-comfort / servicio megaagente). No se pudo leer conversaciones.`;
    await report(msg);
    console.error("[monitor] INCIDENTE: health caido");
    console.log(JSON.stringify({ saludOk: false, enviado: true }));
    return;
  }

  // 2. CONVERSACIONES
  let chats = {};
  try {
    chats = await getJSON(`${REPORT_URL}/chats.json?token=${encodeURIComponent(REPORT_TOKEN)}`);
  } catch (e) {
    const msg = `⚠️ NICO — RESUMEN DIARIO ${fechaPretty}\n✅ Salud: OK\n⚠️ No pude leer las conversaciones (${e}). Revisar token de lectura.`;
    await report(msg);
    console.log(JSON.stringify({ saludOk: true, chatsError: String(e) }));
    return;
  }

  const calientes = [], tibios = [], frios = [];
  let derivados = 0, nuevas = 0;

  for (const key of Object.keys(chats)) {
    const c = chats[key];
    if (!c || !Array.isArray(c.messages)) continue;
    const userId = String(c.userId || key);
    if (userId.includes(GERMAN_PHONE)) continue; // excluir reportes internos de German

    // mensajes con actividad de ayer/hoy
    const msgsRecientes = c.messages.filter((m) => m.at && diasObjetivo.has(arDate(new Date(m.at))));
    if (msgsRecientes.length === 0) continue;
    nuevas++;

    const userTexts = c.messages.filter((m) => m.role !== "nico").map((m) => m.text || "");
    const nicoTexts = c.messages.filter((m) => m.role === "nico").map((m) => m.text || "");
    const nivel = clasificar(userTexts.join(" "));
    const busca = extraer(userTexts) || "consulta general";
    const codigos = refs(nicoTexts);
    const fueDerivado = derivado(nicoTexts);
    if (fueDerivado) derivados++;

    const plat = c.channel === "wa" ? "wa" : c.channel === "fb" ? "fb" : c.channel === "ig" ? "ig" : (c.channel || "?");
    const nombre = c.waName || c.name || userId;
    const refTxt = codigos.length ? ` — [${codigos.join(", ")}]` : "";
    const linea = `${nombre} (${plat}) — ${busca}${refTxt}`;
    if (nivel === "caliente") calientes.push(linea);
    else if (nivel === "tibio") tibios.push(linea);
    else frios.push(linea);
  }

  // 3. RESUMEN
  let msg;
  if (nuevas === 0) {
    msg = `✅ Nico OK — sin conversaciones nuevas ayer. (${fechaPretty})`;
  } else {
    msg = `📊 NICO — RESUMEN DIARIO ${fechaPretty}\n`;
    msg += `✅ Salud: OK\n`;
    msg += `💬 Conversaciones nuevas: ${nuevas}\n`;
    msg += `🔴 Calientes: ${calientes.length}\n`;
    calientes.forEach((l) => (msg += `   • ${l}\n`));
    msg += `🟡 Tibios: ${tibios.length}\n`;
    tibios.forEach((l) => (msg += `   • ${l}\n`));
    if (frios.length) msg += `⚪ Frios/otros: ${frios.length}\n`;
    msg += `📈 Derivados a Germán: ${derivados}`;
  }

  const res = await report(msg);
  console.error(`[monitor] enviado=${res.ok} nuevas=${nuevas} calientes=${calientes.length} tibios=${tibios.length} derivados=${derivados}`);
  console.log(JSON.stringify({ saludOk: true, nuevas, calientes: calientes.length, tibios: tibios.length, frios: frios.length, derivados, enviado: res.ok }));
})();
