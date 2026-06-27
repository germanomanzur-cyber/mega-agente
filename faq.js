// faq.js — Respuestas instantáneas SIN consumir tokens del LLM.
//
// Cada respuesta de este módulo evita una llamada a Groq. Se usa SOLO para
// consultas informativas claras de leads "fríos" (no compradores activos),
// de modo que el embudo de calificación con IA sigue intacto para los leads
// tibios/calientes. Objetivo: bajar costo manteniendo la calidad.

const WA = "https://wa.me/5493424287842";

// Si el mensaje muestra intención real de búsqueda/compra, NO usamos FAQ:
// dejamos que el flujo de calificación del LLM tome el control.
function tieneIntencionBusqueda(t) {
  return /\b(busco|buscando|quiero comprar|quiero ver|me interesa|interesad|mostrame|mostr[aá]|ten[eé]s|hay|disponible|propiedad|propiedades|casa|casas|depto|departamento|terreno|lote|quinta|monoambiente|cochera|invertir|inversi[oó]n)\b/i.test(t);
}

// Devuelve una respuesta lista (string) o null si no aplica ninguna FAQ.
export function matchFAQ(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (t.length < 4) return null;
  if (tieneIntencionBusqueda(t)) return null;

  // 1) Contacto / agendar visita / hablar con Germán
  if (/\b(agendar|agenda|coordinar|coordino|visita|visitar|turno|cita|hablar con german|contacto|tel[eé]fono|telefono|whatsapp de german|n[uú]mero de german)\b/.test(t)) {
    return `Para coordinar una visita o hablar directo con Germán Manzur, escribile por WhatsApp: ${WA}\nÉl te responde personalmente y coordina el horario que mejor te quede.`;
  }

  // 2) Créditos hipotecarios (Nido / UVA / bancos)
  if (/\b(cr[eé]dito|credito|hipotecari|nido|uva|financiaci[oó]n|financiacion|pr[eé]stamo|prestamo|banco|bancos)\b/.test(t)) {
    return `Sí, trabajamos con créditos hipotecarios. El Crédito Nido 2026 llega hasta $100M (requiere residencia en Santa Fe previa al 30/06/2024) con propiedades aptas en Barrio Sur. Bancos que aprueban solo con plano de mensura: Santa Fe, Macro y Credicoop. Germán te acompaña en todo el trámite: ${WA}`;
  }

  // 3) Permutas / parte de pago
  if (/\b(permuta|permutar|canje|canjear|parte de pago|entrego mi|entregar mi)\b/.test(t)) {
    return `Sí, evaluamos permutas caso a caso (por ejemplo quinta por departamento, o propiedad por propiedad). Germán analiza tu operación en detalle: ${WA}`;
  }

  // 4) Marco legal de alquileres
  if (/\b(ley de alquiler|marco legal|contrato de alquiler|requisitos para alquilar|garant[ií]a|dep[oó]sito)\b/.test(t)) {
    return `Desde el DNU 70/2023 la Ley de Alquileres está derogada: todo se pacta libremente entre las partes (plazo usual 12-24 meses, ajuste común trimestral por IPC, moneda según acuerdo). Garantías habituales: propietaria, seguro de caución o recibo de sueldo + codeudor. Para ver unidades disponibles escribile a Germán: ${WA}`;
  }

  // 5) Saludo de agradecimiento / cierre (evita gastar tokens en cortesías)
  if (/^(gracias|muchas gracias|mil gracias|perfecto|genial|buen[ií]simo|dale gracias|ok gracias|listo gracias)\b/.test(t)) {
    return `¡De nada! Cualquier consulta sobre propiedades en Santa Fe estoy para ayudarte. Y si querés avanzar, Germán te atiende directo por acá: ${WA}`;
  }

  return null;
}
