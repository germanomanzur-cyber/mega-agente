// cartera-parser.js — Lee knowledge-base.md y extrae la CARTERA DIRECTA de Germán
// (PRIORIDAD 1) como objetos estructurados con código Tokko, zona, tipo y precio.
//
// Se usa para el cruce automático del Radar Web: dada una señal de demanda
// (zona + tipo + presupuesto), busca qué propiedad de Germán "CALZA" y cita su
// código Tokko — todo en código, sin gastar tokens de LLM.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, "knowledge-base.md");

// Mapa de palabras → zona normalizada de la cartera (para clasificar cada propiedad)
const ZONA_HINTS = [
  { re: /amarras|puerto/i, zona: "Amarras Center / Puerto" },
  { re: /candioti/i, zona: "Candioti Norte / Sur" },
  { re: /constituyentes/i, zona: "Constituyentes" },
  { re: /sauce viejo|fraga|aeropuerto|villa california|arroyo aguiar/i, zona: "Sauce Viejo / Fraga / Aeropuerto (country)" },
  { re: /4 de enero|sara faisal|barrio sur/i, zona: "Barrio Sur (4 de Enero / Sara Faisal)" },
  { re: /sargento cabral|maria selva|maría selva/i, zona: "Sargento Cabral / María Selva" },
  { re: /flipping|refaccion|refacción|centenario|o.higgins|a reciclar/i, zona: "Flipping / A refaccionar (cualquier zona)" },
];

function detectarZonaProp(texto) {
  for (const h of ZONA_HINTS) if (h.re.test(texto)) return h.zona;
  return null;
}

// Detecta el tipo priorizando el TÍTULO (más fiable que la descripción, que
// puede mencionar "terreno", "lote", etc. como característica secundaria).
function detectarTipoProp(titulo, descripcion) {
  const tit = (titulo || "").toLowerCase();
  // 1) Por título (prioritario)
  if (/departamento|depto|dpto|monoambiente|semipiso|pilay|torre|piso \d|amarras/.test(tit)) return "departamento";
  if (/quinta/.test(tit)) return "quinta";
  if (/\bcasa\b|\bph\b|duplex|chalet/.test(tit)) return "casa";
  if (/\bterreno\b|\blote\b/.test(tit)) return "terreno";
  if (/local|galpon|oficina/.test(tit)) return "comercial";
  // 2) Si el título no alcanza, mirar descripción completa
  const t = ((titulo || "") + " " + (descripcion || "")).toLowerCase();
  if (/departamento|depto|dpto|monoambiente|semipiso/.test(t)) return "departamento";
  if (/quinta/.test(t)) return "quinta";
  if (/casa|ph|duplex|chalet|vivienda|dormitorio/.test(t)) return "casa";
  if (/terreno|lote/.test(t)) return "terreno";
  if (/local|galpon|oficina/.test(t)) return "comercial";
  return "indefinido";
}

function parsePrecio(texto) {
  // Prioridad 1: "USD 35.000 total" (el precio total siempre gana sobre USD/m²)
  let m = texto.match(/USD\s*([\d.]+)\s*total/i);
  // Prioridad 2: primer USD que NO sea precio por m² (descartar "USD 310/m²")
  if (!m) {
    const matches = [...texto.matchAll(/USD\s*([\d.]+)(\s*\/?\s*m²|\/m2)?/gi)];
    m = matches.find((x) => !x[2]) || matches[0] || null;
  }
  if (!m) return null;
  const n = parseInt(m[1].replace(/\./g, ""), 10);
  return isNaN(n) ? null : n;
}

let _carteraCache = null;
let _carteraMtime = 0;

// Parsea la sección PRIORIDAD 1 del knowledge-base en propiedades estructuradas.
// Cachea el resultado y lo recarga solo si el archivo cambió.
export function getCartera() {
  try {
    const stat = fs.statSync(KB_PATH);
    if (_carteraCache && stat.mtimeMs === _carteraMtime) return _carteraCache;

    const kb = fs.readFileSync(KB_PATH, "utf8");
    const a = kb.indexOf("PRIORIDAD 1");
    const b = kb.indexOf("PRIORIDAD 2");
    const seccion = a >= 0 ? kb.slice(a, b > a ? b : undefined) : kb;

    // Cada propiedad arranca con "**N. Titulo**"
    const bloques = seccion.split(/\n(?=\*\*\d+\.)/);
    const props = [];
    for (const bloque of bloques) {
      const tituloM = bloque.match(/\*\*\d+\.\s*(.+?)\*\*/);
      const tokkoM = bloque.match(/Ref Tokko:\s*([A-Z0-9]+)/i);
      if (!tituloM || !tokkoM) continue;
      const titulo = tituloM[1].trim();
      const fichaM = bloque.match(/Ficha:\s*(https?:\/\/\S+)/i);
      props.push({
        titulo,
        tokko: tokkoM[1].trim(),
        zona: detectarZonaProp(bloque) || detectarZonaProp(titulo),
        tipo: detectarTipoProp(titulo, bloque),
        precio: parsePrecio(bloque),
        ficha: fichaM ? fichaM[1].trim() : null,
      });
    }
    _carteraCache = props;
    _carteraMtime = stat.mtimeMs;
    return props;
  } catch (e) {
    console.error("[CARTERA] Error parseando knowledge-base.md:", e.message);
    return _carteraCache || [];
  }
}

// Dada una señal (zona, tipo, presupuesto), devuelve la propiedad de Germán que
// mejor "CALZA", o null si no hay match. Cita código Tokko.
// Tolerancia de precio: ±35% sobre el presupuesto de la demanda.
export function buscarCalce({ zona, tipo, presupuesto }) {
  const cartera = getCartera();
  if (!cartera.length) return null;

  const candidatos = cartera.filter((p) => {
    // Zona debe coincidir (si la señal trae zona de cartera)
    if (zona && p.zona && p.zona !== zona) return false;
    // Tipo debe coincidir si ambos están definidos
    if (tipo && tipo !== "indefinido" && p.tipo !== "indefinido" && p.tipo !== tipo) return false;
    // Precio dentro de tolerancia si la señal trae presupuesto
    if (presupuesto && p.precio) {
      if (p.precio > presupuesto * 1.35) return false; // muy caro para el cliente
    }
    return true;
  });

  if (!candidatos.length) return null;

  // Priorizar: match de zona + tipo + precio más cercano al presupuesto
  candidatos.sort((x, y) => {
    const px = presupuesto && x.precio ? Math.abs(x.precio - presupuesto) : Infinity;
    const py = presupuesto && y.precio ? Math.abs(y.precio - presupuesto) : Infinity;
    return px - py;
  });

  return candidatos[0];
}
