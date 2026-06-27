#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SYNC DIARIO DEL INVENTARIO WEB DE MEGA  →  knowledge-base.md
// ─────────────────────────────────────────────────────────────────────────────
// Reemplaza al agente de Claude que corria en Chrome (cero tokens LLM).
// Corre 100% en codigo: scrapea la API REST publica de inmobiliariamega.com.ar,
// arma la seccion "## INVENTARIO COMPLETO MEGA WEB", detecta altas/bajas, y si
// hubo cambios reales commitea knowledge-base.md a main via API de GitHub y le
// avisa a German por WhatsApp (POST /report).
//
// Formato de salida IDENTICO al del agente original (mismo Intl/localeCompare),
// para que los diffs sean limpios.
//
// USO:
//   GITHUB_TOKEN=ghu_xxx node tasks/sync-inventario.mjs
//
// VARIABLES DE ENTORNO:
//   GITHUB_TOKEN  (requerido para commitear; si falta -> dry-run automatico)
//   REPORT_TOKEN  (default 'mega-radar-2024')  -> POST /report
//   REPORT_URL    (default https://mega-agente-production.up.railway.app)
//   REPO          (default germanomanzur-cyber/mega-agente)
//   DRY_RUN=1     (genera y diffea, NO commitea ni reporta)
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://inmobiliariamega.com.ar/wp-json/wp/v2/";
const REPO = process.env.REPO || "germanomanzur-cyber/mega-agente";
const REPORT_URL = (process.env.REPORT_URL || "https://mega-agente-production.up.railway.app").replace(/\/$/, "");
const REPORT_TOKEN = process.env.REPORT_TOKEN || "mega-radar-2024";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN === "1" || !GITHUB_TOKEN;

const KB_FILE = "knowledge-base.md";
const MARKER = "## INVENTARIO COMPLETO MEGA WEB";
// Concurrencia moderada: con valores altos el servidor a veces devuelve paginas
// parciales (sin el bloque de precio). 6 + reintentos da extraccion estable.
const CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Localidades a excluir (fuera de zona de trabajo Santa Fe + Entre Rios).
const EXCL = new Set(["punta-del-este", "la-paloma", "departamento-de-rocha", "capital-federal", "buenos-aires"]);

const TIPO = {
  Casas: "Casa", Departamentos: "Departamento", Terrenos: "Terreno", Quintas: "Quinta",
  "Galpones y Cocheras": "Galpón/Cochera", "Locales y Oficinas Comerciales": "Local/Oficina",
  PH: "PH", Oficina: "Oficina", Office: "Oficina", Shop: "Local", Apartments: "Departamento", Duplexes: "Dúplex",
};

// ── helpers HTTP ─────────────────────────────────────────────────────────────
async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "nico-sync/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}
async function getText(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "nico-sync/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw new Error(`${lastErr} en ${url}`);
}

// ── scrape de la lista de propiedades + taxonomias ──────────────────────────
async function fetchProps() {
  let props = [], page = 1;
  while (true) {
    const a = await getJSON(`${BASE}estate_property?per_page=100&page=${page}&_fields=id,slug,link,title,property_action_category,property_city,property_category`);
    if (!a.length) break;
    props = props.concat(a.map((p) => ({
      id: p.id, slug: p.slug, link: p.link, title: p.title.rendered,
      action: (p.property_action_category || [])[0], cat: (p.property_category || [])[0], city: (p.property_city || [])[0],
    })));
    if (a.length < 100) break;
    page++;
  }
  return props;
}
async function taxMap(tax) {
  let m = {}, pg = 1;
  while (true) {
    const a = await getJSON(`${BASE}${tax}?per_page=100&page=${pg}&_fields=id,name,slug`);
    if (!a.length) break;
    a.forEach((x) => (m[x.id] = { name: x.name, slug: x.slug }));
    if (a.length < 100) break;
    pg++;
  }
  return m;
}

// ── parse de la ficha individual (regex, sin DOM) ───────────────────────────
function stripTags(s) {
  // Replicamos la semantica de textContent del navegador: quitamos los tags SIN
  // insertar espacio. Asi "280 m<sup>2</sup>" -> "280 m2" (y no "280 m 2"), que
  // es lo que leia el agente original. La superficie sale del widget de detalles,
  // no de la descripcion, igual que en el browser.
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
function parseFicha(html, p, maps) {
  const { cities, cats, acts } = maps;
  // precio: primer div con clase price_area
  let price = "";
  const pm = html.match(/<div class="price_area[^"]*">([\s\S]*?)<\/div>/i);
  if (pm) price = stripTags(pm[1]);
  // localidad: primer <a> que apunte a /localidad/
  const lm = html.match(/<a[^>]*href="[^"]*\/localidad\/[^"]*"[^>]*>([^<]+)<\/a>/i);
  const cityA = lm ? lm[1].trim() : "";
  // dorm / banos / superficie: del texto plano
  const bt = stripTags(html);
  const rooms = (bt.match(/(\d+)\s+Habitaciones/) || [])[1] || "";
  const baths = (bt.match(/(\d+)\s+Ba[ñn]os/) || [])[1] || "";
  const size = (bt.match(/([\d.,]+)\s*m2/) || [])[1] || "";
  return {
    slug: p.slug, link: p.link, title: p.title,
    op: (acts[p.action] || {}).name || "",
    catName: (cats[p.cat] || {}).name || "",
    citySlug: (cities[p.city] || {}).slug || "",
    cityName: cityA || (cities[p.city] || {}).name || "",
    price, rooms, baths, size,
  };
}

async function scrapeAll() {
  const [props, cities, cats, acts] = await Promise.all([
    fetchProps(), taxMap("property_city"), taxMap("property_category"), taxMap("property_action_category"),
  ]);
  const maps = { cities, cats, acts };
  const propsToScan = process.env.PROPS_LIMIT ? props.slice(0, +process.env.PROPS_LIMIT) : props;
  const rows = [];
  let i = 0;
  async function worker() {
    while (i < propsToScan.length) {
      const p = propsToScan[i++];
      try {
        let row = parseFicha(await getText(p.link), p, maps);
        // Si la pagina vino parcial (sin precio), reintentamos una vez mas: el
        // sitio a veces sirve una version incompleta bajo carga.
        if (row.price === "") {
          await sleep(500);
          const row2 = parseFicha(await getText(p.link), p, maps);
          if (row2.price !== "") row = row2;
        }
        rows.push(row);
      } catch (e) {
        rows.push({ slug: p.slug, err: String(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { props, rows };
}

// ── construccion de la seccion (formato identico al agente original) ─────────
function buildSection(rows) {
  const np = (s) => {
    if (!s) return "Consultar";
    if (/s\/?\s*precio|consultar/i.test(s)) return "Consultar";
    const m = s.match(/([\d][\d.,]*)/);
    if (!m) return "Consultar";
    const n = parseInt(m[1].replace(/[.,]/g, ""), 10);
    if (isNaN(n) || n === 0) return "Consultar";
    return (/ARS/i.test(s) ? "ARS" : "USD") + " " + n.toLocaleString("de-DE");
  };
  const db = (r) => (r.rooms === "" && r.baths === "") ? "-" : `${r.rooms !== "" ? r.rooms : "0"}D/${r.baths !== "" ? r.baths : "0"}B`;
  const sup = (r) => (r.size && r.size !== "0") ? `${r.size} m2` : "-";
  const op = (r) => (r.op === "Alquileres" ? "Alquiler" : "Venta");
  const line = (r) => `- ${TIPO[r.catName] || r.catName || "-"} | ${r.title.replace(/\s+/g, " ").trim()} | ${op(r)} ${np(r.price)} | ${db(r)} | ${sup(r)} | ${r.link}`;

  const byCity = {};
  let inc = 0;
  rows.forEach((r) => {
    if (r.err || EXCL.has(r.citySlug)) return;
    (byCity[r.cityName || "Otros"] = byCity[r.cityName || "Otros"] || []).push(r);
    inc++;
  });
  const cities = Object.keys(byCity).sort((a, b) => a.localeCompare(b, "es"));
  const today = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const manifest = rows.filter((r) => !r.err && !EXCL.has(r.citySlug)).map((r) => r.slug).sort();

  let s = `${MARKER} — ${inc} PROPIEDADES (sincronizado ${today})\n\n`;
  s += `Instrucciones:\n`;
  s += `- Cuando pregunten por zona, presupuesto o dormitorios, buscar acá y ofrecer máximo 3 opciones con precio y datos clave. Cerrar derivando a Germán: https://wa.me/5493424287842\n`;
  s += `- La referencia es el LINK de la ficha: compartirlo con el cliente si pide fotos o más información.\n`;
  s += `- Orden de prioridad al ofrecer: 1° cartera directa de Germán (Prioridad 1), 2° este inventario web de MEGA, 3° Tokko / Mercado Único (Prioridad 3).\n`;
  s += `- Si no hay match exacto, ofrecer lo más cercano (zona vecina o rango superior/inferior).\n`;
  s += `- Disponibilidad sujeta a confirmación de Germán. Inventario sincronizado automáticamente todos los días 09:00 desde inmobiliariamega.com.ar (Santa Fe + Entre Ríos).\n\n`;
  s += `Formato: Tipo | Título | Operación y precio | Dorm/Baños | Superficie | Link ficha\n\n`;
  s += `<!-- MEGA_WEB_MANIFEST_START\n${manifest.join(",")}\nMEGA_WEB_MANIFEST_END -->\n`;
  cities.forEach((c) => {
    s += `\n### ${c}\n\n`;
    byCity[c].sort((a, b) => op(a).localeCompare(op(b)) || a.title.localeCompare(b.title, "es"));
    s += byCity[c].map(line).join("\n") + "\n";
  });
  return { section: s, count: inc, manifest };
}

// ── diff contra el knowledge-base actual ────────────────────────────────────
function manifestOf(text) {
  const m = text.match(/MEGA_WEB_MANIFEST_START\n([\s\S]*?)\nMEGA_WEB_MANIFEST_END/);
  return new Set(m && m[1] ? m[1].split(",") : []);
}
function stripHeader(t) {
  return t.replace(/^## INVENTARIO COMPLETO MEGA WEB.*\n/, "");
}
function buildDiff(current, newSection) {
  const h = current.indexOf(MARKER);
  const base = h >= 0 ? current.slice(0, h) : current.replace(/\s*$/, "") + "\n\n---\n\n";
  const curSection = h >= 0 ? current.slice(h) : "";
  const oldSet = manifestOf(curSection);
  const newSet = manifestOf(newSection);
  const altas = [...newSet].filter((x) => !oldSet.has(x));
  const bajas = [...oldSet].filter((x) => !newSet.has(x));
  const changed = stripHeader(curSection).trim() !== stripHeader(newSection).trim();
  return { final: base + newSection, altas, bajas, changed, total: newSet.size, oldTotal: oldSet.size };
}

// ── GitHub API: leer + commitear ────────────────────────────────────────────
async function ghGetFile() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${KB_FILE}?ref=main`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "nico-sync" },
  });
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, content: Buffer.from(j.content, "base64").toString("utf-8") };
}
async function ghGetFileRaw() {
  // sin token: leemos el raw publico para dry-run
  return getText(`https://raw.githubusercontent.com/${REPO}/main/${KB_FILE}?ts=${Date.now()}`);
}
async function ghCommit(content, sha, message) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${KB_FILE}`, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "nico-sync", "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content, "utf-8").toString("base64"), sha, branch: "main" }),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── aviso a German por WhatsApp ─────────────────────────────────────────────
async function report(message) {
  try {
    const r = await fetch(`${REPORT_URL}/report`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: REPORT_TOKEN, message }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
async function healthOk() {
  try {
    const j = await getJSON(`${REPORT_URL}/health`);
    return j && j.status === "ok";
  } catch { return false; }
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.error(`[sync] scrapeando inventario (concurrency=${CONCURRENCY})...`);
    const { props, rows } = await scrapeAll();
    const errors = rows.filter((r) => r.err).length;
    console.error(`[sync] props=${props.length} rows=${rows.length} errores=${errors}`);

    // Guardas de seguridad: scrape sospechoso -> NO commitear.
    if (rows.length < 50 || errors > rows.length * 0.05) {
      const msg = `Sync inventario web Nico FALLO en scrape: rows=${rows.length} errores=${errors}. No se commiteo.`;
      console.error("[sync] " + msg);
      if (!DRY_RUN) await report(msg);
      process.exit(2);
    }

    const { section, count } = buildSection(rows);

    // Estado actual del knowledge-base.
    let current, sha = null;
    if (DRY_RUN) {
      current = await ghGetFileRaw();
    } else {
      const f = await ghGetFile();
      current = f.content;
      sha = f.sha;
    }

    const diff = buildDiff(current, section);
    if (process.env.DUMP_DIR) {
      const fs = await import("fs");
      fs.writeFileSync(`${process.env.DUMP_DIR}/newsection.txt`, section);
      fs.writeFileSync(`${process.env.DUMP_DIR}/cursection.txt`, current.slice(current.indexOf(MARKER)));
      fs.writeFileSync(`${process.env.DUMP_DIR}/rows.json`, JSON.stringify(rows.map((r) => ({ slug: r.slug, price: r.price, size: r.size, rooms: r.rooms, baths: r.baths, err: r.err })), null, 1));
      console.error(`[sync] dump escrito en ${process.env.DUMP_DIR}`);
    }
    console.error(`[sync] changed=${diff.changed} total=${diff.total} (antes ${diff.oldTotal}) altas=${diff.altas.length} bajas=${diff.bajas.length}`);
    if (diff.altas.length) console.error("[sync] ALTAS: " + diff.altas.slice(0, 12).join(", "));
    if (diff.bajas.length) console.error("[sync] BAJAS: " + diff.bajas.slice(0, 12).join(", "));

    if (!diff.changed) {
      const msg = `Sync inventario web Nico: sin cambios. ${diff.total} props publicadas.`;
      console.error("[sync] " + msg);
      if (!DRY_RUN) await report(msg);
      console.log(JSON.stringify({ changed: false, total: diff.total, altas: 0, bajas: 0, dryRun: DRY_RUN }));
      process.exit(0);
    }

    if (DRY_RUN) {
      console.error("[sync] DRY_RUN: no se commitea ni reporta. (faltaria GITHUB_TOKEN)");
      console.log(JSON.stringify({ changed: true, total: diff.total, altas: diff.altas.length, bajas: diff.bajas.length, dryRun: true }));
      process.exit(0);
    }

    // Commit a main.
    const commitMsg = `Sync diaria inventario web MEGA: ${diff.total} props (altas ${diff.altas.length}, bajas ${diff.bajas.length})`;
    await ghCommit(diff.final, sha, commitMsg);
    console.error("[sync] commit OK -> main");

    // Verificar deploy + avisar a German.
    const dep = (await healthOk()) ? "Deploy OK" : "Deploy sin confirmar";
    const altasTxt = diff.altas.slice(0, 8).join(", ") || "-";
    const bajasTxt = diff.bajas.slice(0, 8).join(", ") || "-";
    const msg = `Sync inventario web Nico OK. Total: ${diff.total} props. Altas: ${diff.altas.length} (${altasTxt}). Bajas: ${diff.bajas.length} (${bajasTxt}). ${dep}.`;
    await report(msg);
    console.error("[sync] aviso enviado a German");

    console.log(JSON.stringify({ changed: true, total: diff.total, altas: diff.altas.length, bajas: diff.bajas.length, dryRun: false }));
    process.exit(0);
  } catch (e) {
    const msg = `Sync inventario web Nico FALLO: ${String(e)}. No se commiteo.`;
    console.error("[sync] ERROR " + msg);
    if (!DRY_RUN) await report(msg);
    process.exit(1);
  }
})();
