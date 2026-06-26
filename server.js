import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { handleIncomingMessage, getLeads, getAndClearPendingHandoff, saveLeadWaName, searchLeadByName, saveAgente, searchAgenteByName, getAgentes, extractAgentesFromText } from "./agent.js";
import { logMessage, getChats } from "./chatlog.js";

dotenv.config();

const app = express();
app.use(express.json());

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PORT,
  GERMAN_PHONE,
  PAGE_ACCESS_TOKEN,
  FB_PAGE_ID,
  REPORT_TOKEN: REPORT_TOKEN_ENV,
} = process.env;

const GERMAN_WA = GERMAN_PHONE || "5493424287842";
const REPORT_TOKEN = REPORT_TOKEN_ENV || VERIFY_TOKEN;

// --- Modo Dueno --- prefijo // activa comandos exclusivos de German
// Solo responde al numero 5493424287842. Comandos:
// //tel <nombre> -> numero de un lead
// //leads -> ultimos 10 leads
// //calientes -> leads calientes
// //ayuda -> esta lista
function handleModoGerman(cmd, leads, searchFn) {
  const c = (cmd || "").trim().toLowerCase();

  if (c === "//ayuda") {
    return "Comandos disponibles:\n//tel <nombre> - busca lead o agente\n//agentes - agentes guardados\n//leads - ultimos 10 leads\n//calientes - calientes\n//ayuda - esta lista";
  }
  if (c === "//leads") {
    const lista = leads.slice(-10).reverse();
    if (!lista.length) return "Sin leads registrados aun.";
    return lista.map(l =>
      (l.waName || l.name || "?") + " - wa.me/" + l.phone + " (" + (l.tier || "-") + ")"
    ).join("\n");
  }
  if (c === "//calientes") {
    const cal = leads.filter(l => l.tier === "caliente").slice(-10).reverse();
    if (!cal.length) return "Sin leads calientes.";
    return cal.map(l =>
      (l.waName || l.name || "?") + " - wa.me/" + l.phone + " - " + (l.zona || "-") + " - " + (l.presupuesto || "-")
    ).join("\n");
  }
  if (c === "//agentes") {
    const ag = getAgentes().slice(-10).reverse();
    if (!ag.length) return "Sin agentes registrados aun.";
    return ag.map(a =>
      (a.nombre || "?") + (a.inmobiliaria ? " (" + a.inmobiliaria + ")" : "") +
      " - wa.me/" + a.phone +
      (a.propiedades && a.propiedades.length ? " - " + a.propiedades.length + " prop." : "")
    ).join("\n");
  }
  const m = cmd.match(/^\/\/(tele?|num|numero|n[Ãºu]mero|contacto|buscar)\s+(.+)/i);
  if (m) {
    const nombre = m[2].trim();
    const resLeads = searchFn(nombre);
    const resAgentes = searchAgenteByName(nombre);
    const todos = [...resLeads, ...resAgentes];
    if (!todos.length) return "Sin resultados para \"" + nombre + "\". Proba nombre parcial (ej: //tel Dana)";
    if (todos.length === 1) {
      const r = todos[0];
      if (r.inmobiliaria !== undefined) {
        let txt = (r.nombre || "Sin nombre") + "\nwa.me/" + r.phone;
        if (r.inmobiliaria) txt += "\n" + r.inmobiliaria;
        if (r.zona) txt += " - " + r.zona;
        if (r.propiedades && r.propiedades.length) {
          txt += "\nPropiedades compartidas (" + r.propiedades.length + "):";
          txt += "\n" + r.propiedades.slice(-3).map(p => " - " + (p.titulo || p.link || "sin titulo")).join("\n");
        }
        return txt;
      }
      return (r.waName || r.name || "Sin nombre") + "\nwa.me/" + r.phone + "\n" + (r.tier || "-") + " - " + (r.zona || "-") + " - " + (r.presupuesto || "-");
    }
    return todos.length + " resultados:\n" + todos.slice(0, 5).map(r =>
      "- " + (r.nombre || r.waName || r.name || "?") + " -> wa.me/" + r.phone +
      (r.inmobiliaria ? " (" + r.inmobiliaria + ")" : "")
    ).join("\n");
  }
  return "Comando no reconocido. Escribi //ayuda";
}

// --- Respuesta automatica para redes sociales
const RESPUESTA_SOCIAL = "Hola! Soy German Manzur de MEGA Inmobiliaria Santa Fe. Vi tu consulta y tengo propiedades disponibles en esa zona. Escribime por WhatsApp y te mando los detalles: https://wa.me/5493424287842";

// --- Detectar si un texto es consulta inmobiliaria
function esConsultaInmobiliaria(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  const keywords = [
    "busco", "busca", "necesito", "alquilo", "compro", "buscamos",
    "casa", "departamento", "dpto", "propiedad", "inmueble", "terreno",
    "alquiler", "venta", "compra", "zona", "ambientes", "dormitorios",
    "cochera", "patio", "pileta", "usd", "pesos", "precio",
    "m2", "metros", "planta baja", "pb", "monoambiente"
  ];
  return keywords.filter(k => t.includes(k)).length >= 2;
}

// --- Notificar lead caliente a n8n
const N8N_LEAD_WEBHOOK = "https://n8n-production-65677.up.railway.app/webhook/lead-nico";

async function notificarLeadN8n(lead) {
  try {
    await axios.post(N8N_LEAD_WEBHOOK, {
      nombre: lead.nombre || "",
      numero: lead.numero || "",
      plataforma: lead.plataforma || "whatsapp",
      busqueda: lead.busqueda || "",
      zona: lead.zona || "",
      presupuesto: lead.presupuesto || "",
      nivel: lead.nivel || "",
      refs: lead.refs || "",
    });
    console.log("[NICO] Lead caliente notificado a n8n");
  } catch (e) {
    console.error("[NICO] Error notificando lead a n8n:", e.message);
  }
}

// --- WhatsApp: enviar mensaje
async function sendWhatsApp(to, body) {
  const recipient = to.startsWith("549") ? "54" + to.substring(3) : to;
  await axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: recipient, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
  if (to === GERMAN_WA) logMessage("wa", GERMAN_WA, "nico", body);
}

// --- WhatsApp: enviar menu interactivo de servicios
async function sendWhatsAppMenu(to) {
  const recipient = to.startsWith("549") ? "54" + to.substring(3) : to;
  await axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "MEGA Inmobiliaria" },
        body: { text: "Hola, soy Nico, el asistente de German Manzur. Con que te ayudo hoy? Elegi una opcion del menu." },
        footer: { text: "Santa Fe - MEGA Inmobiliaria" },
        action: {
          button: "Ver opciones",
          sections: [
            {
              title: "Servicios",
              rows: [
                { id: "opt_comprar", title: "Comprar o invertir", description: "Te ayudo a encontrar tu propiedad" },
                { id: "opt_vender", title: "Vender o tasar", description: "Tasacion orientativa de tu propiedad" },
                { id: "opt_staging", title: "Home Staging IA", description: "Tu propiedad en version moderna" },
                { id: "opt_docs", title: "Revisar documentacion", description: "Contratos y papeles en orden" },
                { id: "opt_german", title: "Hablar con German", description: "Te conecto directo con el asesor" },
              ],
            },
          ],
        },
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
  );
}

async function responderFBMessenger(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) return;
  await axios.post(
    `https://graph.facebook.com/v21.0/${FB_PAGE_ID || "me"}/messages`,
    { recipient: { id: recipientId }, message: { text: message } },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

async function responderFBComment(commentId, message) {
  if (!PAGE_ACCESS_TOKEN) return;
  await axios.post(
    `https://graph.facebook.com/v21.0/${commentId}/comments`,
    { message },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

async function responderIGMessenger(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) return;
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages`,
    { recipient: { id: recipientId }, message: { text: message } },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
}

// --- Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "mega-agente" });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- Webhook: recepcion de eventos (WA + FB + IG)
app.post("/webhook", async (req, res) => {
  const body = req.body;
  res.sendStatus(200);

  try {
    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];
      if (!message) return;

      const from = message.from;
      let userText = message.text?.body || null;

      // --- Audio: transcribir con Groq Whisper
      if (message.type === "audio") {
        try {
          const mediaId = message.audio.id;
          const miRes = await axios.get(
            `https://graph.facebook.com/v21.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } }
          );
          const audioRes = await axios.get(miRes.data.url, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
          });
          const fd = new FormData();
          fd.append("file", new Blob([audioRes.data], { type: "audio/ogg" }), "audio.ogg");
          fd.append("model", "whisper-large-v3");
          fd.append("language", "es");
          const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
            body: fd,
          });
          const groqJson = await groqRes.json();
          userText = groqJson.text || "__AUDIO__";
          console.log("[NICO] Groq transcripcion ok:", userText.substring(0, 60));
        } catch (audioErr) {
          console.error("[NICO] Error Groq audio:", audioErr.message);
          userText = "__AUDIO__";
        }
      }

      if (message.type === "image") userText = "__IMAGE__";

      // Seleccion del menu interactivo (lista o botones)
      if (message.type === "interactive") {
        userText = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id || null;
      }

      // Guardar nombre WA del perfil (solo leads, no German)
      const waProfileName = changes?.value?.contacts?.[0]?.profile?.name;
      if (waProfileName && from !== GERMAN_WA) saveLeadWaName(from, waProfileName);

      // Modo German: prefijo // activa comandos privados (solo 5493424287842)
      if (from === GERMAN_WA && userText && userText.trim().startsWith("//")) {
        const reply = handleModoGerman(userText.trim(), getLeads(), searchLeadByName);
        await sendWhatsApp(GERMAN_WA, reply);
        logMessage("wa", GERMAN_WA, "nico", reply);
        return;
      }

      console.log(`[NICO/WA] Mensaje de ${from}: ${userText}`);
      logMessage("wa", from, "user", userText);
      const responseText = await handleIncomingMessage(from, userText);
      if (responseText === null) return;

      // __MENU__ -> enviar el menu interactivo de servicios en vez de texto
      if (responseText === "__MENU__") {
        await sendWhatsAppMenu(from);
        logMessage("wa", from, "nico", "[menu de servicios enviado]");
      } else {
        await sendWhatsApp(from, responseText);
        logMessage("wa", from, "nico", responseText);
      }

      const handoffMsg = getAndClearPendingHandoff(from);
      if (handoffMsg) {
        await sendWhatsApp(GERMAN_WA, handoffMsg);
        const lead = getLeads().find((l) => l.phone === from);
        if (lead?.tier === "caliente") {
          await notificarLeadN8n({
            nombre: lead.name || "",
            numero: from,
            plataforma: "whatsapp",
            busqueda: lead.lastMessage || "",
            zona: lead.zona || "",
            presupuesto: lead.presupuesto || "",
            nivel: lead.tier,
            refs: lead.interesEn || "",
          });
        }
      }
    }

    else if (body.object === "page") {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const texto = event.message?.text;
          if (!senderId || !texto) continue;
          logMessage("fb", senderId, "user", texto);
          if (esConsultaInmobiliaria(texto)) {
            await responderFBMessenger(senderId, RESPUESTA_SOCIAL);
            logMessage("fb", senderId, "nico", RESPUESTA_SOCIAL);
            await sendWhatsApp(GERMAN_WA, "FB Messenger:\n\"" + texto + "\"\nUserID: " + senderId);
          }
        }
        for (const change of entry.changes || []) {
          if (change.field !== "feed") continue;
          const val = change.value;
          if (val.item !== "comment" || val.verb !== "add") continue;
          const texto = val.message;
          const commentId = val.comment_id;
          const autor = val.from?.name || "Alguien";
          logMessage("fb", commentId, "user", texto);
          if (esConsultaInmobiliaria(texto)) {
            await responderFBComment(commentId, RESPUESTA_SOCIAL);
            logMessage("fb", commentId, "nico", RESPUESTA_SOCIAL);
            await sendWhatsApp(GERMAN_WA, "FB Comentario - " + autor + ":\n\"" + texto + "\"");
          }
        }
      }
    }

    else if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const texto = event.message?.text;
          if (!senderId || !texto) continue;
          logMessage("ig", senderId, "user", texto);
          if (esConsultaInmobiliaria(texto)) {
            await responderIGMessenger(senderId, RESPUESTA_SOCIAL);
            logMessage("ig", senderId, "nico", RESPUESTA_SOCIAL);
            await sendWhatsApp(GERMAN_WA, "IG Mensaje:\n\"" + texto + "\"\nIGSID: " + senderId);
          }
        }
        for (const change of entry.changes || []) {
          if (change.field !== "comments") continue;
          const val = change.value;
          if (esConsultaInmobiliaria(val.text)) {
            await sendWhatsApp(GERMAN_WA, "IG Comentario - @" + (val.from?.username || "alguien") + ":\n\"" + val.text + "\"\nPost: " + val.media?.id);
          }
        }
      }
    }

  } catch (error) {
    console.error("[NICO] Error en webhook:", error.response?.data || error.message);
  }
});

app.get("/leads", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.status(401).json({ error: "No autorizado" });
  const leads = getLeads();
  res.json({
    stats: {
      total: leads.length,
      calientes: leads.filter(l => l.tier === "caliente").length,
      tibios: leads.filter(l => l.tier === "tibio").length,
      frios: leads.filter(l => l.tier === "frio").length,
    },
    leads: leads.slice(-50)
  });
});

app.post("/report", async (req, res) => {
  const { token, message, agente, phone: agentePhone, inmobiliaria, zona, propiedad } = req.body || {};
  if (!token || token !== REPORT_TOKEN) return res.status(401).json({ error: "No autorizado" });
  if (!message) return res.status(400).json({ error: "message requerido" });
  if (agente || agentePhone) {
    saveAgente({ nombre: agente, phone: agentePhone, inmobiliaria, zona, fuente: "reporte", propiedad });
  }
  const agentesEncontrados = extractAgentesFromText(message);
  for (const ag of agentesEncontrados) {
    if (ag.phone || ag.nombre) saveAgente({ ...ag, propiedad: propiedad || null });
  }
  try {
    await sendWhatsApp(GERMAN_WA, message);
    res.json({ ok: true, agentesGuardados: agentesEncontrados.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT || 3000, () => {
  console.log("[NICO] MEGA Agente activo en puerto " + (PORT || 3000));
  console.log("[NICO] WA alerts -> " + GERMAN_WA);
});

app.get("/privacy", (req, res) => {
  res.send('<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Privacidad</title></head><body><h1>Politica de Privacidad - MEGA Agente</h1><p>Operado por German Manzur - germanomanzur@gmail.com - Santa Fe, Argentina.</p></body></html>');
});

app.get("/chats.json", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.status(401).json({ error: "No autorizado" });
  res.json(getChats());
});

app.get("/chats", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.status(401).send("No autorizado");
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nico - Conversaciones</title><style>*{box-sizing:border-box;margin:0}body{font-family:Arial,sans-serif;height:100vh;display:flex;flex-direction:column;background:#ece5dd}header{background:#075e54;color:#fff;padding:12px 18px;font-size:17px;font-weight:bold}#wrap{flex:1;display:flex;min-height:0}#side{width:320px;background:#fff;border-right:1px solid #ddd;overflow-y:auto}.conv{padding:12px 14px;border-bottom:1px solid #eee;cursor:pointer}.conv:hover{background:#f5f5f5}.conv.sel{background:#e8f5e9}.conv .who{font-weight:bold;font-size:14px}.conv .prev{color:#666;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conv .meta{color:#999;font-size:11px;margin-top:2px}#main{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:6px}.msg{max-width:70%;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}.msg .at{display:block;font-size:10px;color:#777;margin-top:4px;text-align:right}.user{background:#fff;align-self:flex-start}.nico{background:#dcf8c6;align-self:flex-end}#empty{color:#888;margin:auto}</style></head><body><header>Nico - Conversaciones</header><div id="wrap"><div id="side"></div><div id="main"><div id="empty">Cargando...</div></div></div><script>var DATA={},SEL=null;var TOKEN=new URLSearchParams(location.search).get("token");function fmt(s){var d=new Date(s);return d.toLocaleDateString("es-AR")+" "+d.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"});}function load(){fetch("/chats.json?token="+TOKEN).then(function(r){return r.json()}).then(function(d){DATA=d;render();});}function render(){var side=document.getElementById("side");side.innerHTML="";var keys=Object.keys(DATA).sort(function(a,b){var ma=DATA[a].messages,mb=DATA[b].messages;return new Date(mb[mb.length-1].at)-new Date(ma[ma.length-1].at);});keys.forEach(function(k){var c=DATA[k];var last=c.messages[c.messages.length-1];var div=document.createElement("div");div.className="conv"+(k===SEL?" sel":"");var who=document.createElement("div");who.className="who";who.textContent=(c.channel==="wa"?"WhatsApp ":"Messenger ")+c.userId;var prev=document.createElement("div");prev.className="prev";prev.textContent=last.text;var meta=document.createElement("div");meta.className="meta";meta.textContent=c.messages.length+" mensajes - "+fmt(last.at);div.appendChild(who);div.appendChild(prev);div.appendChild(meta);div.onclick=function(){SEL=k;render();};side.appendChild(div);});var main=document.getElementById("main");main.innerHTML="";if(!SEL||!DATA[SEL]){var e=document.createElement("div");e.id="empty";e.textContent=keys.length?"Selecciona una conversacion":"Sin conversaciones todavia";main.appendChild(e);return;}DATA[SEL].messages.forEach(function(m){var d=document.createElement("div");d.className="msg "+(m.role==="nico"?"nico":"user");d.textContent=m.text;var at=document.createElement("span");at.className="at";at.textContent=(m.role==="nico"?"Nico - ":"")+fmt(m.at);d.appendChild(at);main.appendChild(d);});main.scrollTop=main.scrollHeight;}load();setInterval(load,8000);</script></body></html>`);
});
