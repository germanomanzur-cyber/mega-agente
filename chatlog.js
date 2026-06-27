import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CHATS_FILE = path.join(DATA_DIR, "chats.json");

function load() {
  try {
    if (existsSync(CHATS_FILE)) {
      const data = JSON.parse(readFileSync(CHATS_FILE, "utf-8"));
      // Type-safety: el código asume un objeto (mapa por clave canal:userId).
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("chatlog: error leyendo chats.json:", e.message);
  }
  return {};
}

export function logMessage(channel, userId, role, text) {
  try {
    const chats = load();
    const key = channel + ":" + userId;
    if (!chats[key]) chats[key] = { channel, userId, messages: [] };
    chats[key].messages.push({ role, text: String(text).slice(0, 2000), at: new Date().toISOString() });
    if (chats[key].messages.length > 300) chats[key].messages = chats[key].messages.slice(-300);
    writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2), "utf-8");
  } catch (e) {
    console.error("chatlog error:", e.message);
  }
}

export function getChats() {
  return load();
}

