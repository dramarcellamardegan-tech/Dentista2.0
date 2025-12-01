// server.js - Versão otimizada para execução em hosts como Koyeb/Replit
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

// ---------------------
// Configs e constantes
// ---------------------
const PORT = process.env.PORT || 8000;
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

// Pasta de sessão (escolha do usuário: workspace/session)
const SESSION_DIR = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_DIR)) {
  try { fs.mkdirSync(SESSION_DIR); console.log('✅ Pasta session/ criada.'); } catch (e) { console.warn('⚠️ Falha ao criar session/:', e.message); }
}

// Util: injetar config no HTML (caso precise)
function serveHtmlWithConfig(filePath, res) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Erro ao carregar a página.');
    const htmlComConfig = data.replace(/__FIREBASE_CONFIG_PLACEHOLDER__/g, firebaseConfigJson);
    res.send(htmlComConfig);
  });
}

// Rotas que precisam da injeção (se existir esse placeholder nos HTMLs)
app.get('/connect.html', (req, res) => serveHtmlWithConfig(path.join(__dirname, 'public', 'connect.html'), res));
app.get('/loginqrcode.html', (req, res) => serveHtmlWithConfig(path.join(__dirname, 'public', 'loginqrcode.html'), res));
app.get('/login.html', (req, res) => serveHtmlWithConfig(path.join(__dirname, 'public', 'login.html'), res));

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------------
// Firebase Admin (opcional)
// ---------------------
try {
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'gcp-service-account.json');
  if (fs.existsSync(saPath)) {
    const serviceAccount = require(saPath);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin SDK inicializado.');
  } else {
    console.log("⚠️ Arquivo de credenciais Firebase 'gcp-service-account.json' não encontrado. Firebase Admin não inicializado.");
  }
} catch (e) {
  console.warn('❌ Erro ao inicializar Firebase Admin:', e.message);
}

// ---------------------
// Google Auth (Sheets/Calendar) - opcional
// ---------------------
let googleClientEmail = process.env.GOOGLE_CLIENT_EMAIL;
let googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || null;
const SHEET_NAME = (process.env.SHEET_NAME || 'cadastro_agenda').trim();
const CALENDAR_ID = process.env.CALENDAR_ID || null;
const DENTIST_EMAIL = process.env.DENTIST_EMAIL || null;
const DENTIST_PHONE = process.env.DENTIST_PHONE || null;

if (!SPREADSHEET_ID || !CALENDAR_ID || !DENTIST_EMAIL) {
  console.warn('⚠️ Atenção: SPREADSHEET_ID, CALENDAR_ID ou DENTIST_EMAIL não estão configurados. Algumas funcionalidades (Sheets/Calendar/email) podem falhar.');
}

const privateKeyCleaned = googlePrivateKey ? googlePrivateKey.trim().replace(/^['\"]|['\"]$/g, '').replace(/\\n/g, '\n') : null;
const auth = new google.auth.GoogleAuth({
  credentials: googleClientEmail && privateKeyCleaned ? { client_email: googleClientEmail, private_key: privateKeyCleaned } : undefined,
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar'],
});

// ---------------------
// Nodemailer (opcional)
// ---------------------
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }, tls: { rejectUnauthorized: false } });
  transporter.verify().then(() => console.log('✅ Nodemailer ready')).catch(err => console.warn('⚠️ Nodemailer verify failed:', err && err.message ? err.message : err));
} else {
  console.warn('⚠️ Nodemailer não configurado. Defina EMAIL_USER e EMAIL_PASS para habilitar envios de e-mail.');
}

// ---------------------
// WhatsApp client (LocalAuth -> session directory)
// ---------------------
let waStatus = 'loading';
let waQrCodeBase64 = null;
let clientReady = false;

const waClient = new Client({
  authStrategy: new LocalAuth({ clientId: 'dentista-ia', dataPath: SESSION_DIR }),
  // Minimal puppeteer options. Em ambientes hospedados isso ainda pode requerer um binário do Chrome.
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
  takeoverOnConflict: true
});

waClient.on('qr', async qr => {
  waStatus = 'qr_code';
  try {
    waQrCodeBase64 = await qrcode.toDataURL(qr);
    console.log('🔎 QR Code gerado (base64).');
    try { require('qrcode-terminal').generate(qr, { small: true }); } catch (e) {}
  } catch (e) { waStatus = 'error'; console.error('❌ Erro ao gerar QR Code Base64:', e); }
});

waClient.on('ready', () => { waStatus = 'connected'; clientReady = true; waQrCodeBase64 = null; console.log('✅ WhatsApp Client pronto.'); });
waClient.on('authenticated', () => console.log('✅ WhatsApp authenticated'));
waClient.on('auth_failure', e => { waStatus = 'error'; console.error('❌ WhatsApp auth_failure', e); });
waClient.on('disconnected', reason => { waStatus = 'disconnected'; console.log('🔴 WhatsApp disconnected:', reason); clientReady = false; setTimeout(() => { try { waClient.initialize(); } catch (e) { console.error('Erro reinicializando WA client:', e); } }, 3000); });

// Inicializa, mas não deixa o processo morrer caso haja erro
try {
  waClient.initialize();
} catch (e) {
  console.error('Erro inicializando cliente WhatsApp:', e && e.message ? e.message : e);
}

// ---------------------
// Helpers
// ---------------------
function normalizePhone(n) { if (!n) return ''; let s = String(n).replace(/\D/g, ''); if (s.length === 10 || s.length === 11) s = '55' + s; if (!s.startsWith('55')) s = '55' + s; return s; }
async function enviarMensagemWhatsApp(numero, mensagem) { try { if (waStatus !== 'connected') { console.warn('⚠️ WhatsApp not connected; skipping message'); return false; } const limpo = normalizePhone(numero); if (!limpo) throw new Error('numero inválido'); await waClient.sendMessage(`${limpo}@c.us`, mensagem); console.log('💬 Mensagem enviada para', limpo); return true; } catch (e) { console.error('❌ Erro enviarMensagemWhatsApp:', e && e.message ? e.message : e); return false; } }

// Sheets helpers (wrapped to fail-safe)
async function getSheetsClient() { try { return await auth.getClient(); } catch (e) { console.warn('⚠️ Google Auth não disponível:', e.message || e); return null; } }
async function appendRow(values) { const clientAuth = await getSheetsClient(); if (!clientAuth) throw new Error('Google auth missing'); const sheets = google.sheets({ version: 'v4', auth: clientAuth }); return await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] } }); }
async function updateCell(rangeA1, values) { const clientAuth = await getSheetsClient(); if (!clientAuth) throw new Error('Google auth missing'); const sheets = google.sheets({ version: 'v4', auth: clientAuth }); return await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: rangeA1, valueInputOption: 'RAW', requestBody: { values }, }); }

// Calendar helpers (fail-safe)
async function createCalendarEvent(nome, telefone, dataDDMMYYYY, horario) {
  try {
    const clientAuth = await getSheetsClient(); if (!clientAuth) return null;
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    const [dia, mes, ano] = String(dataDDMMYYYY).split('/');
    const startISO = new Date(`${ano}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}T${horario}:00`).toISOString();
    const end = new Date(new Date(startISO).getTime() + (Number(process.env.DURACAO_CONSULTA_MIN) || 30) * 60000).toISOString();
    const event = { summary: `[CONFIRMADO] Avaliação - ${nome}`, description: `Agendamento confirmado via bot. Telefone: ${telefone}`, start: { dateTime: startISO, timeZone: process.env.TIMEZONE || 'America/Sao_Paulo' }, end: { dateTime: end, timeZone: process.env.TIMEZONE || 'America/Sao_Paulo' }, colorId: 2 };
    const resp = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
    return resp.data.id;
  } catch (e) { console.warn('⚠️ Falha ao criar evento no Calendar:', e.message || e); return null; }
}
async function deleteCalendarEvent(eventId) { try { if (!eventId) return false; const clientAuth = await getSheetsClient(); if (!clientAuth) return false; const calendar = google.calendar({ version: 'v3', auth: clientAuth }); await calendar.events.delete({ calendarId: CALENDAR_ID, eventId }); return true; } catch (e) { console.warn('⚠️ Falha ao deletar evento no Calendar:', e.message || e); return false; } }

// ---------------------
// Conversational flow (simplificado)
// ---------------------
function normalizeForIntent(text) { if (!text) return ''; return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim(); }
function detectIntentWhatsApp(text) { const n = normalizeForIntent(text); if (/\b(oi|ola|bom dia|boa tarde|boa noite|tudo bem)\b/.test(n)) return 'greeting'; if (/\b(preco|valor|quanto|custa|orcamento|orçamento)\b/.test(n)) return 'price'; if (/\b(dor|doendo|inflamado|urgente|sangrando|nao aguento)\b/.test(n)) return 'pain'; if (/\b(aparelho|alinhador|invisalign|mordida|ortodont)\b/.test(n)) return 'ortho'; if (/\b(clareamento|restaur|lente|limpeza|tartaro|canal|estetic|estetica)\b/.test(n)) return 'dent'; if (/\b(botox|preenchimento|fio|harmoniza|harmonizacao)\b/.test(n)) return 'hof'; if (/\b(agendar|consulta|horario|marcar|agenda|disponivel|disponível)\b/.test(n)) return 'agendar'; if (/\b(cancelar|remarcar|reagendar|desmarcar)\b/.test(n)) return 'desagendar'; if (/\b(sim|claro|pode|quero)\b/.test(n)) return 'confirm'; if (/\b(nao|não|depois|outra hora|agora nao|agora não)\b/.test(n)) return 'deny'; return 'fallback'; }
function generateResponseWhatsApp(intent) { const base = (process.env.LINK_AGENDAMENTO || process.env.USER_WEBSITE_ORIGIN || 'https://dramarcellamardegan.com.br').replace(/['\"]/g,''); const agendarPath = base ? (base.endsWith('/') ? base + 'agendamento.html' : base + '/agendamento.html') : '/agendamento.html'; const CTA = `\n\n🟩 *AGENDAR AGORA*\n👉 ${agendarPath}`; switch(intent) { case 'greeting': return `Olá 👋! Sou a assistente virtual da Dra. Marcella. Como posso te ajudar hoje?`; case 'price': return `Entendo sua dúvida sobre valores. Como cada tratamento é personalizado, a Dra. Marcella só passa orçamento após avaliação presencial. ${CTA}`; case 'pain': return `Sinto muito que esteja sentindo dor. 😔 Casos com dor são priorizados — a melhor forma de resolver com segurança é uma avaliação. ${CTA}`; case 'agendar': return `Perfeito — podemos marcar sua avaliação agora. Toque no link abaixo para escolher o melhor horário: ${CTA}`; case 'confirm': return `Ótimo! Vou deixar o link para você agendar agora: ${CTA}`; case 'deny': return `Sem problemas — se preferir, posso te ajudar com outras dúvidas ou deixar o link para agendar mais tarde: ${CTA}`; default: return `Posso te ajudar melhor pessoalmente com a avaliação da Dra. Marcella. Para agendar é só tocar no link abaixo: ${CTA}`; } }

// ---------------------
// WhatsApp message handler
// ---------------------
waClient.on('message', async msg => {
  try {
    const userMessage = msg.body;
    const senderPhone = normalizePhone(msg.from);
    const chat = await msg.getChat();
    if (chat.isGroup) return; // ignore groups

    let agendamentoPendente = null;
    try { if (SPREADSHEET_ID) agendamentoPendente = await buscarAgendamentoPendente(senderPhone); } catch (e) { }

    const isAff = ['sim','s','claro','pode','confirmo'].includes(String(userMessage||'').toLowerCase().trim());
    const isNeg = ['nao','não','n','depois','cancelar','cancela','agora não','agora nao'].includes(String(userMessage||'').toLowerCase().trim());

    if (agendamentoPendente) {
      const { nome, telefone, data, horario, calendarId, linha, email } = agendamentoPendente;
      if (isAff) {
        try { const eventId = await createCalendarEvent(nome, telefone, data, horario); if (eventId) { try { await updateCell(`${SHEET_NAME}!I${linha}`, [[eventId]]); } catch(e){} } await updateCell(`${SHEET_NAME}!G${linha}`, [['Confirmado']]); const msgDentistaConfirmado = `🟢 AGENDAMENTO CONFIRMADO: \nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data}\nHorário: ${horario}`; if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaConfirmado); await msg.reply(`🎉 *AGENDAMENTO CONFIRMADO!* 🎉\n\nQue ótimo, ${nome}! Seu horário para *${data}* às *${horario}* está CONFIRMADO.`); if (transporter && email) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: '✅ Confirmação de Agendamento', text: `Seu agendamento em ${data} às ${horario} foi CONFIRMADO com sucesso!`}); await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🟢 AGENDAMENTO CONFIRMADO', text: msgDentistaConfirmado }); } } catch (e) { console.error('❌ Erro ao confirmar agendamento:', e); await msg.reply('❌ Ocorreu um erro ao confirmar seu agendamento.'); } return; }
      if (isNeg) { try { await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]); const msgDentistaCancelado = `🔴 AGENDAMENTO CANCELADO (pendente): \nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data}\nHorário: ${horario}`; if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaCancelado); await msg.reply(`Ok ${nome}, seu agendamento em ${data} às ${horario} foi CANCELADO.`); if (transporter) await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🔴 AGENDAMENTO CANCELADO', text: msgDentistaCancelado }); } catch(e){ console.warn('⚠️ Erro cancel pendente', e); } return; }
    }

    const intent = detectIntentWhatsApp(userMessage);
    const replyText = generateResponseWhatsApp(intent);
    try { await msg.reply(replyText); } catch (err) { console.error('Erro ao enviar resposta:', err); }
  } catch (e) { console.error('erro handler whatsapp:', e); }
});

// ---------------------
// Endpoints: status, disponibilidade, agendar, cancelar, agendamentos-planilha
// ---------------------
app.get('/api/whatsapp/status', (req, res) => res.json({ status: waStatus, qrCodeBase64: waQrCodeBase64 }));
app.get('/api/agendamento/status-whatsapp', (req, res) => res.json({ isReady: waStatus === 'connected', status: waStatus }));

app.get('/api/disponibilidade', async (req, res) => {
  try { const { dia, mes, ano } = req.query; if (!dia||!mes||!ano) return res.status(400).json({ error:'dia, mes e ano são obrigatórios' }); const clientAuth = await getSheetsClient(); if (!clientAuth) return res.status(500).json({ error: 'Google auth missing' }); const calendar = google.calendar({ version: 'v3', auth: clientAuth }); const dateStart = new Date(ano, mes-1, dia); const dateEnd = new Date(ano, mes-1, dia); dateEnd.setHours(23,59,59,999); const calendarResponse = await calendar.events.list({ calendarId: CALENDAR_ID, timeMin: dateStart.toISOString(), timeMax: dateEnd.toISOString(), singleEvents:true, orderBy:'startTime' }); const busy = new Set(); (calendarResponse.data.items||[]).forEach(ev=>{ if(ev.start && ev.start.dateTime){ const start = new Date(ev.start.dateTime); const end = new Date(ev.end.dateTime); let cur = new Date(start); while(cur.getTime() < end.getTime()){ busy.add(`${String(cur.getHours()).padStart(2,'0')}:${String(cur.getMinutes()).padStart(2,'0')}`); cur.setMinutes(cur.getMinutes() + (Number(process.env.DURACAO_CONSULTA_MIN) || 30)); } } }); const HORARIOS = (process.env.HORARIOS_ATENDIMENTO || '17:30,18:00,18:30,19:00,19:30,20:00').split(','); const avail = HORARIOS.filter(t=>!busy.has(t)); return res.json({ disponiveis: avail }); } catch(e){ console.error('/api/disponibilidade error:', e); return res.status(500).json({ error: 'Erro ao consultar disponibilidade' }); } });

app.post('/api/agendar', async (req, res) => {
  try {
    const { nome, telefone, email, data_agendamento, horario, procedimento } = req.body;
    if (!nome||!telefone||!email||!data_agendamento||!horario||!procedimento) return res.status(400).json({ error:'Todos os campos são obrigatórios.' });
    const id = uuidv4(); const criado_em = new Date().toISOString();
    const row = [id, nome, telefone, email, data_agendamento, horario, 'Pendente', procedimento, '', '', '', criado_em];
    try { await appendRow(row); } catch (e) { console.warn('⚠️ Falha ao inserir na planilha:', e.message || e); }
    const msgCliente = `⚠️*PRÉ-CONFIRMAÇÃO NECESSÁRIA!*⚠️\nOlá ${nome}, sua avaliação está AGENDADA (pré) para ${data_agendamento} às ${horario}. Responda *SIM* por aqui para confirmar.`;
    await enviarMensagemWhatsApp(telefone, msgCliente);
    if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, `🟡 NOVO AGENDAMENTO PENDENTE\nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data_agendamento}\nHorário: ${horario}`);
    if (transporter) { try { await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Pré-Confirmação de Agendamento', text: msgCliente }); await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: 'Novo Agendamento Pendente', text: `Paciente: ${nome} - ${data_agendamento} ${horario}` }); } catch(e){ console.warn('⚠️ Falha envio e-mails:', e.message||e); } }
    return res.json({ ok:true, id });
  } catch(e){ console.error('ERRO /api/agendar:', e); return res.status(500).json({ ok:false, error:'Falha ao agendar' }); }
});

app.post('/api/cancelar', async (req,res)=>{
  try{ const { id } = req.body; if (!id) return res.status(400).json({ error:'ID do agendamento é obrigatório.' }); const clientAuth = await getSheetsClient(); if (!clientAuth) return res.status(500).json({ error: 'Google auth missing' }); const sheets = google.sheets({ version:'v4', auth: clientAuth }); const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` }); const rows = response.data.values||[]; let linha=null; let ag=null; for(let i=1;i<rows.length;i++){ if(rows[i][0]===id){ linha = i+1; ag = rows[i]; break; } } if(!linha) return res.status(404).json({ ok:false, error:'Agendamento não encontrado' }); if(String(ag[6]||'').toLowerCase()==='cancelado') return res.json({ ok:true, message:'Agendamento já estava Cancelado.' }); await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]); const calendarId = ag[8] || ''; if (calendarId) { await deleteCalendarEvent(calendarId); await updateCell(`${SHEET_NAME}!I${linha}`, [['']]); } await enviarMensagemWhatsApp(ag[2], `⚠️ *CANCELAMENTO EFETUADO* ⚠️\nOlá ${ag[1]}, seu agendamento para ${ag[4]} às ${ag[5]} foi CANCELADO.`); return res.json({ ok:true, message:`Agendamento ${id} cancelado.` }); } catch(e){ console.error('ERRO /api/cancelar:', e); return res.status(500).json({ ok:false, error:'Falha ao cancelar' }); } });

app.get('/api/agendamentos-planilha', async (req,res)=>{ try{ const clientAuth = await getSheetsClient(); if (!clientAuth) return res.status(500).json({ error: 'Google auth missing' }); const sheets = google.sheets({ version:'v4', auth: clientAuth }); const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` }); const rows = response.data.values; if(!rows||rows.length<2) return res.json([]); const headers = rows[0].map(h=>String(h).trim()); const agendamentos = rows.slice(1).map(row=>{ const obj = {}; headers.forEach((h,idx)=> obj[h] = row[idx] || ''); obj.data = obj.data_agendamento || obj.data || ''; return obj; }); return res.json(agendamentos); } catch(e){ console.error('ERRO agendamentos-planilha:', e); return res.status(500).json({ error:'Erro ao acessar a planilha' }); } });

// ---------------------
// Lembretes (cron interno simples)
// ---------------------
const REMINDER_INTERVAL_MINUTES = Number(process.env.REMINDER_INTERVAL_MINUTES) || 5;
const TOLERANCE_MINUTES = 10;
async function runRemindersJob(){ try{ const clientAuth = await getSheetsClient(); if (!clientAuth) return; const sheets = google.sheets({ version:'v4', auth: clientAuth }); const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` }); const rows = response.data.values || []; if(rows.length<2) return; const now = new Date(); for(let i=1;i<rows.length;i++){ const row = rows[i]; const linha = i+1; const id = row[0]||''; const nome = row[1]||''; const telefone = row[2]||''; const email = row[3]||''; const data_agendamento = row[4]||''; const horario = row[5]||''; const status = String(row[6]||'').toLowerCase(); const procedimento = row[7] || 'sua avaliação'; const calendarId = row[8] || ''; const notificado_cliente = String(row[9]||'').toLowerCase(); const notificado_dentista = String(row[10]||'').toLowerCase(); if(!id||status!=='confirmado') continue; if(!data_agendamento||!horario) continue; const parts = data_agendamento.split('/'); if(parts.length!==3) continue; const day = Number(parts[0]); const month = Number(parts[1]) - 1; const year = Number(parts[2]); const [hh,mm] = horario.split(':').map(Number); const appointmentDate = new Date(year,month,day,hh,mm,0); const diffMs = appointmentDate.getTime() - now.getTime(); const diffMinutes = Math.round(diffMs/60000); const target24 = 24*60; const target2 = 2*60; if (Math.abs(diffMinutes-target24) <= TOLERANCE_MINUTES && notificado_cliente !== '1') { const msgCliente24 = `🔔 Lembrete: Olá ${nome}, seu agendamento para *${procedimento}* é amanhã às ${horario}. Caso precise alterar ou cancelar, responda por aqui.`; await enviarMensagemWhatsApp(telefone, msgCliente24); if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, `🔔 Lembrete 24h: Paciente ${nome} (${procedimento}) - ${data_agendamento} ${horario}`); try { await updateCell(`${SHEET_NAME}!J${linha}`, [['1']]); await updateCell(`${SHEET_NAME}!K${linha}`, [['1']]); } catch(e){ console.warn('⚠️ Falha ao marcar notificado 24h', e); } }
 if (Math.abs(diffMinutes-target2) <= TOLERANCE_MINUTES && notificado_cliente !== '2') { const msgCliente2 = `⏰ Lembrete: Olá ${nome}, seu agendamento para *${procedimento}* é HOJE às ${horario}. Estaremos te aguardando!`; await enviarMensagemWhatsApp(telefone, msgCliente2); if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, `⏰ Lembrete 2h: Paciente ${nome} (${procedimento}) - ${data_agendamento} ${horario}`); try { await updateCell(`${SHEET_NAME}!J${linha}`, [['2']]); await updateCell(`${SHEET_NAME}!K${linha}`, [['2']]); } catch(e){ console.warn('⚠️ Falha ao marcar notificado 2h', e); } }
 }
 } catch(e){ console.error('❌ Erro no job de lembretes:', e && (e.response?.data || e.message || e)); }
}
setInterval(runRemindersJob, REMINDER_INTERVAL_MINUTES * 60000);
console.log(`⏱️ Job de lembretes configurado para rodar a cada ${REMINDER_INTERVAL_MINUTES} minutos.`);

// ---------------------
// Helpers de busca na planilha usados por WA flows
// ---------------------
async function buscarAgendamentoPendente(telefone){ try{ const clientAuth = await getSheetsClient(); if (!clientAuth) return null; const sheets = google.sheets({ version:'v4', auth: clientAuth }); const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` }); const rows = response.data.values||[]; if(rows.length<2) return null; const telefoneLimpo = normalizePhone(telefone); for(let i=1;i<rows.length;i++){ const row = rows[i]; const status = String(row[6]||'').toLowerCase(); const telefonePlanilha = normalizePhone(row[2]||''); if(status==='pendente' && telefonePlanilha===telefoneLimpo){ return { nome: row[1], telefone: telefonePlanilha, data: row[4], horario: row[5], calendarId: row[8], linha: i+1, email: row[3] }; } } return null;}catch(e){ console.error('❌ Error buscarAgendamentoPendente:', e && (e.response?.data || e.message || e)); return null;} }

async function buscarAgendamentoAtivo(telefone){ try{ const clientAuth = await getSheetsClient(); if (!clientAuth) return null; const sheets = google.sheets({ version:'v4', auth: clientAuth }); const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` }); const rows = response.data.values||[]; if(rows.length<2) return null; const telefoneLimpo = normalizePhone(telefone); for(let i=rows.length-1;i>=1;i--){ const row = rows[i]; const status = String(row[6]||'').toLowerCase(); const telefonePlanilha = normalizePhone(row[2]||''); if((status==='pendente' || status==='confirmado') && telefonePlanilha===telefoneLimpo){ return { nome: row[1], telefone: telefonePlanilha, data: row[4], horario: row[5], calendarId: row[8], linha: i+1, email: row[3], statusAtual: row[6] }; } } return null; }catch(e){ console.error('❌ Error buscarAgendamentoAtivo:', e && e.message || e); return null; } }

// ---------------------
// Rota de teste
// ---------------------
app.get('/', (req,res)=> res.send('Servidor Dentista Pro está ativo.'));

// ---------------------
// Inicia servidor
// ---------------------
app.listen(PORT, ()=>{ console.log(`Servidor rodando na porta ${PORT}`); console.log(`Acesse a página de conexão em http://localhost:${PORT}/connect.html`); });
