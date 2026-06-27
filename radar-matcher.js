// radar-matcher.js — Motor de matching del Radar Inmobiliario (CERO tokens LLM).
//
// Reemplaza el trabajo que antes hacía Claude (leer mensajes, filtrar búsquedas,
// cruzar con la cartera de Germán, clasificar 🔴/🟡 y armar el reporte) por lógica
// pura de JavaScript. El navegador (Claude/Playwright/cron) solo scrapea texto
// crudo de los grupos y se lo manda a Nico al endpoint /radar; este módulo hace
// todo el análisis sin gastar un solo token.
//
// Beneficio: el Radar pasa de costar miles de tokens por corrida a costar $0.

// ─────────────────────────────────────────────────────────────────────────────
// CARTERA DE GERMÁN — zonas, tipos y rangos de precio (USD)
// Cada zona tiene aliases (cómo la gente la escribe) y un rango [min, max].
// ─────────────────────────────────────────────────────────────────────────────
export const CARTERA = [
  {
    nombre: "Amarras Center / Puerto",
    aliases: ["amarras", "puerto", "puerto sf", "puerto santa fe", "amarras center"],
    tipos: ["departamento", "dpto", "depto", "semipiso", "monoambiente"],
    min: 150000,
    max: 400000,
  },
  {
    nombre: "Sargento Cabral / María Selva",
    aliases: ["sargento cabral", "cabral", "maria selva", "maría selva", "selva"],
    tipos: ["casa", "departamento", "dpto", "depto", "ph", "duplex"],
    min: 80000,
    max: 150000,
  },
  {
    nombre: "Constituyentes",
    aliases: ["constituyentes", "constituyente"],
    tipos: ["casa", "ph", "duplex", "chalet"],
    min: 150000,
    max: 250000,
  },
  {
    nombre: "Candioti Norte / Sur",
    aliases: ["candioti", "candioti norte", "candioti sur"],
    tipos: ["casa", "departamento", "dpto", "depto", "ph"],
    min: 80000,
    max: 200000,
  },
  {
    nombre: "Sauce Viejo / Fraga / Aeropuerto (country)",
    aliases: ["sauce viejo", "sauce", "fraga", "aeropuerto", "country", "countrie", "barrio cerrado"],
    tipos: ["casa", "chalet", "quinta"],
    min: 150000,
    max: 300000,
  },
  {
    nombre: "Barrio Sur (4 de Enero / Sara Faisal)",
    aliases: ["barrio sur", "4 de enero", "cuatro de enero", "sara faisal", "faisal"],
    tipos: ["casa", "ph", "duplex"],
    min: 150000,
    max: 250000,
  },
  {
    nombre: "Flipping / A refaccionar (cualquier zona)",
    aliases: ["refaccionar", "a reciclar", "reciclar", "para reformar", "reformar", "flipping", "a refaccion", "a refacción", "demoler", "para refaccionar"],
    tipos: ["casa", "ph", "departamento", "dpto", "depto", "terreno", "lote"],
    min: 0,
    max: 90000,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// FILTRO DE BÚSQUEDAS — palabras que indican que alguien BUSCA (no que ofrece)
// ─────────────────────────────────────────────────────────────────────────────
const KEYWORDS_BUSQUEDA = [
  "busco", "búsqueda", "busqueda", "necesito", "buscamos", "urgente",
  "encadenada", "para compra", "cliente busca", "alquilo", "quiero alquilar",
  "necesito alquilar", "estoy buscando", "alguien tiene", "se busca",
  "preciso", "requiero", "ando buscando", "busca cliente", "tengo cliente",
];

// Frases que indican OFERTA de venta pura (descartar)
const KEYWORDS_OFERTA = [
  "vendo", "en venta", "se vende", "oferta", "disponible para la venta",
  "excelente oportunidad de inversion", "tomo permuta", "escucho ofertas",
];

// ─────────────────────────────────────────────────────────────────────────────
// Parser de presupuesto (USD) — "USD 150.000", "150 mil", "150k", "1,5 millones"
// ─────────────────────────────────────────────────────────────────────────────
export function parseUSD(str) {
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

// Normaliza texto: minúsculas, sin acentos, espacios colapsados
export function normalizar(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Detección de intención de búsqueda
// ─────────────────────────────────────────────────────────────────────────────
export function esBusqueda(texto) {
  const t = normalizar(texto);
  if (!t || t.length < 8) return false;
  const tieneBusqueda = KEYWORDS_BUSQUEDA.some((k) => t.includes(normalizar(k)));
  if (!tieneBusqueda) return false;
  // Si es claramente una oferta de venta y NO menciona buscar/cliente, descartar
  const esOferta = KEYWORDS_OFERTA.some((k) => t.includes(normalizar(k)));
  const mencionaCliente = /cliente|busco|buscamos|necesito|preciso|requiero/.test(t);
  if (esOferta && !mencionaCliente) return false;
  return true;
}

// Detecta el tipo de operación (compra/alquiler)
export function detectarOperacion(texto) {
  const t = normalizar(texto);
  if (/alquil|renta|locacion|locación/.test(t)) return "alquiler";
  if (/compr|venta|adquir|invertir|inversion|inversión/.test(t)) return "compra";
  return "indefinido";
}

// Detecta el tipo de propiedad
export function detectarTipo(texto) {
  const t = normalizar(texto);
  if (/departamento|depto|dpto|monoambiente|semipiso|mono ambiente/.test(t)) return "departamento";
  if (/terreno|lote/.test(t)) return "terreno";
  if (/local|galpon|galpón|oficina|deposito|depósito/.test(t)) return "comercial";
  if (/quinta/.test(t)) return "quinta";
  if (/casa|ph|duplex|dúplex|chalet|vivienda/.test(t)) return "casa";
  return "indefinido";
}

// Extrae presupuesto del texto (busca patrones de dinero)
export function detectarPresupuesto(texto) {
  const t = normalizar(texto);
  // Buscar "usd 150000", "u$s 150.000", "150 mil", "150k", "1,5 millones", "hasta 200000"
  const patrones = [
    /(?:usd|u\$s|us\$|dolares|dólares|dol)\s*([\d][\d.,]*)\s*(millones?|mill|mil|k)?/i,
    /([\d][\d.,]*)\s*(millones?|mill|mil|k)\b/i,
    /(?:hasta|maximo|máximo|presupuesto|tope|rondando|aprox)\s*(?:de\s*)?([\d][\d.,]*)\s*(millones?|mill|mil|k)?/i,
  ];
  for (const re of patrones) {
    const m = t.match(re);
    if (m) {
      const val = parseUSD(m[1] + " " + (m[2] || ""));
      // Filtrar valores absurdos (ej: un teléfono). Rango razonable inmobiliario.
      if (val && val >= 10000 && val <= 5000000) return val;
    }
  }
  return null;
}

// Detecta la zona mencionada y devuelve la entrada de cartera que matchea
export function detectarZona(texto) {
  const t = normalizar(texto);
  for (const zona of CARTERA) {
    for (const alias of zona.aliases) {
      if (t.includes(normalizar(alias))) return zona;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCHING — cruza una búsqueda con la cartera y devuelve tier + detalles
// ─────────────────────────────────────────────────────────────────────────────
export function matchearConCartera(texto) {
  if (!esBusqueda(texto)) return null;

  const zona = detectarZona(texto);
  const tipo = detectarTipo(texto);
  const operacion = detectarOperacion(texto);
  const presupuesto = detectarPresupuesto(texto);

  // Sin zona de la cartera = no nos sirve (descartar)
  if (!zona) return null;

  // Evaluar fuerza del match
  let puntos = 0;
  let motivos = [];

  // Zona matchea siempre (ya filtrado arriba)
  puntos += 2;
  motivos.push(`zona ${zona.nombre}`);

  // Tipo coincide con los tipos de esa zona
  const tipoOk = tipo !== "indefinido" && zona.tipos.includes(tipo);
  if (tipoOk) {
    puntos += 1;
    motivos.push(`tipo ${tipo}`);
  }

  // Presupuesto dentro del rango de la zona
  let presupuestoOk = false;
  if (presupuesto) {
    if (presupuesto >= zona.min && presupuesto <= zona.max) {
      presupuestoOk = true;
      puntos += 2;
      motivos.push(`presupuesto USD ${presupuesto.toLocaleString("es-AR")} en rango`);
    } else {
      // Tiene presupuesto pero fuera de rango → resta fuerza
      motivos.push(`presupuesto USD ${presupuesto.toLocaleString("es-AR")} (fuera de rango ${zona.min}-${zona.max})`);
    }
  }

  // Clasificación:
  // 🔴 CALIENTE: zona exacta + (tipo OK o presupuesto en rango) y nada fuera de rango
  // 🟡 TIBIO: zona matchea pero faltan datos o presupuesto algo ajustado
  let tier;
  if (puntos >= 4 && (presupuestoOk || tipoOk)) {
    tier = "caliente";
  } else {
    tier = "tibio";
  }

  return {
    tier,
    zonaCartera: zona.nombre,
    tipo,
    operacion,
    presupuesto,
    presupuestoOk,
    motivos,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash simple para deduplicación (evita reportar 2 veces el mismo mensaje)
// ─────────────────────────────────────────────────────────────────────────────
export function hashMensaje(texto) {
  const t = normalizar(texto).slice(0, 200);
  let h = 0;
  for (let i = 0; i < t.length; i++) {
    h = (h << 5) - h + t.charCodeAt(i);
    h |= 0;
  }
  return "r" + Math.abs(h).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// ANÁLISIS PRINCIPAL — recibe mensajes crudos y devuelve matches clasificados
//
// items: array de { texto, plataforma, grupo, contacto }
// yaVistos: Set de hashes ya reportados (para dedup)
// ─────────────────────────────────────────────────────────────────────────────
export function analizarMensajes(items, yaVistos = new Set()) {
  const calientes = [];
  const tibios = [];
  const nuevosHashes = [];

  for (const item of items || []) {
    const texto = item && item.texto ? String(item.texto) : "";
    if (!texto.trim()) continue;

    const hash = hashMensaje(texto);
    if (yaVistos.has(hash)) continue; // ya reportado antes (o duplicado en este mismo lote)

    const match = matchearConCartera(texto);
    if (!match) continue;

    yaVistos.add(hash); // marcar inmediatamente para deduplicar dentro del lote
    nuevosHashes.push(hash);
    const registro = {
      ...match,
      texto: texto.slice(0, 280),
      plataforma: item.plataforma || "?",
      grupo: item.grupo || "?",
      contacto: item.contacto || null,
      hash,
    };
    if (match.tier === "caliente") calientes.push(registro);
    else tibios.push(registro);
  }

  return { calientes, tibios, nuevosHashes };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCCIÓN DEL REPORTE (texto plano para WhatsApp)
// ─────────────────────────────────────────────────────────────────────────────
export function construirReporte(resultado, hora) {
  const { calientes, tibios } = resultado;
  if (!calientes.length && !tibios.length) return null;

  const h = hora || new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const lineas = [`🏠 RADAR INMOBILIARIO — ${h}`, ""];

  const fmt = (m) => {
    const cab = `• ${m.contacto || "Sin contacto"} — ${m.plataforma}: ${m.grupo}`;
    const datos = [
      m.tipo !== "indefinido" ? m.tipo : null,
      m.operacion !== "indefinido" ? m.operacion : null,
      m.presupuesto ? `USD ${m.presupuesto.toLocaleString("es-AR")}` : null,
    ].filter(Boolean).join(" · ");
    const linMatch = `  → Match: ${m.zonaCartera}`;
    const linTexto = `  "${m.texto.replace(/\n/g, " ").slice(0, 160)}"`;
    return [cab, datos ? `  ${datos}` : null, linMatch, linTexto].filter(Boolean).join("\n");
  };

  if (calientes.length) {
    lineas.push("🔴 CALIENTES:");
    calientes.forEach((m) => lineas.push(fmt(m)));
    lineas.push("");
  }
  if (tibios.length) {
    lineas.push("🟡 TIBIOS:");
    tibios.forEach((m) => lineas.push(fmt(m)));
    lineas.push("");
  }

  lineas.push(`Total: ${calientes.length} calientes | ${tibios.length} tibios`);
  return lineas.join("\n");
}
