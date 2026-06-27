// test-radar.js — Tests del motor de matching del Radar (sin LLM, sin red).
// Ejecutar: node test-radar.js

import {
  esBusqueda, detectarZona, detectarTipo, detectarOperacion,
  detectarPresupuesto, matchearConCartera, analizarMensajes,
  construirReporte, hashMensaje,
} from "./radar-matcher.js";

let pasados = 0, fallados = 0;
function check(nombre, cond) {
  if (cond) { pasados++; console.log("✓ " + nombre); }
  else { fallados++; console.log("✗ FALLÓ: " + nombre); }
}

// ── esBusqueda
check("detecta 'busco depto'", esBusqueda("Busco departamento en zona puerto"));
check("detecta 'necesito alquilar'", esBusqueda("Necesito alquilar una casa urgente"));
check("descarta oferta de venta pura", !esBusqueda("Vendo casa en Candioti, excelente oportunidad"));
check("descarta texto corto", !esBusqueda("hola"));
check("acepta 'tengo cliente busca'", esBusqueda("Tengo cliente que busca casa en Constituyentes"));

// ── detectarZona
check("zona amarras", detectarZona("busco depto en amarras")?.nombre.includes("Amarras"));
check("zona candioti", detectarZona("casa en candioti norte")?.nombre.includes("Candioti"));
check("zona inexistente => null", detectarZona("busco en rosario centro") === null);

// ── detectarTipo
check("tipo departamento", detectarTipo("busco un dpto") === "departamento");
check("tipo casa", detectarTipo("quiero una casa") === "casa");
check("tipo terreno", detectarTipo("necesito un lote") === "terreno");

// ── detectarOperacion
check("operacion alquiler", detectarOperacion("quiero alquilar") === "alquiler");
check("operacion compra", detectarOperacion("busco para comprar") === "compra");

// ── detectarPresupuesto
check("presupuesto USD 150.000", detectarPresupuesto("hasta USD 150.000") === 150000);
check("presupuesto 150 mil", detectarPresupuesto("presupuesto 150 mil dolares") === 150000);
check("presupuesto 200k", detectarPresupuesto("tope 200k") === 200000);
check("ignora numero de telefono largo", detectarPresupuesto("llamame al 3424287842") === null);

// ── matchearConCartera
const m1 = matchearConCartera("Busco departamento en Amarras, presupuesto USD 180.000");
check("match caliente amarras", m1 && m1.tier === "caliente" && m1.zonaCartera.includes("Amarras"));

const m2 = matchearConCartera("Busco casa en Candioti");
check("match tibio sin presupuesto", m2 && m2.tier === "tibio");

const m3 = matchearConCartera("Vendo casa en Constituyentes");
check("oferta de venta => null", m3 === null);

const m4 = matchearConCartera("Busco depto en Rosario");
check("zona fuera de cartera => null", m4 === null);

const m5 = matchearConCartera("Necesito casa a refaccionar, hasta 80 mil");
check("flipping caliente", m5 && m5.tier === "caliente" && m5.zonaCartera.includes("Flipping"));

// ── dedup
const items = [
  { texto: "Busco departamento en Amarras USD 180.000", plataforma: "WA", grupo: "Solo Búsquedas", contacto: "Juan" },
  { texto: "Busco departamento en Amarras USD 180.000", plataforma: "WA", grupo: "Solo Búsquedas", contacto: "Juan" }, // duplicado exacto
  { texto: "Vendo casa hermosa en venta", plataforma: "FB", grupo: "Clasificados" }, // descartar
  { texto: "Tengo cliente que busca casa en Constituyentes hasta 200 mil", plataforma: "FB", grupo: "Zona Norte", contacto: "Marta" },
];
const r = analizarMensajes(items);
check("dedup: no cuenta duplicado exacto", r.calientes.length + r.tibios.length === 2);
check("dedup: genera hashes nuevos", r.nuevosHashes.length === 2);

// ── dedup contra yaVistos
const visto = new Set([hashMensaje("Busco departamento en Amarras USD 180.000")]);
const r2 = analizarMensajes(items, visto);
check("dedup: respeta yaVistos", (r2.calientes.length + r2.tibios.length) === 1);

// ── construirReporte
const rep = construirReporte(r);
check("reporte contiene encabezado", rep && rep.includes("RADAR INMOBILIARIO"));
check("reporte contiene calientes", rep && rep.includes("CALIENTES"));
check("reporte sin matches => null", construirReporte({ calientes: [], tibios: [] }) === null);

console.log(`\n── RESULTADO: ${pasados} pasados, ${fallados} fallados ──`);
process.exit(fallados ? 1 : 0);
