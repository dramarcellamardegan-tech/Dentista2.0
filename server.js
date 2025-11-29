// server.js - Koyeb-ready integrated version (whatsapp-web.js + Sheets + Calendar + Firebase Admin)
// Replace your existing server.js with this file (keep a backup).
// IMPORTANT: Create a persistent volume mounted at /data in Koyeb.
// Ensure package.json has "start": "node server.js" and puppeteer is installed.

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const app = express();

// ---------- CONFIG / FALLBACKS ----------
const PORT = process.env.PORT || 4000;
const USER_WEBSITE_ORIGIN = process.env.USER_WEBSITE_ORIGIN || 'https://dramarcellamardegan.com.br';

// Firebase config object for frontend injection (if needed)
const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || null,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
  projectId: process.env.FIREBASE_PROJECT_ID || null,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || null,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
  appId: process.env.FIREBASE_APP_ID || null,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || null
};
const firebaseConfigJson = JSON.stringify(FIREBASE_CONFIG);

// utility to serve html with injected firebase config placeholder
function serveHtmlWithConfig(filePath, res) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Falha ao ler o arquivo HTML:', err);
      return res.status(500).send('Erro interno do servidor: Falha ao carregar a página.');
    }
    const htmlComConfig = data.replace(/__FIREBASE_CONFIG_PLACEHOLDER__/g, firebaseConfigJson);
    res.send(htmlComConfig);
  });
}

// ---------- STATIC / ROUTES FOR HTML ----------
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// serve public folder (connect.html, agendamento.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// safe route wrappers for HTML that may need injected config
app.get('/connect.html', (req, res) => serveHtmlWithConfig(path.join(__dirname, 'public', 'connect.html'), res));
app.get('/agendamento.html', (req, res) => serveHtmlWithConfig(path.join(__dirname, 'public', 'agendamento.html'), res));

// ---------- FIREBASE ADMIN INITIALIZATION ----------
const USER_GCP_CREDENTIALS_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || 'gcp-service-account.json';
try {
  if (fs.existsSync(path.resolve(USER_GCP_CREDENTIALS_FILE))) {
    const serviceAccount = require(path.resolve(USER_GCP_CREDENTIALS_FILE));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK inicializado com sucesso.');
  } else {
    console.warn(`⚠️ Arquivo de credenciais Firebase '${USER_GCP_CREDENTIALS_FILE}' não encontrado. Firebase Admin não inicializado.`);
  }
} catch (e) {
  console.error('❌ Falha ao inicializar Firebase Admin SDK:', e);
}

// ---------- GOOGLE AUTH FOR SHEETS/CALENDAR ----------
let googleClientEmail = process.env.GOOGLE_CLIENT_EMAIL;
let googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY;
let googleCreds = null;
const credsFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || USER_GCP_CREDENTIALS_FILE;

if (credsFilePath && fs.existsSync(path.resolve(credsFilePath))) {
  try {
    const raw = fs.readFileSync(path.resolve(credsFilePath), 'utf8');
    googleCreds = JSON.parse(raw);
    googleClientEmail = googleClientEmail || googleCreds.client_email;
    googlePrivateKey = googlePrivateKey || googleCreds.private_key;
    console.log('✅ Credenciais do Google carregadas do arquivo:', credsFilePath);
  } catch (e) {
    console.warn('⚠️ Não foi possível ler o arquivo de credenciais do Google:', e.message || e);
  }
}
const privateKeyCleaned = googlePrivateKey ? googlePrivateKey.trim().replace(/^['"]|['"]$/g, '').replace(/\\n/g, '\n') : null;
const auth = new google.auth.GoogleAuth({
  credentials: googleClientEmail && privateKeyCleaned ? { client_email: googleClientEmail, private_key: privateKeyCleaned } : undefined,
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar'],
});

// ---------- REQUIRED ENV VARS (fallbacks) ----------
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const SHEET_NAME = (process.env.SHEET_NAME || 'cadastro_agenda').trim();
const CALENDAR_ID = process.env.CALENDAR_ID || '';
const DENTIST_EMAIL = process.env.DENTIST_EMAIL || '';
const DENTIST_PHONE = process.env.DENTIST_PHONE || '';
const LINK_AGENDAMENTO = (process.env.LINK_AGENDAMENTO || USER_WEBSITE_ORIGIN).replace(/['"]/g, '');
const DURACAO_CONSULTA_MIN = Number(process.env.DURACAO_CONSULTA_MIN || 30);
const HORARIOS_ATENDIMENTO_INICIAL = (process.env.HORARIOS_ATENDIMENTO || '17:30,18:00,18:30,19:00,19:30,20:00').split(',');
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

// Validate critical envs (log but don't crash)
if (!SPREADSHEET_ID || !CALENDAR_ID || !DENTIST_EMAIL) {
  console.warn('⚠️ Atenção: SPREADSHEET_ID, CALENDAR_ID ou DENTIST_EMAIL não estão configurados. Algumas funcionalidades (Sheets/Calendar/email) podem falhar.');
}

// ---------- NODEMAILER ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});
transporter.verify().then(()=>console.log('✅ Nodemailer ready')).catch(err=>console.warn('⚠️ Nodemailer verify failed:', err?.message||err));

// ---------- WHATSAPP CLIENT SETUP (Koyeb-ready) ----------
let waStatus = 'loading'; // 'loading'|'qr_code'|'connected'|'disconnected'|'error'
let waQrCodeBase64 = null;
let clientReady = false;

const waClient = new Client({
  authStrategy: new LocalAuth({ clientId: 'dentista-ia', dataPath: '/data/session' }), // persist in /data
  puppeteer: {
    headless: true,
    // executablePath is optional but recommended if environment provides chrome; Koyeb's image includes chromium path
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer']
  },
  takeoverOnConflict: true,
  puppeteerOptions: {} // keep for compatibility
});

// Clean any old session on cold start (optional, careful)
try {
  const authPath = path.join(__dirname, '.wwebjs_auth');
  if (fs.existsSync(authPath)) {
    console.log('🧹 Limpando .wwebjs_auth local (se existir)...');
    try { fs.rmSync(authPath, { recursive: true, force: true }); } catch(e){/*ignore*/}
  }
} catch(e){console.warn('Falha cleanup:', e)}

// WhatsApp handlers
waClient.on('qr', async qr => {
  waStatus = 'qr_code';
  try {
    waQrCodeBase64 = await qrcode.toDataURL(qr);
    console.log('🔎 QR gerado (base64).');
  } catch (e) {
    waStatus = 'error';
    console.error('❌ Erro ao gerar QR Base64:', e);
  }
});

waClient.on('ready', () => {
  waStatus = 'connected';
  clientReady = true;
  waQrCodeBase64 = null;
  console.log('✅ WhatsApp Client pronto e conectado.');
});

waClient.on('authenticated', () => console.log('✅ WhatsApp authenticated'));
waClient.on('auth_failure', e => { waStatus='error'; console.error('❌ WhatsApp auth_failure', e); });
waClient.on('disconnected', reason => { waStatus='disconnected'; clientReady=false; console.log('🔴 WhatsApp disconnected:', reason); setTimeout(()=>waClient.initialize(), 3000); });

waClient.initialize().catch(e=>console.error('Erro inicializando cliente WhatsApp:', e));

// ---------- HELPERS ----------
function normalizePhone(n) {
  if (!n) return '';
  let s = String(n).replace(/\D/g, '');
  if (s.length === 10 || s.length === 11) s = '55' + s;
  if (!s.startsWith('55')) s = '55' + s;
  return s;
}
async function enviarMensagemWhatsApp(numero, mensagem) {
  try {
    if (waStatus !== 'connected') {
      console.warn('⚠️ WhatsApp not connected; skipping message to', numero, 'status:', waStatus);
      return false;
    }
    const limpo = normalizePhone(numero);
    if (!limpo) throw new Error('numero inválido');
    await waClient.sendMessage(`${limpo}@c.us`, mensagem);
    console.log('💬 Mensagem enviada para', limpo);
    return true;
  } catch (e) {
    console.error('❌ Erro enviarMensagemWhatsApp:', e?.message || e);
    return false;
  }
}

// Sheets helpers
async function appendRow(values) {
  const clientAuth = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: clientAuth });
  return await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:L`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}
async function updateCell(rangeA1, values) {
  const clientAuth = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: clientAuth });
  return await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: rangeA1, valueInputOption: 'RAW', requestBody: { values } });
}
function extractRowFromUpdatedRange(updatedRange) {
  const m = /!(?:[A-Z]+)(\d+):/.exec(updatedRange) || /!(?:[A-Z]+)(\d+)$/.exec(updatedRange);
  if (m && m[1]) return Number(m[1]);
  const m2 = updatedRange.match(/(\d+)(?!.*\d)/);
  return m2 ? Number(m2[1]) : null;
}

// Calendar functions
async function createCalendarEvent(nome, telefone, dataDDMMYYYY, horario) {
  try {
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    const [dia, mes, ano] = String(dataDDMMYYYY).split('/');
    const startISO = new Date(`${ano}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}T${horario}:00`).toISOString();
    const endISO = new Date(new Date(startISO).getTime() + DURACAO_CONSULTA_MIN*60000).toISOString();
    const event = { summary: `[CONFIRMADO] Avaliação - ${nome}`, description: `Agendamento via bot. Telefone: ${telefone}`, start: { dateTime: startISO, timeZone: TIMEZONE }, end: { dateTime: endISO, timeZone: TIMEZONE }, colorId: 2 };
    const resp = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
    console.log('✅ Calendar event created:', resp.data.id);
    return resp.data.id;
  } catch (e) {
    console.warn('⚠️ Falha ao criar evento no Calendar:', e?.response?.data || e?.message || e);
    return null;
  }
}
async function deleteCalendarEvent(eventId) {
  try {
    if (!eventId) return false;
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    console.log(`🗑️ Calendar event ${eventId} deleted`);
    return true;
  } catch (e) {
    console.warn('⚠️ Falha ao deletar evento no Calendar:', e?.message || e);
    return false;
  }
}
async function patchCalendarEvent(eventId, nome, status) {
  try {
    if (!eventId) return null;
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    let colorId; if (status === 'Confirmado') colorId = 2; else if (status === 'Cancelado') colorId = 11; else colorId = 5;
    let summary = `[${status.toUpperCase()}] Avaliação - ${nome}`;
    const resp = await calendar.events.patch({ calendarId: CALENDAR_ID, eventId, resource: { summary, colorId } });
    console.log(`✅ Calendar event ${eventId} patched to ${status}`);
    return resp.data.id;
  } catch (e) {
    console.warn('⚠️ Falha ao dar patch no Calendar:', e?.message || e);
    return null;
  }
}

// Buscar agendamento pendente / ativo in spreadsheet
async function fetchSheetRows() {
  const clientAuth = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: clientAuth });
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` });
  return response.data.values || [];
}
async function buscarAgendamentoPendente(telefone) {
  try {
    const rows = await fetchSheetRows();
    if (rows.length < 2) return null;
    const telefoneLimpo = normalizePhone(telefone);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const status = String(row[6] || '').toLowerCase();
      const telefonePlanilha = normalizePhone(row[2] || '');
      if (status === 'pendente' && telefonePlanilha === telefoneLimpo) {
        return { nome: row[1], telefone: telefonePlanilha, data: row[4], horario: row[5], calendarId: row[8], linha: i+1, email: row[3] };
      }
    }
    return null;
  } catch (e) { console.error('buscarAgendamentoPendente error', e); throw e; }
}
async function buscarAgendamentoAtivo(telefone) {
  try {
    const rows = await fetchSheetRows();
    if (rows.length < 2) return null;
    const telefoneLimpo = normalizePhone(telefone);
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const status = String(row[6] || '').toLowerCase();
      const telefonePlanilha = normalizePhone(row[2] || '');
      if ((status === 'pendente' || status === 'confirmado') && telefonePlanilha === telefoneLimpo) {
        return { nome: row[1], telefone: telefonePlanilha, data: row[4], horario: row[5], calendarId: row[8], linha: i+1, email: row[3], statusAtual: row[6] };
      }
    }
    return null;
  } catch (e) { console.error('buscarAgendamentoAtivo error', e); throw e; }
}

// Conversational helpers (same as your original)
const conversationStates = {};
function normalizeForIntent(text) {
  if (!text) return '';
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
}
function detectIntentWhatsApp(text) {
  const n = normalizeForIntent(text);
  if (/\b(oi|ola|olá|bom dia|boa tarde|boa noite|tudo bem)\b/.test(n)) return 'greeting';
  if (/\b(preco|valor|quanto|custa|orcamento|orçamento)\b/.test(n)) return 'price';
  if (/\b(dor|doendo|inflamado|urgente|sangrando|nao aguento)\b/.test(n)) return 'pain';
  if (/\b(aparelho|alinhador|invisalign|mordida|ortodont)\b/.test(n)) return 'ortho';
  if (/\b(clareamento|restaur|lente|limpeza|tartaro|canal|estetic|estética)\b/.test(n)) return 'dent';
  if (/\b(botox|preenchimento|fio|harmoniza|harmonização)\b/.test(n)) return 'hof';
  if (/\b(agendar|consulta|horario|marcar|agenda|disponivel|disponível)\b/.test(n)) return 'agendar';
  if (/\b(cancelar|remarcar|reagendar|desmarcar)\b/.test(n)) return 'desagendar';
  if (/\b(sim|claro|pode|quero)\b/.test(n)) return 'confirm';
  if (/\b(nao|não|depois|outra hora|agora nao|agora não)\b/.test(n)) return 'deny';
  return 'fallback';
}
function generateResponseWhatsApp(intent) {
  let base = String(LINK_AGENDAMENTO || '').trim();
  const agendarPath = base ? (base.endsWith('/') ? base + 'agendamento.html' : base + '/agendamento.html') : '/agendamento.html';
  const CTA = `\n\n🟩 *AGENDAR AGORA*\n👉 ${agendarPath}`;
  switch (intent) {
    case 'greeting': return `Olá 👋! Sou a assistente virtual da Dra. Marcella. Como posso te ajudar hoje?`;
    case 'price': return `Entendo sua dúvida sobre valores. Como cada tratamento é personalizado, a Dra. Marcella só passa orçamento após avaliação presencial. ${CTA}`;
    case 'pain': return `Sinto muito que esteja sentindo dor. 😔 Casos com dor são priorizados — a melhor forma de resolver com segurança é uma avaliação. ${CTA}`;
    case 'ortho': return `Para indicar aparelho ou alinhadores a Dra. Marcella precisa avaliar sua mordida e posição dos dentes presencialmente. Quer agendar uma avaliação? ${CTA}`;
    case 'dent': return `Procedimentos estéticos (clareamento, lentes, restaurações) exigem avaliação para garantir segurança e resultado natural. Agende sua avaliação: ${CTA}`;
    case 'hof': return `Harmonização orofacial deve ser planejada após análise das proporções faciais — a avaliação é o primeiro passo. ${CTA}`;
    case 'agendar': return `Perfeito — podemos marcar sua avaliação agora. Toque no link abaixo para escolher o melhor horário: ${CTA}`;
    case 'desagendar': return `Tudo bem — você pode cancelar ou reagendar facilmente. Use o link abaixo para acessar a agenda e escolher outro horário: ${CTA}`;
    case 'confirm': return `Ótimo! Vou deixar o link para você agendar agora: ${CTA}`;
    case 'deny': return `Sem problemas — se preferir, posso te ajudar com outras dúvidas ou deixar o link para agendar mais tarde: ${CTA}`;
    case 'fallback':
    default: return `Posso te ajudar melhor pessoalmente com a avaliação da Dra. Marcella. Para agendar é só tocar no link abaixo: ${CTA}`;
  }
}

// WhatsApp message handler: preserves your flows (confirmation, cancel, generic)
waClient.on('message', async msg => {
  try {
    const userMessage = msg.body;
    const senderPhone = normalizePhone(msg.from);
    const chat = await msg.getChat();
    const chatType = chat.isGroup ? 'group' : 'private';
    if (chatType !== 'private') return;

    const currentState = conversationStates[senderPhone] || 'IDLE';

    let agendamentoPendente = null;
    try { agendamentoPendente = await buscarAgendamentoPendente(senderPhone); } catch (e) { console.warn('buscarAgendamentoPendente error', e); }

    const isAff = ['sim','s','claro','pode','confirmo'].includes(String(userMessage||'').toLowerCase().trim());
    const isNeg = ['nao','não','n','depois','cancelar','cancela','agora não','agora nao'].includes(String(userMessage||'').toLowerCase().trim());
    const userWantsToCancel = String(userMessage||'').toLowerCase().includes('cancelar');

    // 1) Confirm pending
    if (agendamentoPendente) {
      const { nome, telefone, data, horario, calendarId, linha, email } = agendamentoPendente;
      if (isAff) {
        try {
          const eventId = await createCalendarEvent(nome, telefone, data, horario);
          if (eventId) { await updateCell(`${SHEET_NAME}!I${linha}`, [[eventId]]); }
          await updateCell(`${SHEET_NAME}!G${linha}`, [['Confirmado']]);
          const msgDentistaConfirmado = `🟢 AGENDAMENTO CONFIRMADO:\nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data}\nHorário: ${horario}`;
          if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaConfirmado);
          await msg.reply(`🎉 *AGENDAMENTO CONFIRMADO!* 🎉\n\nQue ótimo, ${nome}! Seu horário para *${data}* às *${horario}* está CONFIRMADO na agenda da Dra. Marcella.`);
          try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🟢 AGENDAMENTO CONFIRMADO', text: msgDentistaConfirmado }); if (email) await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: '✅ Confirmação de Agendamento', text: `Seu agendamento em ${data} às ${horario} foi CONFIRMADO.` }); } } catch (mailErr) { console.warn('Falha envio e-mail confirmação:', mailErr?.message||mailErr); }
        } catch (e) { console.error('Erro ao confirmar agendamento:', e); await msg.reply('❌ Ocorreu um erro ao confirmar seu agendamento. Tente novamente mais tarde.'); }
        delete conversationStates[senderPhone];
        return;
      } else if (isNeg) {
        try { await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]); } catch (e) { console.warn('Falha marcar cancelado:', e); }
        const msgDentistaCancelado = `🔴 AGENDAMENTO CANCELADO (pendente):\nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data}\nHorário: ${horario}`;
        if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaCancelado);
        await msg.reply(`Ok ${nome}, seu agendamento em ${data} às ${horario} foi CANCELADO.`);
        try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🔴 AGENDAMENTO CANCELADO', text: msgDentistaCancelado }); } catch (mailErr) { console.warn('Falha envio email cancelamento:', mailErr?.message||mailErr); }
        delete conversationStates[senderPhone];
        return;
      }
    }

    // 2) Cancel active flow
    if (currentState === 'AWAITING_CANCEL_CONFIRMATION') {
      const agendamentoAtivo = await buscarAgendamentoAtivo(senderPhone);
      if (agendamentoAtivo && isAff) {
        const { nome, telefone, data, horario, calendarId, linha, email } = agendamentoAtivo;
        try {
          await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]);
          if (calendarId) { await deleteCalendarEvent(calendarId); await updateCell(`${SHEET_NAME}!I${linha}`, [['']]); }
          const msgDentistaCancelado = `🔴 AGENDAMENTO CANCELADO:\nPaciente: ${nome}\nTelefone: ${senderPhone}\nData: ${data}\nHorário: ${horario}`;
          if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaCancelado);
          await msg.reply(`✅ Seu agendamento em ${data} às ${horario} foi CANCELADO com sucesso. Para reagendar, envie AGENDAR.`);
          try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🔴 AGENDAMENTO CANCELADO', text: msgDentistaCancelado }); } catch (mailErr) { console.warn('Falha email cancelamento:', mailErr?.message||mailErr); }
        } catch (e) { console.error('Erro no cancelamento ativo:', e); await msg.reply('❌ Falha no cancelamento. Tente novamente mais tarde.'); }
        delete conversationStates[senderPhone];
        return;
      } else if (isNeg) {
        await msg.reply('Cancelamento abortado. Em que mais posso ajudar?');
        delete conversationStates[senderPhone];
        return;
      }
    }

    // 3) User requests cancel
    if (userWantsToCancel) {
      const agendamentoAtivo = await buscarAgendamentoAtivo(senderPhone);
      if (agendamentoAtivo) {
        const { data, horario } = agendamentoAtivo;
        await msg.reply(`Você tem um agendamento ATIVO para **${data}** às **${horario}**. Você deseja **CANCELAR** este agendamento? Responda **SIM** para confirmar.`);
        conversationStates[senderPhone] = 'AWAITING_CANCEL_CONFIRMATION';
        return;
      } else {
        await msg.reply('Não encontrei agendamentos ativos vinculados a este número.');
        delete conversationStates[senderPhone];
        return;
      }
    }

    // 4) Awaiting link flow
    if (currentState === 'AWAITING_LINK') {
      if (isAff) { await msg.reply(`Ótimo! Aqui está o link para agilizar seu agendamento online:\n${LINK_AGENDAMENTO}/agendamento.html`); delete conversationStates[senderPhone]; return; }
      if (isNeg) { await msg.reply('Entendi. Posso ajudar em outra coisa?'); delete conversationStates[senderPhone]; return; }
    }

    // 5) If simple yes/no outside context
    if (isAff || isNeg) {
      await msg.reply('Não entendi exatamente. Posso te ajudar a agendar uma avaliação? Responda SIM para receber o link.');
      conversationStates[senderPhone] = 'AWAITING_LINK';
      return;
    }

    // 6) Generic humanized response
    const intent = detectIntentWhatsApp(userMessage);
    const replyText = generateResponseWhatsApp(intent);
    try {
      await msg.reply(replyText);
      if (intent === 'greeting') delete conversationStates[senderPhone]; else conversationStates[senderPhone] = 'AWAITING_LINK';
    } catch (err) {
      console.error('Erro ao enviar resposta humanizada:', err);
      await msg.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente mais tarde.');
    }

  } catch (e) {
    console.error('erro no handler whatsapp:', e?.message || e);
  }
});

// =========================
// API Endpoints (public)
// =========================
app.get('/', (req, res) => res.send('Servidor Dentista Pro está ativo.'));

// Endpoint for frontend to poll QR/status
app.get('/api/whatsapp/status', (req, res) => {
  res.json({ status: waStatus, qrCodeBase64: waQrCodeBase64 });
});

// readiness endpoint used by agendamento frontend
app.get('/api/agendamento/status-whatsapp', (req, res) => {
  res.json({ isReady: waStatus === 'connected', status: waStatus });
});

// availability endpoint (consults Google Calendar for CONFIRMADOS)
app.get('/api/disponibilidade', async (req, res) => {
  try {
    const { dia, mes, ano } = req.query;
    if (!dia || !mes || !ano) return res.status(400).json({ error: 'dia, mes e ano são obrigatórios' });
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    const dateStart = new Date(ano, mes - 1, dia);
    const dateEnd = new Date(ano, mes - 1, dia);
    dateEnd.setHours(23,59,59,999);
    const calendarResponse = await calendar.events.list({ calendarId: CALENDAR_ID, timeMin: dateStart.toISOString(), timeMax: dateEnd.toISOString(), singleEvents: true, orderBy: 'startTime' });
    const busy = new Set();
    (calendarResponse.data.items || []).forEach(ev => {
      if (ev.start && ev.start.dateTime) {
        const start = new Date(ev.start.dateTime);
        const end = new Date(ev.end.dateTime);
        let cur = new Date(start);
        while (cur.getTime() < end.getTime()) {
          busy.add(`${String(cur.getHours()).padStart(2,'0')}:${String(cur.getMinutes()).padStart(2,'0')}`);
          cur.setMinutes(cur.getMinutes() + DURACAO_CONSULTA_MIN);
        }
      }
    });
    const avail = HORARIOS_ATENDIMENTO_INICIAL.filter(t => !busy.has(t));
    return res.json({ disponiveis: avail });
  } catch (e) { console.error('/api/disponibilidade error', e?.message || e); return res.status(500).json({ error: 'Erro ao consultar disponibilidade' }); }
});

// POST /api/agendar - creates Pendente row in Sheet (does NOT create Calendar event)
app.post('/api/agendar', async (req, res) => {
  try {
    const { nome, telefone, email, data_agendamento, horario, procedimento } = req.body;
    if (!nome || !telefone || !email || !data_agendamento || !horario || !procedimento) return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    const id = uuidv4(); const criado_em = new Date().toISOString();
    const row = [id, nome, telefone, email, data_agendamento, horario, 'Pendente', procedimento, '', '', '', criado_em];
    const appendResp = await appendRow(row);
    const updatedRange = appendResp.data.updates && appendResp.data.updates.updatedRange;
    const linha = updatedRange ? extractRowFromUpdatedRange(updatedRange) : null;
    const msgCliente = `⚠️*PRÉ-CONFIRMAÇÃO NECESSÁRIA!*⚠️\nOlá ${nome}, sua avaliação está AGENDADA (pré) para ${data_agendamento} às ${horario}. Responda *SIM* por aqui para confirmar.`;
    const msgDentista = `🟡 NOVO AGENDAMENTO PENDENTE\nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data_agendamento}\nHorário: ${horario}`;
    await enviarMensagemWhatsApp(telefone, msgCliente);
    if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentista);
    try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Pré-Confirmação de Agendamento', text: msgCliente }); await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: 'Novo Agendamento Pendente', text: msgDentista }); } } catch (mailErr) { console.warn('Falha envio e-mails (não crítico):', mailErr?.message||mailErr); }
    console.log(`✅ Agendamento PENDENTE criado: ${nome} - linha ${linha || 'desconhecida'}`);
    return res.json({ ok: true, id, linha });
  } catch (e) { console.error('/api/agendar error', e?.message || e); return res.status(500).json({ ok: false, error: 'Falha ao agendar' }); }
});

// POST /api/cancelar - dentist cancels by id
app.post('/api/cancelar', async (req, res) => {
  try {
    const { id } = req.body; if (!id) return res.status(400).json({ error: 'ID do agendamento é obrigatório.' });
    const clientAuth = await auth.getClient(); const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` });
    const rows = response.data.values || [];
    let linha = null; let agendamentoData = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) {
        linha = i+1;
        agendamentoData = { id: rows[i][0], nome: rows[i][1], telefone: rows[i][2], data: rows[i][4], horario: rows[i][5], calendarId: rows[i][8], statusAtual: rows[i][6] };
        break;
      }
    }
    if (!linha) return res.status(404).json({ ok:false, error: 'Agendamento não encontrado na planilha.' });
    if (agendamentoData.statusAtual && agendamentoData.statusAtual.toLowerCase() === 'cancelado') return res.json({ ok:true, message: 'Agendamento já estava Cancelado.' });
    await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]);
    if (agendamentoData.calendarId) { await deleteCalendarEvent(agendamentoData.calendarId); await updateCell(`${SHEET_NAME}!I${linha}`, [['']]); }
    const msgClienteCancelado = `⚠️ *CANCELAMENTO EFETUADO* ⚠️\n\nOlá ${agendamentoData.nome}, o seu agendamento para ${agendamentoData.data} às ${agendamentoData.horario} foi **CANCELADO** pela clínica.`;
    await enviarMensagemWhatsApp(agendamentoData.telefone, msgClienteCancelado);
    console.log(`❌ Agendamento Cancelado pelo Dentista: ${agendamentoData.nome}`);
    return res.json({ ok:true, message: `Agendamento ${id} cancelado com sucesso.` });
  } catch (e) { console.error('/api/cancelar error', e?.message || e); return res.status(500).json({ ok:false, error: 'Falha ao cancelar o agendamento via API' }); }
});

// GET /api/agendamentos-planilha - return sheet rows to dashboard
app.get('/api/agendamentos-planilha', async (req, res) => {
  try {
    const clientAuth = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` });
    const rows = response.data.values;
    if (!rows || rows.length < 2) return res.json([]);
    const headers = rows[0].map(h => String(h).trim());
    const agendamentos = rows.slice(1).map(row => { const obj = {}; headers.forEach((header,index) => { obj[header] = row[index] || ""; }); obj.data = obj.data_agendamento || obj.data || ""; return obj; });
    res.json(agendamentos);
  } catch (error) { console.error('/api/agendamentos-planilha error', error?.message || error); res.status(500).json({ error: 'Erro ao acessar a planilha' }); }
});

// ------------------
// Reminders job (24h & 2h) - uses spreadsheet columns J/K to mark notifications
// ------------------
const REMINDER_INTERVAL_MINUTES = Number(process.env.REMINDER_INTERVAL_MINUTES || 5);
const TOLERANCE_MINUTES = 10;

async function runRemindersJob() {
  try {
    const clientAuth = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` });
    const rows = response.data.values || [];
    if (rows.length < 2) return;
    const now = new Date();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; const linha = i+1;
      const id = row[0] || ''; const nome = row[1] || ''; const telefone = row[2] || ''; const email = row[3] || ''; const data_agendamento = row[4] || ''; const horario = row[5] || ''; const status = String(row[6] || '').toLowerCase();
      const procedimento = row[7] || 'sua avaliação';
      const calendarId = row[8] || '';
      const notificado_cliente = String(row[9] || '').toLowerCase();
      const notificado_dentista = String(row[10] || '').toLowerCase();
      if (!id || status !== 'confirmado') continue;
      if (!data_agendamento || !horario) continue;
      const parts = data_agendamento.split('/'); if (parts.length !== 3) continue;
      const day = Number(parts[0]); const month = Number(parts[1]) - 1; const year = Number(parts[2]); const [hh, mm] = horario.split(':').map(Number);
      const appointmentDate = new Date(year, month, day, hh, mm, 0);
      const diffMs = appointmentDate.getTime() - now.getTime(); const diffMinutes = Math.round(diffMs / 60000);
      const target24 = 24 * 60; const target2 = 2 * 60;
      if (Math.abs(diffMinutes - target24) <= TOLERANCE_MINUTES && notificado_cliente !== '1') {
        const msgCliente24 = `🔔 Lembrete: Olá ${nome}, seu agendamento para *${procedimento}* é amanhã às ${horario}. Caso precise alterar ou cancelar, responda por aqui.`;
        await enviarMensagemWhatsApp(telefone, msgCliente24);
        if (DENTIST_PHONE) { const msgDentista24 = `🔔 Lembrete 24h: Paciente ${nome} (${procedimento}) - ${data_agendamento} ${horario}`; await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentista24); }
        try { await updateCell(`${SHEET_NAME}!J${linha}`, [['1']]); await updateCell(`${SHEET_NAME}!K${linha}`, [['1']]); } catch (e) { console.warn('Falha ao marcar notificado 24h:', e?.message||e); }
        console.log(`⏰ Lembrete 24h enviado para linha ${linha} (${nome})`);
      }
      if (Math.abs(diffMinutes - target2) <= TOLERANCE_MINUTES && notificado_cliente !== '2') {
        const msgCliente2 = `⏰ Lembrete: Olá ${nome}, seu agendamento para *${procedimento}* é HOJE às ${horario}. Estaremos te aguardando!`;
        await enviarMensagemWhatsApp(telefone, msgCliente2);
        if (DENTIST_PHONE) { const msgDentista2 = `⏰ Lembrete 2h: Paciente ${nome} (${procedimento}) - ${data_agendamento} ${horario}`; await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentista2); }
        try { await updateCell(`${SHEET_NAME}!J${linha}`, [['2']]); await updateCell(`${SHEET_NAME}!K${linha}`, [['2']]); } catch (e) { console.warn('Falha ao marcar notificado 2h:', e?.message||e); }
        console.log(`⏰ Lembrete 2h enviado para linha ${linha} (${nome})`);
      }
    }
  } catch (e) { console.error('Erro no job de lembretes:', e?.message || e); }
}

setInterval(runRemindersJob, REMINDER_INTERVAL_MINUTES * 60000);
console.log(`⏱️ Job de lembretes configurado para rodar a cada ${REMINDER_INTERVAL_MINUTES} minutos.`);

// Start server
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse a página de conexão em http://localhost:${PORT}/connect.html (ou https://<seu-app>.koyeb.app/connect.html)`);
});

// End of server.js
