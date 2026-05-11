// test-local.js — Probá el agente en terminal antes de conectar a WhatsApp
// Uso: npm test

import "dotenv/config";
import readline from "readline";
import { handleIncomingMessage, resetSession } from "./agent.js";

// Validar que las claves estén cargadas
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith("sk-xxx")) {
  console.error("\n❌ Falta configurar OPENAI_API_KEY en el archivo .env\n");
  process.exit(1);
}

const TEST_PHONE = "5493424000000"; // Número ficticio para la prueba local

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  🏠 MEGA Agente WhatsApp — Simulador Local");
console.log("  Escribí como si fueras un cliente de WhatsApp.");
console.log("  Comandos especiales:");
console.log("    reset  → Nueva conversación (borra el historial)");
console.log("    salir  → Terminar la prueba");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "Vos 👤 : "
});

rl.prompt();

rl.on("line", async (line) => {
  const input = line.trim();

  if (!input) {
    rl.prompt();
    return;
  }

  if (input.toLowerCase() === "salir") {
    console.log("\n✅ Simulación terminada. El agente está listo.\n");
    rl.close();
    process.exit(0);
  }

  if (input.toLowerCase() === "reset") {
    resetSession(TEST_PHONE);
    console.log("\n🔄 Sesión reiniciada — nueva conversación.\n");
    rl.prompt();
    return;
  }

  process.stdout.write("Agente 🤖: (pensando...)\r");

  try {
    const reply = await handleIncomingMessage(TEST_PHONE, input);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log(`Agente 🤖: ${reply}\n`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}\n`);
  }

  rl.prompt();
});

rl.on("close", () => process.exit(0));
