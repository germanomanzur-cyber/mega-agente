import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { handleIncomingMessage, getLeads, getAndClearPendingHandoff, saveLeadWaName, searchLeadByName, saveAgente, searchAgenteByName, getAgentes } from "./agent.js";
import { logMessage, getChats } from "./chatlog.js";

dotenv.config();
const app = express();
app.use(express.json());
const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, VERIFY_TOKEN, PORT, GERMAN_PHONE, PAGE_ACCESS_TOKEN, FB_PAGE_ID, REPORT_TOKEN: REPORT_TOKEN_ENV } = process.env;
const GERMAN_WA = GERMAN_PHONE || "5493424287842";
const REPORT_TOKEN = REPORT_TOKEN_ENV || VERIFY_TOKEN;

function handleModoGerman(cmd, leads, searchFn) {
const c = (cmd||"").trim().toLowerCase();
if (c==="//ayuda") return "Comandos disponibles:\n//tel <nombre> â busca lead o agente\n//agentes â agentes guardados\n//leads â Ãºltimos 10 leads\n//calientes â calientes\n//ayuda â esta lista";
if (c==="//leads") { const lista=leads.slice(-10).reverse(); if(!lista.length) return "Sin leads registrados aÃºn."; return lista.map(l=>(l.waName||l.name||"?")+" â wa.me/"+l.phone+" ("+(l.tier||"-")+")").join("\n"); }
if (c==="//calientes") { const cal=leads.filter(l=>l.tier==="caliente").slice(-10).reverse(); if(!cal.length) return "Sin leads calientes."; return cal.map(l=>(l.waName||l.name||"?")+" â wa.me/"+l.phone+" â "+(l.zona||"-")+" â "+(l.presupuesto||"-")).join("\n"); }
if (c==="//agentes") { const ag=getAgentes().slice(-10).reverse(); if(!ag.length) return "Sin agentes registrados aÃºn."; return ag.map(a=>(a.nombre||"?")+(a.inmobiliaria?" ("+a.inmobiliaria+")":"")+" â wa.me/"+a.phone+(a.propiedades&&a.propiedades.length?" â "+a.propiedades.length+" prop.":"")).join("\n"); }
const mm=cmd.match(/^\/\/(tele?|num|numero|n[Ãºu]mero|contacto|buscar)\s+(.+)/i);
if (mm) { const nombre=mm[2].trim(),resLeads=searchFn(nombre),resAgentes=searchAgenteByName(nombre),todos=[...resLeads,...resAgentes]; if(!todos.length) return "Sin resultados para \""+nombre+"\". ProbÃ¡ nombre parcial (ej: //tel Dana)"; if(todos.length===1){const r=todos[0];if(r.inmobiliaria!==undefined){let txt=(r.nombre||"Sin nombre")+"\nwa.me/"+r.phone;if(r.inmobiliaria)txt+="\n"+r.inmobiliaria;if(r.zona)txt+=" Â· "+r.zona;if(r.propiedades&&r.propiedades.length){txt+="\nð "+r.propiedades.length+" propiedad(es) compartida(s):\n"+r.propiedades.slice(-3).map(p=>" â¢ "+(p.titulo||p.link||"sin tÃ­tulo")).join("\n");}return txt;}return(r.waName||r.name||"Sin nombre")+"\nwa.me/"+r.phone+"\n"+(r.tier||"-")+" Â· "+(r.zona||"-")+" Â· "+(r.presupuesto||"-");} return todos.length+" resultados:\n"+todos.slice(0,5).map(r=>"â¢ "+(r.nombre||r.waName||r.name||"?")+" â wa.me/"+r.phone+(r.inmobiliaria?" ("+r.inmobiliaria+")":"")).join("\n"); }
return "Comando no reconocido. EscribÃ­ //ayuda";
}

const RESPUESTA_SOCIAL=`Â¡Hola! Soy GermÃ¡n Manzur de MEGA Inmobiliaria Santa Fe ð  Vi tu consulta y tengo propiedades disponibles en esa zona. Escribime por WhatsApp y te mando los detalles: https://wa.me/5493424287842`;
const BIENVENIDA=`Â¡Hola! Gracias por escribir a MEGA Inmobiliaria. Soy *Nico*, el asistente de *GermÃ¡n Manzur*, y ya le pasÃ© tu consulta: te responde personalmente en breve. ð¼\nMientras tanto, contame en una lÃ­nea: Â¿buscÃ¡s tu prÃ³ximo hogar, querÃ©s calificar para el *CrÃ©dito Nido*, o vas por una oportunidad de *Flipping/InversiÃ³n*? ð¡\nPara ir adelantando, mirÃ¡ nuestro stock oficial, actualizado y verificado por IA, acÃ¡: https://drive.google.com/file/d/1fUZCJykuXltwKN05sqLwmaqwnl9qSGwy/view?usp=drive_link`;

// ─── Extraer agentes de texto de reporte ─────────────────────────────────────
function extractAgentesFromText(text) {
  if (!text) return [];
  const agents = [];
  const phoneRe = /(?:wa\.me\/|whatsapp\.com\/|\+?549?)(\d{10,13})/g;
  let m;
  while ((m = phoneRe.exec(text)) !== null) {
    agents.push({ phone: m[1], nombre: null });
  }
  return agents;
}

function esConsultaInmobiliaria(texto) { if(!texto) return false; const t=texto.toLowerCase(); return["busco","busca","necesito","alquilo","compro","buscamos","casa","departamento","dpto","propiedad","inmueble","terreno","alquiler","venta","compra","zona","ambientes","dormitorios","cochera","patio","jardÃ­n","pileta","usd","pesos","precio","m2","metros","planta baja","pb","monoambiente"].filter(k=>t.includes(k)).length>=2; }

const N8N_LEAD_WEBHOOK="https://n8n-production-65677.up.railway.app/webhook/lead-nico";
async function notificarLeadN8n(lead){try{await axios.post(N8N_LEAD_WEBHOOK,{nombre:lead.nombre||"",numero:lead.numero||"",plataforma:lead.plataforma||"whatsapp",busqueda:lead.busqueda||"",zona:lead.zona||"",presupuesto:lead.presupuesto||"",nivel:lead.nivel||"",refs:lead.refs||""});console.log("[NICO] Lead caliente notificado a n8n");}catch(e){console.error("[NICO] Error notificando lead a n8n:",e.message);}}

async function sendWhatsApp(to,body){const recipient=to.startsWith("549")?"54"+to.substring(3):to;await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,{messaging_product:"whatsapp",to:recipient,type:"text",text:{body}},{headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});if(to===GERMAN_WA)logMessage("wa",GERMAN_WA,"nico",body);}

async function sendWhatsAppMenu(to){const recipient=to.startsWith("549")?"54"+to.substring(3):to;await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,{messaging_product:"whatsapp",to:recipient,type:"interactive",interactive:{type:"list",header:{type:"text",text:"MEGA Inmobiliaria"},body:{text:"Hola, soy Nico ð¤, el asistente de GermÃ¡n Manzur. Â¿Con quÃ© te ayudo hoy? ElegÃ­ una opciÃ³n del menÃº."},footer:{text:"Santa Fe Â· MEGA Inmobiliaria"},action:{button:"Ver opciones",sections:[{title:"Servicios",rows:[{id:"opt_comprar",title:"Comprar o invertir",description:"Te ayudo a encontrar tu propiedad"},{id:"opt_vender",title:"Vender o tasar",description:"TasaciÃ³n orientativa de tu propiedad"},{id:"opt_staging",title:"Home Staging IA",description:"Tu propiedad en versiÃ³n moderna"},{id:"opt_docs",title:"Revisar documentaciÃ³n",description:"Contratos y papeles en orden"},{id:"opt_german",title:"Hablar con GermÃ¡n",description:"Te conecto directo con el asesor"}]}]}}},{headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});}

async function responderFBMessenger(id,msg){if(!PAGE_ACCESS_TOKEN)return;await axios.post(`https://graph.facebook.com/v21.0/${FB_PAGE_ID||"me"}/messages`,{recipient:{id},message:{text:msg}},{headers:{Authorization:`Bearer ${PAGE_ACCESS_TOKEN}`}});}
async function responderFBComment(id,msg){if(!PAGE_ACCESS_TOKEN)return;await axios.post(`https://graph.facebook.com/v21.0/${id}/comments`,{message:msg},{headers:{Authorization:`Bearer ${PAGE_ACCESS_TOKEN}`}});}
async function responderIGMessenger(id,msg){if(!PAGE_ACCESS_TOKEN)return;await axios.post(`https://graph.facebook.com/v21.0/me/messages`,{recipient:{id},message:{text:msg}},{headers:{Authorization:`Bearer ${PAGE_ACCESS_TOKEN}`}});}

async function sendWhatsAppAudioTTS(to,text){try{const K=process.env.ELEVENLABS_API_KEY;if(!K)return false;const t2=text.length>500?text.substring(0,497)+"...":text;const r=await axios.post("https://api.elevenlabs.io/v1/text-to-speech/XB0fDUnXU5powFXDhCwa",{text:t2,model_id:"eleven_multilingual_v2",voice_settings:{stability:0.5,similarity_boost:0.75}},{headers:{"xi-api-key":K,"Content-Type":"application/json",Accept:"audio/mpeg"},responseType:"arraybuffer"});const fd=new FormData();fd.append("file",new Blob([r.data],{type:"audio/mpeg"}),"reply.mp3");fd.append("messaging_product","whatsapp");fd.append("type","audio/mpeg");const up=await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/media`,fd,{headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});const rec=to.startsWith("549")?"54"+to.substring(3):to;await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,{messaging_product:"whatsapp",to:rec,type:"audio",audio:{id:up.data.id}},{headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});console.log(`[NICO/WA] Audio TTS enviado a ${to}`);return true;}catch(err){console.error("[NICO/WA] Error TTS ElevenLabs:",err.message);return false;}}

app.get("/health",(req,res)=>{res.status(200).json({status:"ok",service:"mega-agente"});});
app.get("/webhook",(req,res)=>{const mode=req.query["hub.mode"],token=req.query["hub.verify_token"],challenge=req.query["hub.challenge"];if(mode==="subscribe"&&token===VERIFY_TOKEN){res.status(200).send(challenge);}else{res.sendStatus(403);}});

app.post("/webhook",async(req,res)=>{
const body=req.body;res.sendStatus(200);
try{
if(body.object==="whatsapp_business_account"){
const entry=body.entry?.[0],changes=entry?.changes?.[0],message=changes?.value?.messages?.[0];
if(!message)return;
const from=message.from;let userText=message.text?.body||null;
if(message.type==="audio"){try{const _mid=message.audio.id;const{data:_mi}=await axios.get(`https://graph.facebook.com/v21.0/${_mid}`,{headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});const _ar=await axios.get(_mi.url,{responseType:"arraybuffer",headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});const _fd=new FormData();_fd.append("file",new Blob([_ar.data],{type:"audio/ogg"}),"audio.ogg");_fd.append("model","whisper-large-v3");_fd.append("language","es");const _wr=await fetch("https://api.groq.com/openai/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`},body:_fd});const _wj=await _wr.json();userText=_wj.text||"__AUDIO__";console.log("[NICO] Groq ok:",userText.substring(0,60));
    console.log(`[NICO/WA] TranscripciÃ³n audio: ${userText}`);}catch(_e){console.error("[NICO/WA] Error transcribiendo audio:",_e.message);userText="__AUDIO__";}}
if(message.type==="image"){try{const _iid=message.image.id;const{data:_ii}=await axios.get(`https://graph.facebook.com/v21.0/${_iid}`,{headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});const _ir=await axios.get(_ii.url,{responseType:"arraybuffer",headers:{Authorization:`Bearer ${WHATSAPP_ACCESS_TOKEN}`}});const _b64=Buffer.from(_ir.data).toString("base64");const _mime=_ii.mime_type||"image/jpeg";const _vis=await axios.post("https://api.openai.com/v1/chat/completions",{model:"gpt-4o",messages:[{role:"user",content:[{type:"text",text:"DescribÃ­ esta imagen en espaÃ±ol en el contexto de una consulta inmobiliaria. Si hay texto visible, transcribilo. SÃ© breve y directo."},{type:"image_url",image_url:{url:`data:${_mime};base64,${_b64}`}}]}],max_tokens:400},{headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`}});const _desc=_vis.data.choices[0]?.message?.content||"__IMAGE__";userText=`[Imagen recibida] ${_desc}`;console.log(`[NICO/WA] Vision: ${userText}`);}catch(_e){console.error("[NICO/WA] Error Vision:",_e.message);userText="__IMAGE__";}}
if(message.type==="interactive"){userText=message.interactive?.list_reply?.id||message.interactive?.button_reply?.id||null;}
const waPN=changes?.value?.contacts?.[0]?.profile?.name;if(waPN&&from!==GERMAN_WA)saveLeadWaName(from,waPN);
if(from===GERMAN_WA&&userText&&userText.trim().startsWith("//")){const reply=handleModoGerman(userText.trim(),getLeads(),searchLeadByName);await sendWhatsApp(GERMAN_WA,reply);logMessage("wa",GERMAN_WA,"nico",reply);return;}
console.log(`[NICO/WA] Mensaje de ${from}: ${userText}`);logMessage("wa",from,"user",userText);
const responseText=await handleIncomingMessage(from,userText);if(responseText===null)return;
if(responseText==="__MENU__"){await sendWhatsAppMenu(from);logMessage("wa",from,"nico","[menÃº de servicios enviado]");}
else if(responseText==="__BIENVENIDA__"){await sendWhatsApp(from,BIENVENIDA);logMessage("wa",from,"nico",BIENVENIDA);await sendWhatsAppMenu(from);logMessage("wa",from,"nico","[menÃº de servicios enviado]");}
else{await sendWhatsApp(from,responseText);logMessage("wa",from,"nico",responseText);if(message.type==="audio"){await sendWhatsAppAudioTTS(from,responseText);}}
const handoffMsg=getAndClearPendingHandoff(from);
if(handoffMsg){await sendWhatsApp(GERMAN_WA,handoffMsg);const lead=getLeads().find(l=>l.phone===from);if(lead?.tier==="caliente"){await notificarLeadN8n({nombre:lead.name||"",numero:from,plataforma:"whatsapp",busqueda:lead.lastMessage||"",zona:lead.zona||"",presupuesto:lead.presupuesto||"",nivel:lead.tier,refs:lead.interesEn||""});}}
}
else if(body.object==="page"){for(const entry of body.entry||[]){for(const event of entry.messaging||[]){const senderId=event.sender?.id,texto=event.message?.text;if(!senderId||!texto)continue;logMessage("fb",senderId,"user",texto);if(esConsultaInmobiliaria(texto)){await responderFBMessenger(senderId,RESPUESTA_SOCIAL);logMessage("fb",senderId,"nico",RESPUESTASOCIAL);await sendWhatsApp(GERMAN_WA,`ð FB Messenger:\n"${texto}"\nUserID: ${senderId}`);}}for(const change of entry.changes||[]){if(change.field!=="feed")continue;const val=change.value;if(val.item!=="comment"||val.verb!=="add")continue;const texto=val.message,commentId=val.commentÚY]]Ü][ÛOË[Y_[ÝZY[ÛÙÓY\ÜØYÙJÛÛ[Y[Y\Ù\^ÊNÚY\ÐÛÛÝ[R[[Ø[X\XJ^ÊJ^Ø]ØZ]\ÜÛ\ÛÛ[Y[
ÛÛ[Y[YTÔQTÕWÔÓÐÒPS
NÛÙÓY\ÜØYÙJÛÛ[Y[YXÛÈTÔQTÕWÔÓÐÒPS
NØ]ØZ]Ù[Ú]Ð\
ÑTPSÕÐK<'äæÛÛY[\[È8 %	Ø]]ÜNÝ^ßH
Nß___B[ÙHYÙKØXÝOOH[ÝYÜ[H^ÙÜÛÛÝ[HÙÙK[_×J^ÙÜÛÛÝ][Ù[KY\ÜØYÚ[ß×J^ØÛÛÝÙ[\YY][Ù[\ËY^ÏY][Y\ÜØYÙOË^ÚY\Ù[\Y]^ÊXÛÛ[YNÛÙÓY\ÜØYÙJYÈÙ[\Y\Ù\^ÊNÚY\ÐÛÛÝ[R[[Ø[X\XJ^ÊJ^Ø]ØZ]\ÜÛ\QÓY\ÜÙ[Ù\Ù[\YTÔQTÕWÔÓÐÒPS
NÛÙÓY\ÜØYÙJYÈÙ[\YXÛÈTÔQTÕWÔÓÐÒPS
NØ]ØZ]Ù[Ú]Ð\
ÑTPSÕÐK<'äîQÈY[ØZNÝ^ßHQÔÒQ	ÜÙ[\YX
Nß_YÜÛÛÝÚ[ÙHÙ[KÚ[Ù\ß×J^ÚYÚ[ÙKY[OOHÛÛ[Y[ÈXÛÛ[YNØÛÛÝ[XÚ[ÙK[YNÚY\ÐÛÛÝ[R[[Ø[X\XJ[^
J^Ø]ØZ]Ù[Ú]Ð\
ÑTPSÕÐK<'äîQÈÛÛY[\[È8 %	Ý[ÛOË\Ù\[Y_[ÝZY[NÝ[^HÜÝ	Ý[YYXOËYX
Nß___BXØ]Ú
\Ü^ØÛÛÛÛK\ÜÓPÓ×H\Ü[ÙXÛÚÎ\Ü\ÜÛÙOË]_\ÜY\ÜØYÙJNß_JNÂ\Ù]
ÛXYÈ
\K\ÊOOÚY\K]Y\KÚÙ[OOUTQWÕÒÑS\]\\ËÝ]\Ê
JKÛÛÙ\ÜÈ]]Ü^YÈJNØÛÛÝXYÏYÙ]XYÊ
NÜ\ËÛÛÜÝ]ÎÝÝ[XYË[ÝØ[Y[\ÎXYË[\OY\OOHØ[Y[HK[ÝX[ÜÎXYË[\OY\OOHX[ÈK[Ý[ÜÎXYË[\OY\OOH[ÈK[ÝKXYÎXYËÛXÙJML
_JNßJNÂ\ÜÝ
Ü\Ü\Þ[Ê\K\ÊOOØÛÛÝÝÚÙ[Y\ÜØYÙKYÙ[KÛNYÙ[TÛK[[Ø[X\XKÛKÜYYYO\\KÙ_ßNÚY]ÚÙ[ÚÙ[OOTTÔÕÒÑS\]\\ËÝ]\Ê
JKÛÛÙ\ÜÈ]]Ü^YÈJNÚY[Y\ÜØYÙJ\]\\ËÝ]\Ê

KÛÛÙ\ÜY\ÜØYÙH\]Y\YÈJNÚYYÙ[_YÙ[TÛJ^ÜØ]PYÙ[JÛÛXNYÙ[KÛNYÙ[TÛK[[Ø[X\XKÛKY[N\ÜHÜYYYJNß]^Ø]ØZ]Ù[Ú]Ð\
ÑTPSÕÐKY\ÜØYÙJNÜ\ËÛÛÛÚÎY_JNßXØ]Ú
\Ü^Ü\ËÝ]\Ê
L
KÛÛÙ\Ü\ÜY\ÜØYÙ_JNß_JNÂ\\Ý[ÔÌ

OOØÛÛÛÛKÙÊ<'çèQQÐHYÙ[HXÛÈXÝ]È[Y\È	ÔÔÌX
NØÛÛÛÛKÙÊÐH[\È8¡¤	ÑÑTPSÕÐ_X
NßJNÂ\Ù]
Ü]XÞH
\K\ÊOOÜ\ËÙ[
	ÏQÐÕTH[[[ÏH\ÈXYY]HÚ\Ù]H]N]O]XÚYYÝ]OÚXYÙOOÛ]XØHH]XÚYY8 %QQÐHYÙ[OÚOÜ\YÈÜÙ\X[X[\8 %Ù\X[ÛX[\ÛXZ[ÛÛH8 %Ø[HK\Ù[[KÜØÙOÚ[ÊNßJNÂ\Ù]
ØÚ]ËÛÛ
\K\ÊOOÚY\K]Y\KÚÙ[OOUTQWÕÒÑS\]\\ËÝ]\Ê
JKÛÛÙ\ÜÈ]]Ü^YÈJNÜ\ËÛÛÙ]Ú]Ê
JNßJNÂ\Ù]
ØÚ]È
\K\ÊOOÚY\K]Y\KÚÙ[OOUTQWÕÒÑS\]\\ËÝ]\Ê
JKÙ[
È]]Ü^YÈNÜ\ËÙ[
QÐÕTH[[[ÏH\ÈXYY]HÚ\Ù]H]NY]H[YOHY]ÜÜÛÛ[HÚYY]XÙK]ÚY[]X[\ØØ[OLH]OXÛÈHÛÛ\ØXÚ[Û\ÏÝ]OÝ[OØÞ\Ú^[ÎÜ\XÞÛX\Ú[XÙ^ÙÛY[Z[N\X[Ø[Ë\Ù\YÚZYÚLÙ\Ü^N^Ù^Y\XÝ[ÛÛÛ[[ØXÚÙÜÝ[ÙXÙMYZXY\ØXÚÙÜÝ[Ì
ÍYMMØÛÛÜÙÜY[ÎLNÙÛ\Ú^NMÜÙÛ]ÙZYÚÛHÝÜ\Ù^NÙ\Ü^N^ÛZ[ZZYÚHÜÚY^ÝÚYÌØXÚÙÜÝ[ÙØÜ\\YÚ\ÛÛYÙÛÝ\ÝË^N]]ßKÛÛÜY[ÎLMØÜ\XÝÛN\ÛÛYÙYYNØÝ\ÛÜÚ[\KÛÛÝ\ØXÚÙÜÝ[ÙYY_KÛÛÙ[ØXÚÙÜÝ[ÙNYN_KÛÛÚÞÙÛ]ÙZYÚÛÙÛ\Ú^NMKÛÛ]ØÛÛÜÍÙÛ\Ú^NLÝÚ]K\ÜXÙNÝÜ\ÛÝ\ÝÎY[Ý^[Ý\ÝÎ[\Ú\ßKÛÛY]^ØÛÛÜÎNNNÙÛ\Ú^NL\ÛX\Ú[]ÜHÛXZ[Ù^NÛÝ\ÝË^N]]ÎÜY[ÎNÙ\Ü^N^Ù^Y\XÝ[ÛÛÛ[[ÙØ\K\ÙÞÛX^]ÚYÌ	NÜY[ÎLØÜ\\Y]\ÎÙÛ\Ú^NMÛ[KZZYÚKÝÚ]K\ÜXÙNK]Ü\ÝÛÜXXZÎXZË]ÛÜK\ÙÈ]Ù\Ü^NØÚÎÙÛ\Ú^NLØÛÛÜÍÍÍÎÛX\Ú[]ÜÝ^X[YÛYÚK\Ù\ØXÚÙÜÝ[ÙØ[YÛ\Ù[^\Ý\KXÛÞØXÚÙÜÝ[ÙÙÍØ[YÛ\Ù[^Y[HÙ[\^ØÛÛÜÎÛX\Ú[]]ßOÜÝ[OÚXYÙOXY\XÛÈ8 %ÛÛ\ØXÚ[Û\ÏÚXY\]YHÜ\]YHÚYHÙ]]YHXZ[]YH[\HØ\Ø[ËÙ]Ù]Ù]ØÜ\\UO^ßKÑS[[Ý\ÒÑS[]ÈTÙX\Ú\[\ÊØØ][ÛÙX\Ú
KÙ]
ÚÙ[NÙ[Ý[Û]
Ê^Ý\[]È]JÊNÜ]\ÓØØ[Q]TÝ[Ê\ËPTJÈÙÓØØ[U[YTÝ[Ê\ËPTÚÝ\YYÚ]Z[]NYYÚ]JNßY[Ý[ÛØY

^Ù]Ú
ØÚ]ËÛÛÝÚÙ[HÕÒÑSK[[Ý[Û^Ü]\ÛÛ
_JK[[Ý[Û
^ÑUOYÜ[\
NßJNßY[Ý[Û[\
^Ý\ÚYOYØÝ[Y[Ù][[Y[RY
ÚYHNÜÚYK[\SHÝ\Ù^\ÏSØXÝÙ^\ÊUJKÛÜ
[Ý[ÛK^Ý\XOQUVØWKY\ÜØYÙ\ËXQUVØKY\ÜØYÙ\ÎÜ]\]È]JXÛX[ÝLWK]
K[]È]JXVÛXK[ÝLWK]
NßJNÚÙ^\ËÜXXÚ
[Ý[ÛÊ^Ý\ÏQUVÚ×NÝ\\ÝXËY\ÜØYÙ\ÖØËY\ÜØYÙ\Ë[ÝLWNÝ\]YØÝ[Y[ÜX]Q[[Y[
]NÙ]Û\ÜÓ[YOHÛÛÊÏOOTÑSÈÙ[NÝ\ÚÏYØÝ[Y[ÜX]Q[[Y[
]NÝÚËÛ\ÜÓ[YOHÚÈÝÚË^ÛÛ[JËÚ[[OOHØHÈÚ]Ð\Y\ÜÙ[Ù\JØË\Ù\YÝ\]YØÝ[Y[ÜX]Q[[Y[
]NÜ]Û\ÜÓ[YOH]Ü]^ÛÛ[[\Ý^Ý\Y]OYØÝ[Y[ÜX]Q[[Y[
]NÛY]KÛ\ÜÓ[YOHY]HÛY]K^ÛÛ[XËY\ÜØYÙ\Ë[Ý
ÈY[ØZ\ÈHÙ]
\Ý]
NÙ]\[Ú[
ÚÊNÙ]\[Ú[
]NÙ]\[Ú[
Y]JNÙ]ÛÛXÚÏY[Ý[Û
^ÔÑSZÎÜ[\
NßNÜÚYK\[Ú[
]NßJNÝ\XZ[YØÝ[Y[Ù][[Y[RY
XZ[NÛXZ[[\SHÚYTÑSQUVÔÑSJ^Ý\OYØÝ[Y[ÜX]Q[[Y[
]NÙKYH[\HÙK^ÛÛ[ZÙ^\Ë[ÝÈÙ[XØÚ[ÛH[HÛÛ\ØXÚ[ÛÚ[ÛÛ\ØXÚ[Û\ÈÙ]XHÛXZ[\[Ú[
JNÜ]\ßQUVÔÑSKY\ÜØYÙ\ËÜXXÚ
[Ý[ÛJ^Ý\YØÝ[Y[ÜX]Q[[Y[
]NÙÛ\ÜÓ[YOH\ÙÈÊKÛOOOHXÛÈÈXÛÈ\Ù\NÙ^ÛÛ[[K^Ý\]YØÝ[Y[ÜX]Q[[Y[
Ü[NØ]Û\ÜÓ[YOH]Ø]^ÛÛ[JKÛOOOHXÛÈÈXÛÈHJÙ]
K]
NÙ\[Ú[
]
NÛXZ[\[Ú[

NßJNÛXZ[ØÜÛÜ[XZ[ØÜÛZYÚß[ØY

NÜÙ][\[
ØY
NÏÜØÜ\ØÙOÚ[
NßJNÂ
