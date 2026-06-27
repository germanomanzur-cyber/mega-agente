// response-cache.js — Caché local de respuestas para evitar llamadas duplicadas al LLM.
//
// Detecta consultas muy similares (ej: "Hola" vs "hola!" vs "holaa") y reutiliza
// la respuesta reciente del LLM. Objetivo: reducir llamadas innecesarias sin
// sacrificar calidad de atención. El cache vence después de 1 hora.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
const cache = new Map(); // clave: texto normalizado -> { respuesta, timestamp }

// Normaliza un texto para comparación (lowercase, sin tildes, sin puntuación redundante)
function normalize(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/[¿?!¡.,:;]+/g, " ") // quita puntuación repetitiva
    .trim()
    .replace(/\s+/g, " ");
}

// Busca una respuesta en caché para un texto de usuario. Retorna la respuesta
// si existe y no venció, o null si no hay match o expiró.
export function getCachedResponse(userText) {
  const key = normalize(userText);
  if (!key || key.length < 3) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.response;
}

// Guarda una respuesta del LLM en caché para reutilizarla en consultas similares.
export function setCachedResponse(userText, response) {
  const key = normalize(userText);
  if (!key || key.length < 3 || !response) return;
  cache.set(key, { response, timestamp: Date.now() });
  // Limpia cache cada 100 inserciones para evitar memory leak en sesiones largas
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now - v.timestamp > CACHE_TTL_MS) cache.delete(k);
    }
  }
}
