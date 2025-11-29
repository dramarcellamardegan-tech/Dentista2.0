// server.js - Versão final integrada
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
// ALTERADO: Usando 'qrcode' para gerar Base64, e 'qrcode-terminal' foi removido
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin'); // ESSENCIAL: Importa o Admin SDK
const app = express();

const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || null,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
  projectId: process.env.FIREBASE_PROJECT_ID || null,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || null,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
  appId: process.env.FIREBASE_APP_ID || null,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || null
};

// String JSON que será injetada.
const firebaseConfigJson = JSON.stringify(FIREBASE_CONFIG);

// Função de utilidade para ler e injetar no HTML
function serveHtmlWithConfig(filePath, res) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Falha ao ler o arquivo HTML:', err);
      return res.status(500).send('Erro interno do servidor: Falha ao carregar a página.');
    }

    // ✅ CORREÇÃO CHAVE: Usa Regex Global para substituir TODAS as ocorrências
    const htmlComConfig = data.replace(
      /__FIREBASE_CONFIG_PLACEHOLDER__/g,
      firebaseConfigJson
    );

    res.send(htmlComConfig);
  });
}

// ROTAS: Adicione esta função a TODAS as rotas que precisam da config
app.get('/connect.html', (req, res) => {
  serveHtmlWithConfig(path.join(__dirname, 'public', 'connect.html'), res);
});

app.get('/loginqrcode.html', (req, res) => {
  serveHtmlWithConfig(path.join(__dirname, 'public', 'loginqrcode.html'), res);
});

app.get('/login.html', (req, res) => {
  serveHtmlWithConfig(path.join(__dirname, 'public', 'login.html'), res);
});

// --- VARIÁVEIS DE CONFIGURAÇÃO DO USUÁRIO (Como fallback) ---
const USER_GCP_CREDENTIALS_FILE = 'gcp-service-account.json';
const USER_WEBSITE_ORIGIN = 'https://dramarcellamardegan.com.br';
// -------------------------------------------------------------

// Inicialização do Firebase Admin SDK
// Ele tenta carregar o arquivo de credenciais que você deve baixar do Firebase Console.
try {
  const serviceAccount = require(`./${USER_GCP_CREDENTIALS_FILE}`);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin SDK inicializado com sucesso.");
} catch (e) {
  console.error("❌ ERRO: Falha ao inicializar o Firebase Admin SDK.");
  console.error(`Certifique-se de que o arquivo '${USER_GCP_CREDENTIALS_FILE}' está na raiz do projeto e é válido.`);
  console.error("A autenticação via Firebase não funcionará sem isso.");
}
// Auto-delete .wwebjs_auth on server start
const authPath = path.join(__dirname, ".wwebjs_auth");
if (fs.existsSync(authPath)) {
  console.log("🧹 Limpando sessão antiga do WhatsApp (.wwebjs_auth)...");
  try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {/*ignore*/ }
  console.log("✔️ Sessão antiga removida com sucesso!");
}

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- NOVO MIDDLEWARE DE AUTENTICAÇÃO COM FIREBASE ---
/**
 * Verifica o Firebase ID Token e anexa o usuário ao objeto req.
 */
async function authenticateFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Acesso negado. Token de autorização ausente ou mal formatado.' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    // Verifica se o token é válido e decodifica as informações do usuário
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next(); // Permite que a requisição prossiga
  } catch (error) {
    console.error('❌ Erro na verificação do token Firebase:', error.message);
    return res.status(401).json({ message: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
}


// ENV
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = (process.env.SHEET_NAME || 'cadastro_agenda').trim();
const CALENDAR_ID = process.env.CALENDAR_ID;
const DENTIST_EMAIL = process.env.DENTIST_EMAIL;
const DENTIST_PHONE = process.env.DENTIST_PHONE;
const PORT = process.env.PORT || 4000;



// Agora usa a URL da Dra. Marcella como fallback
const LINK_AGENDAMENTO = (process.env.LINK_AGENDAMENTO || USER_WEBSITE_ORIGIN).replace(/['"]/g, '');
const DURACAO_CONSULTA_MIN = Number(process.env.DURACAO_CONSULTA_MIN || 30);
const HORARIOS_ATENDIMENTO_INICIAL = (process.env.HORARIOS_ATENDIMENTO || '17:30,18:00,18:30,19:00,19:30,20:00').split(',');
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

// --- Validações iniciais
if (!SPREADSHEET_ID || !CALENDAR_ID || !DENTIST_EMAIL) {
  console.error('❌ .env faltando SPREADSHEET_ID, CALENDAR_ID ou DENTIST_EMAIL');
  process.exit(1);
}

// ---------------------
// Google Auth
// ---------------------
let googleClientEmail = process.env.GOOGLE_CLIENT_EMAIL;
let googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY;
let googleCreds = null;

// Tenta carregar as credenciais a partir do ENV ou do nome de arquivo fornecido pelo usuário
const credsFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || USER_GCP_CREDENTIALS_FILE;

if (credsFilePath) {
  try {
    const p = path.resolve(credsFilePath);
    const raw = fs.readFileSync(p, 'utf8');
    googleCreds = JSON.parse(raw);
    googleClientEmail = googleClientEmail || googleCreds.client_email;
    googlePrivateKey = googlePrivateKey || googleCreds.private_key;
    console.log('✅ Credenciais carregadas do arquivo:', credsFilePath);
  } catch (e) {
    console.warn(`⚠️ Não foi possível ler o arquivo de credenciais (${credsFilePath}):`, e.message);
  }
}

if (!googleClientEmail || !googlePrivateKey) {
  console.warn('⚠️ GOOGLE_CLIENT_EMAIL ou GOOGLE_PRIVATE_KEY não fornecidos; Sheets/Calendar podem falhar.');
}
const privateKeyCleaned = googlePrivateKey ? googlePrivateKey.trim().replace(/^['"]|['"]$/g, '').replace(/\\n/g, '\n') : null;
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: googleClientEmail,
    private_key: privateKeyCleaned,
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar'],
});

// --- ROTAS DA API ---

// Rota de Teste para verificar se o servidor está ativo
app.get('/', (req, res) => {
  res.send('Servidor Dentista Pro está ativo.');
});

/// --- ROTAS DA API ---

// Rota de Teste para verificar se o servidor está ativo
app.get('/', (req, res) => {
  res.send('Servidor Dentista Pro está ativo.');
});

// --- ROTA DE LOGIN DO ADMINISTRADOR (USANDO FIREBASE ADMIN) ---
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  console.log(`Tentativa de Login (Firebase Admin) para: ${email}`);

  // --- IMPORTANTE: LÓGICA DE VERIFICAÇÃO DE SENHA FALTANTE ---
  // Este código SÓ verifica se o usuário existe pelo e-mail e gera um token.
  // Ele não verifica a senha. Para um admin, você deve:
  // 1. Usar um banco de dados privado para a senha. OU
  // 2. Mudar o frontend para usar o signInWithEmailAndPassword e enviar o ID Token para cá.
  // -----------------------------------------------------------

  try {
    // 1. Tenta encontrar o usuário pelo e-mail no Firebase Auth
    const user = await admin.auth().getUserByEmail(email);

    // 2. Cria um Custom Token usando o UID do usuário encontrado
    const customToken = await admin.auth().createCustomToken(user.uid);

    console.log(`Login bem-sucedido para UID: ${user.uid}.`);
    // 3. Devolve o Custom Token para o frontend
    return res.json({ token: customToken });

  } catch (error) {
    let errorMessage = "E-mail ou senha incorretos.";

    // Verifica se o erro é o código de "usuário não encontrado"
    if (error.code === 'auth/user-not-found') {
      errorMessage = "Usuário não encontrado no Firebase Auth.";
    }

    console.warn(`Tentativa de login falhada para ${email}. Erro: ${error.code}`);
    // Credenciais incorretas ou usuário não encontrado
    return res.status(401).json({ error: errorMessage });
  }
});
// --- FIM DA ROTA DE LOGIN ---

// ---------------------
// Nodemailer (gmail)
// ---------------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});
transporter.verify().then(() => console.log('✅ Nodemailer ready')).catch(err => console.warn('⚠️ Nodemailer verify failed:', err && err.message ? err.message : err));

// ---------------------
// WhatsApp client
// ---------------------

// --- NOVO: Variáveis de Estado do WhatsApp ---
let isWhatsAppConnected = false;
let waStatus = 'loading'; // Estados: 'loading', 'qr_code', 'connected', 'disconnected', 'error'
let waQrCodeBase64 = null; // Armazena a string Base64 do QR Code
let clientReady = false; // Mantido para compatibilidade com o código original
// ---------------------------------------------

const waClient = new Client({
  authStrategy: new LocalAuth({ clientId: 'dentista-ia' }),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

// ALTERADO: Adicionado 'qrcode.toDataURL' para gerar Base64 para o frontend
waClient.on('qr', async qr => {
  waStatus = 'qr_code';
  try {
    waQrCodeBase64 = await qrcode.toDataURL(qr); // Gera o Data URL para o frontend
    console.log('🔎 QR Code em Base64 gerado para o frontend.');
    // Usa o qrcode-terminal para mostrar no console, se necessário
    require('qrcode-terminal').generate(qr, { small: true });
    console.log('🔎 Escaneie o QR com WhatsApp Web (veja o QR no terminal)');
  } catch (e) {
    waStatus = 'error';
    console.error('❌ Erro ao gerar QR Code Base64:', e);
  }
});

waClient.on('ready', () => {
  waStatus = 'connected'; // ⬅️ ISSO é o que faz o endpoint retornar TRUE
  clientReady = true;
  waQrCodeBase64 = null; // Limpa o QR após conexão
  console.log('✅ WhatsApp Client está pronto e conectado! waStatus = connected');
});

waClient.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated');
});

waClient.on('auth_failure', e => {
  waStatus = 'error'; // Define status de erro
  console.error('❌ WhatsApp auth_failure', e);
});

waClient.on('disconnected', reason => {
  waStatus = 'disconnected'; // Atualiza o status
  console.log('🔴 WhatsApp disconnected:', reason);
  clientReady = false;
  // Tenta re-inicializar o cliente, o que pode gerar um novo QR Code
  setTimeout(() => waClient.initialize(), 3000);
});

waClient.initialize();

// ---------------------
// Helpers (Telefone, WhatsApp, Sheets)
// ---------------------
function normalizePhone(n) {
  if (!n) return '';
  let s = String(n).replace(/\D/g, '');
  if (s.length === 10 || s.length === 11) s = '55' + s;
  if (!s.startsWith('55')) s = '55' + s;
  return s;
}
async function enviarMensagemWhatsApp(numero, mensagem) {
  try {
    // Usa o novo 'waStatus' para verificação
    if (waStatus !== 'connected') {
      console.warn('⚠️ WhatsApp not connected; skipping message to', numero, 'Current status:', waStatus);
      return false;
    }
    const limpo = normalizePhone(numero);
    if (!limpo) throw new Error('numero inválido');
    await waClient.sendMessage(`${limpo}@c.us`, mensagem);
    console.log('💬 Mensagem enviada para', limpo);
    return true;
  } catch (e) {
    console.error('❌ Erro enviarMensagemWhatsApp:', e && e.message ? e.message : e);
    return false;
  }
}
async function appendRow(values) {
  const clientAuth = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: clientAuth });
  // ALTERADO: Range de A:K para A:L para 12 colunas
  return await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] }, });
}
async function updateCell(rangeA1, values) {
  const clientAuth = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: clientAuth });
  return await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: rangeA1, valueInputOption: 'RAW', requestBody: { values }, });
}
function extractRowFromUpdatedRange(updatedRange) {
  const m = /!(?:[A-Z]+)(\d+):/.exec(updatedRange) || /!(?:[A-Z]+)(\d+)$/.exec(updatedRange);
  if (m && m[1]) return Number(m[1]);
  const m2 = updatedRange.match(/(\d+)(?!.*\d)/);
  return m2 ? Number(m2[1]) : null;
}

// ---------------------
// Calendar Functions
// ---------------------
async function createCalendarEvent(nome, telefone, dataDDMMYYYY, horario) {
  try {
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    const [dia, mes, ano] = String(dataDDMMYYYY).split('/');
    const startISO = new Date(`${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}T${horario}:00`).toISOString();
    const end = new Date(new Date(startISO).getTime() + DURACAO_CONSULTA_MIN * 60000).toISOString();
    const event = { summary: `[CONFIRMADO] Avaliação - ${nome}`, description: `Agendamento confirmado via bot. Telefone: ${telefone}`, start: { dateTime: startISO, timeZone: TIMEZONE }, end: { dateTime: end, timeZone: TIMEZONE }, colorId: 2 };
    const resp = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
    console.log('✅ Calendar event created:', resp.data.id);
    return resp.data.id;
  } catch (e) {
    console.warn('⚠️ Falha ao criar evento no Calendar (não crítico):', e && (e.response?.data || e.message || e));
    return null;
  }
}
async function patchCalendarEvent(eventId, nome, status) {
  try {
    if (!eventId) return null;
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    let colorId; if (status === 'Confirmado') colorId = 2; else if (status === 'Cancelado') colorId = 11; else colorId = 5;
    let summary = `[${status.toUpperCase()}] Avaliação - ${nome}`;
    const resp = await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: eventId, resource: { summary: summary, colorId: colorId }, });
    console.log(`✅ Calendar event ${eventId} patched to ${status}`);
    return resp.data.id;
  } catch (e) {
    console.warn(`⚠️ Falha ao dar patch no Calendar (não crítico) para ${eventId}:`, e.message || e);
    return null;
  }
}
async function deleteCalendarEvent(eventId) {
  try {
    if (!eventId) return false;
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: eventId });
    console.log(`🗑️ Calendar event ${eventId} deleted`);
    return true;
  } catch (e) {
    console.warn(`⚠️ Falha ao deletar evento no Calendar ${eventId}:`, e.message || e);
    return false;
  }
}

// ---------------------
// Sheets Search Functions
// ---------------------
async function buscarAgendamentoPendente(telefone) {
  try {
    const clientAuth = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    // ALTERADO: Range de A:K para A:L
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L`, });
    const rows = response.data.values || [];
    if (rows.length < 2) return null;
    const telefoneLimpo = normalizePhone(telefone);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const status = String(row[6] || '').toLowerCase(); // Índice 6 (G) - Status (Não mudou)
      const telefonePlanilha = normalizePhone(row[2] || '');
      if (status === 'pendente' && telefonePlanilha === telefoneLimpo) {
        // ALTERADO: calendarId mudou de row[7] para row[8]
        return { nome: row[1], telefone: telefonePlanilha, data: row[4], horario: row[5], calendarId: row[8], linha: i + 1, email: row[3] };
      }
    }
    return null;
  } catch (e) { console.error('❌ Error buscarAgendamentoPendente:', e && (e.response?.data || e.message || e)); throw e; }
}
async function buscarAgendamentoAtivo(telefone) {
  try {
    const clientAuth = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    // ALTERADO: Range de A:K para A:L
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L`, });
    const rows = response.data.values || [];
    if (rows.length < 2) return null;
    const telefoneLimpo = normalizePhone(telefone);
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const status = String(row[6] || '').toLowerCase(); // Índice 6 (G) - Status (Não mudou)
      const telefonePlanilha = normalizePhone(row[2] || '');
      if ((status === 'pendente' || status === 'confirmado') && telefonePlanilha === telefoneLimpo) {
        // ALTERADO: calendarId mudou de row[7] para row[8]
        return { nome: row[1], telefone: telefonePlanilha, data: row[4], horario: row[5], calendarId: row[8], linha: i + 1, email: row[3], statusAtual: row[6] };
      }
    }
    return null;
  } catch (e) { console.error('❌ Error buscarAgendamentoAtivo:', e.message || e); throw e; }
}

// ---------------------
// Conversational module (humanized) - adapted from index.html
// ---------------------
const conversationStates = {};

function normalizeForIntent(text) {
  if (!text) return '';
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
  if (!base) base = '';
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

// ---------------------
// WhatsApp message handler (integrações preservadas + novo módulo)
// ---------------------
waClient.on('message', async msg => {
  try {
    const userMessage = msg.body;
    const senderPhone = normalizePhone(msg.from);
    const chat = await msg.getChat();
    const chatType = chat.isGroup ? 'group' : 'private';
    if (chatType !== 'private') return;

    const currentState = conversationStates[senderPhone] || 'IDLE';

    // Mantém os fluxos existentes: checa por agendamento pendente primeiro
    let agendamentoPendente = null;
    try { agendamentoPendente = await buscarAgendamentoPendente(senderPhone); } catch (e) { console.warn('buscarAgendamentoPendente error', e); }

    const isAff = ['sim', 's', 'claro', 'pode', 'confirmo'].includes(String(userMessage || '').toLowerCase().trim());
    const isNeg = ['nao', 'não', 'n', 'depois', 'cancelar', 'cancela', 'agora não', 'agora nao'].includes(String(userMessage || '').toLowerCase().trim());
    const userWantsToCancel = String(userMessage || '').toLowerCase().includes('cancelar');

    // 1) Fluxo de confirmação para agendamento pendente
    if (agendamentoPendente) {
      const { nome, telefone, data, horario, calendarId, linha, email } = agendamentoPendente;
      if (isAff) {
        try {
          const eventId = await createCalendarEvent(nome, telefone, data, horario);
          // ALTERADO: Coluna de Calendar ID de H para I
          if (eventId) { await updateCell(`${SHEET_NAME}!I${linha}`, [[eventId]]); }
          await updateCell(`${SHEET_NAME}!G${linha}`, [['Confirmado']]);
          const msgDentistaConfirmado = `🟢 AGENDAMENTO CONFIRMADO: 🟢\n\nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data}\nHorário: ${horario}`;
          if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaConfirmado);
          await msg.reply(`🎉 *AGENDAMENTO CONFIRMADO!* 🎉\n\nQue ótimo, ${nome}! Seu horário para *${data}* às *${horario}* está CONFIRMADO na agenda da Dra. Marcella. Nos vemos lá!`);
          try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🟢 AGENDAMENTO CONFIRMADO', text: msgDentistaConfirmado }); if (email) { const msgClienteConfirmado = `Seu agendamento em ${data} às ${horario} foi CONFIRMADO com sucesso!`; await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: '✅ Confirmação de Agendamento', text: msgClienteConfirmado }); } } }
          catch (mailErr) { console.warn('⚠️ Falha envio e-mail de CONFIRMAÇÃO:', mailErr && mailErr.message ? mailErr.message : mailErr); }
        } catch (e) { console.error('❌ Erro ao confirmar agendamento:', e && e.message ? e.message : e); await msg.reply('❌ Ocorreu um erro ao confirmar seu agendamento. Tente novamente mais tarde.'); }
        delete conversationStates[senderPhone]; return;
      } else if (isNeg) {
        try { await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]); } catch (e) { console.warn('⚠️ Falha ao marcar Cancelado na planilha:', e && e.message ? e.message : e); }
        const msgDentistaCancelado = `🔴 AGENDAMENTO CANCELADO (pendente): 🔴\n\nPaciente: ${nome}\nTelefone: ${telefone}\nData: ${data}\nHorário: ${horario}`;
        if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaCancelado);
        await msg.reply(`Ok ${nome}, seu agendamento em ${data} às ${horario} foi CANCELADO.`);
        try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🔴 AGENDAMENTO CANCELADO', text: msgDentistaCancelado }); } } catch (mailErr) { console.warn('⚠️ Falha envio e-mail de CANCELAMENTO:', mailErr && mailErr.message ? mailErr.message : mailErr); }
        delete conversationStates[senderPhone]; return;
      }
    }

    // 2) Fluxo de cancelamento a qualquer momento
    if (currentState === 'AWAITING_CANCEL_CONFIRMATION') {
      const agendamentoAtivo = await buscarAgendamentoAtivo(senderPhone);
      if (agendamentoAtivo && isAff) {
        const { nome, telefone, data, horario, calendarId, linha, email } = agendamentoAtivo;
        try {
          await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]);
          // ALTERADO: Coluna de Calendar ID de H para I
          if (calendarId) { await deleteCalendarEvent(calendarId); await updateCell(`${SHEET_NAME}!I${linha}`, [['']]); }
          const msgDentistaCancelado = `🔴 AGENDAMENTO CANCELADO: 🔴\n\nPaciente: ${nome}\nTelefone: ${senderPhone}\nData: ${data}\nHorário: ${horario}`;
          if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentistaCancelado);
          await msg.reply(`✅ Seu agendamento em ${data} às ${horario} foi CANCELADO com sucesso. Para reagendar, envie AGENDAR.`);
          try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: '🔴 AGENDAMENTO CANCELADO', text: msgDentistaCancelado }); } } catch (mailErr) { console.warn('⚠️ Falha envio e-mail de CANCELAMENTO:', mailErr && mailErr.message ? mailErr.message : mailErr); }
        } catch (e) { console.error('❌ Erro ao processar cancelamento ativo:', e && e.message ? e.message : e); await msg.reply('❌ Falha no cancelamento. Tente novamente mais tarde.'); }
        delete conversationStates[senderPhone]; return;
      } else if (isNeg) { await msg.reply('Cancelamento abortado. Em que mais posso ajudar?'); delete conversationStates[senderPhone]; return; }
    }

    // 3) Se usuário digita 'cancelar' fora de contexto
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

    // 4) Mantêm fluxos de link/agendamento pré-existentes (estado AWAITING_LINK)
    if (currentState === 'AWAITING_LINK') {
      if (isAff) { await msg.reply(`Ótimo! Aqui está o link para agilizar seu agendamento online:\n${LINK_AGENDAMENTO}/agendamento.html`); delete conversationStates[senderPhone]; return; }
      if (isNeg) { await msg.reply('Entendi. Posso ajudar em outra coisa?'); delete conversationStates[senderPhone]; return; }
    }

    // 5) Se a mensagem for apenas 'sim'/'não' fora de contexto, damos CTA ou encerramos
    if (isAff || isNeg) {
      await msg.reply('Não entendi exatamente. Posso te ajudar a agendar uma avaliação? Responda SIM para receber o link.');
      conversationStates[senderPhone] = 'AWAITING_LINK';
      return;
    }

    // 6) Fluxo genérico: usa novo módulo humanizado
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
    console.error('❌ erro no handler whatsapp:', e && e.message ? e.message : e);
  }
});

// ---------------------------
// --- NOVO: Endpoint para Status do WhatsApp (Polling) ---
// ---------------------------
app.get('/api/whatsapp/status', (req, res) => {
  // O userId não é usado aqui, pois a sessão é global (para um único bot),
  // mas o frontend o envia por boa prática.

  const responseData = {
    status: waStatus,
    qrCodeBase64: waQrCodeBase64
  };

  if (waStatus === 'qr_code') {
    console.log(`[GET /api/whatsapp/status] Status: ${waStatus}. QR Code ativo.`);
  } else {
    console.log(`[GET /api/whatsapp/status] Status: ${waStatus}`);
  }

  res.json(responseData);
});
// ---------------------------

// ------------------------------------------------------------------
// 🚀 NOVO ENDPOINT: Verificação de PRONTIDÃO para Agendamento
// Este endpoint é consumido pelo formulário de agendamento (frontend)
// ------------------------------------------------------------------
app.get('/api/agendamento/status-whatsapp', (req, res) => {
  // O status 'connected' é o único que permite o agendamento prosseguir.
  const isReadyForBooking = waStatus === 'connected';

  res.json({
    isReady: isReadyForBooking,
    status: waStatus // Incluir o status ajuda no debugging no frontend
  });
});
// ------------------------------------------------------------------

// ---------------------------
// API: disponibilidade (usa Calendar) - bloqueia apenas CONFIRMADOS
// ---------------------------
app.get('/api/disponibilidade', async (req, res) => {
  try {
    const { dia, mes, ano } = req.query;
    if (!dia || !mes || !ano) return res.status(400).json({ error: 'dia, mes e ano são obrigatórios' });
    const clientAuth = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: clientAuth });
    const dateStart = new Date(ano, mes - 1, dia); const dateEnd = new Date(ano, mes - 1, dia); dateEnd.setHours(23, 59, 59, 999);
    const calendarResponse = await calendar.events.list({ calendarId: CALENDAR_ID, timeMin: dateStart.toISOString(), timeMax: dateEnd.toISOString(), singleEvents: true, orderBy: 'startTime' });
    const busy = new Set();
    (calendarResponse.data.items || []).forEach(ev => {
      if (ev.start && ev.start.dateTime) {
        const start = new Date(ev.start.dateTime); const end = new Date(ev.end.dateTime); let cur = new Date(start);
        while (cur.getTime() < end.getTime()) { busy.add(`${String(cur.getHours()).padStart(2, '0')}:${String(cur.getMinutes()).padStart(2, '0')}`); cur.setMinutes(cur.getMinutes() + DURACAO_CONSULTA_MIN); }
      }
    });
    const avail = HORARIOS_ATENDIMENTO_INICIAL.filter(t => !busy.has(t));
    return res.json({ disponiveis: avail });
  } catch (e) { console.error('❌ /api/disponibilidade error:', e && (e.response?.data || e.message || e)); return res.status(500).json({ error: 'Erro ao consultar disponibilidade' }); }
});

// ---------------------------
// API: agendar (CRIA somente o registro PENDENTE — NÃO cria evento no Calendar)
// ---------------------------
app.post('/api/agendar', async (req, res) => {
  try {
    // ALTERADO: Adicionado 'procedimento' no destructuring do body
    const { nome, telefone, email, data_agendamento, horario, procedimento } = req.body;
    if (!nome || !telefone || !email || !data_agendamento || !horario || !procedimento) return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    const id = uuidv4(); const criado_em = new Date().toISOString();
    // ALTERADO: Row agora tem 12 elementos. 'procedimento' é o 8º elemento (Índice 7)
    // [id, nome, telefone, email, data, horario, status, procedimento, calendar_event_id, notificado_cliente, notificado_dentista, criado_em]
    const row = [id, nome, telefone, email, data_agendamento, horario, 'Pendente', procedimento, '', '', '', criado_em];
    const appendResp = await appendRow(row);
    const updatedRange = appendResp.data.updates && appendResp.data.updates.updatedRange; const linha = updatedRange ? extractRowFromUpdatedRange(updatedRange) : null;
    const msgCliente = `⚠️*PRÉ-CONFIRMAÇÃO NECESSÁRIA!*⚠️
Olá ${nome}, sua avaliação está AGENDADA (pré) para ${data_agendamento} às ${horario}. Responda *SIM* por aqui para confirmar.`;
    const msgDentista = `🟡 NOVO AGENDAMENTO PENDENTE
Paciente: ${nome}
Telefone: ${telefone}
Data: ${data_agendamento} 
Horário: ${horario}`;
    await enviarMensagemWhatsApp(telefone, msgCliente);
    if (DENTIST_PHONE) await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentista);
    try { if (process.env.EMAIL_USER && process.env.EMAIL_PASS) { await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Pré-Confirmação de Agendamento', text: msgCliente }); await transporter.sendMail({ from: process.env.EMAIL_USER, to: DENTIST_EMAIL, subject: 'Novo Agendamento Pendente', text: msgDentista }); } else console.warn('⚠️ EMAIL_USER/EMAIL_PASS não configurados - pulando e-mails'); } catch (mailErr) { console.warn('⚠️ Falha envio e-mails (não crítico):', mailErr && (mailErr.message || mailErr)); }
    console.log(`✅ Agendamento PENDENTE criado: ${nome} - linha ${linha || 'desconhecida'}`);
    return res.json({ ok: true, id, linha });
  } catch (e) { console.error('❌ ERRO em /api/agendar:', e && (e.response?.data || e.message || e)); return res.status(500).json({ ok: false, error: 'Falha ao agendar' }); }
});

// ---------------------------
// API: Cancelar Agendamento (Usado pelo Dentista via Dashboard) - agora deleta evento do Calendar
// ---------------------------
app.post('/api/cancelar', async (req, res) => {
  try {
    const { id } = req.body; if (!id) return res.status(400).json({ error: 'ID do agendamento é obrigatório.' });
    const clientAuth = await auth.getClient(); const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    // ALTERADO: Range de A:K para A:L
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L`, });
    const rows = response.data.values || [];
    let linha = null; let agendamentoData = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) {
        linha = i + 1;
        agendamentoData = {
          id: rows[i][0],
          nome: rows[i][1],
          telefone: rows[i][2],
          data: rows[i][4],
          horario: rows[i][5],
          // ALTERADO: calendarId mudou de row[7] para row[8]
          calendarId: rows[i][8],
          statusAtual: rows[i][6]
        };
        break;
      }
    }
    if (!linha) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado na planilha.' });
    if (agendamentoData.statusAtual && agendamentoData.statusAtual.toLowerCase() === 'cancelado') return res.json({ ok: true, message: 'Agendamento já estava Cancelado.' });
    await updateCell(`${SHEET_NAME}!G${linha}`, [['Cancelado']]);
    // ALTERADO: Coluna de Calendar ID de H para I
    if (agendamentoData.calendarId) { await deleteCalendarEvent(agendamentoData.calendarId); await updateCell(`${SHEET_NAME}!I${linha}`, [['']]); }
    const msgClienteCancelado = `⚠️ *CANCELAMENTO EFETUADO* ⚠️

Olá ${agendamentoData.nome}, o seu agendamento para ${agendamentoData.data} às ${agendamentoData.horario} foi **CANCELADO** pela clínica. Para reagendar, entre em contato ou envie AGENDAR.`;
    await enviarMensagemWhatsApp(agendamentoData.telefone, msgClienteCancelado);
    console.log(`❌ Agendamento Cancelado pelo Dentista: ${agendamentoData.nome}`);
    return res.json({ ok: true, message: `Agendamento ${id} cancelado com sucesso.` });
  } catch (e) { console.error('❌ ERRO em /api/cancelar:', e.message || e); return res.status(500).json({ ok: false, error: 'Falha ao cancelar o agendamento via API' }); }
});

// ---------------------------
// ROTA: Buscar agendamentos da planilha (Usado pelo Dashboard)
// ---------------------------
app.get('/api/agendamentos-planilha', async (req, res) => {
  try {
    const clientAuth = await auth.getClient(); const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    // ALTERADO: Range de A:K para A:L
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` });
    const rows = response.data.values;
    if (!rows || rows.length < 2) { return res.json([]); }
    const headers = rows[0].map(h => String(h).trim());
    const agendamentos = rows.slice(1).map(row => { const obj = {}; headers.forEach((header, index) => { obj[header] = row[index] || ""; }); obj.data = obj.data_agendamento || obj.data || ""; return obj; });
    res.json(agendamentos);
  } catch (error) { console.error("🚨 Erro ao acessar a planilha:", error && (error.response?.data || error.message || error)); res.status(500).json({ error: "Erro ao acessar a planilha" }); }
});

// ---------------------------
// REMINDERS: cron interno para lembretes 24h e 2h
// ---------------------------
const REMINDER_INTERVAL_MINUTES = 5; const TOLERANCE_MINUTES = 10;
async function runRemindersJob() {
  try {
    const clientAuth = await auth.getClient(); const sheets = google.sheets({ version: 'v4', auth: clientAuth });
    // CORRETO: Range de A:K para A:L
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:L` });
    const rows = response.data.values || []; if (rows.length < 2) return;
    const now = new Date();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; const linha = i + 1; const id = row[0] || ''; const nome = row[1] || ''; const telefone = row[2] || ''; const email = row[3] || ''; const data_agendamento = row[4] || ''; const horario = row[5] || ''; const status = String(row[6] || '').toLowerCase();

      // ✅ NOVO: Extrair o procedimento, que está em row[7] (Coluna H)
      const procedimento = row[7] || 'sua avaliação'; // Fallback para "sua avaliação"

      // CORRETO: calendarId mudou de row[7] para row[8]
      const calendarId = row[8] || '';
      // CORRETO: notificado_cliente mudou de row[8] para row[9]
      const notificado_cliente = String(row[9] || '').toLowerCase();
      // CORRETO: notificado_dentista mudou de row[9] para row[10]
      const notificado_dentista = String(row[10] || '').toLowerCase();

      if (!id || status !== 'confirmado') continue;
      if (!data_agendamento || !horario) continue;
      const parts = data_agendamento.split('/'); if (parts.length !== 3) continue; const day = Number(parts[0]); const month = Number(parts[1]) - 1; const year = Number(parts[2]); const [hh, mm] = horario.split(':').map(Number); const appointmentDate = new Date(year, month, day, hh, mm, 0);
      const diffMs = appointmentDate.getTime() - now.getTime(); const diffMinutes = Math.round(diffMs / 60000);
      const target24 = 24 * 60; const target2 = 2 * 60;

      // Lembrete 24h
      if (Math.abs(diffMinutes - target24) <= TOLERANCE_MINUTES && notificado_cliente !== '1') {
        // 💬 Mensagem atualizada para incluir o procedimento
        const msgCliente24 = `🔔 Lembrete: Olá ${nome}, seu agendamento para *${procedimento}* é amanhã às ${horario}. Caso precise alterar ou cancelar, responda por aqui.`;
        await enviarMensagemWhatsApp(telefone, msgCliente24);
        if (DENTIST_PHONE) { const msgDentista24 = `🔔 Lembrete 24h: Paciente ${nome} (${procedimento}) - ${data_agendamento} ${horario}`; await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentista24); }
        // CORRETO: Colunas de Notificação mudaram de I e J para J e K
        try { await updateCell(`${SHEET_NAME}!J${linha}`, [['1']]); await updateCell(`${SHEET_NAME}!K${linha}`, [['1']]); } catch (e) { console.warn('⚠️ Falha ao marcar notificado 24h:', e && e.message ? e.message : e); }
        console.log(`⏰ Lembrete 24h enviado para linha ${linha} (${nome})`);
      }

      // Lembrete 2h
      if (Math.abs(diffMinutes - target2) <= TOLERANCE_MINUTES && notificado_cliente !== '2') {
        // 💬 Mensagem atualizada para incluir o procedimento
        const msgCliente2 = `⏰ Lembrete: Olá ${nome}, seu agendamento para *${procedimento}* é HOJE às ${horario}. Estaremos te aguardando!`;
        await enviarMensagemWhatsApp(telefone, msgCliente2);
        if (DENTIST_PHONE) { const msgDentista2 = `⏰ Lembrete 2h: Paciente ${nome} (${procedimento}) - ${data_agendamento} ${horario}`; await enviarMensagemWhatsApp(DENTIST_PHONE, msgDentista2); }
        // CORRETO: Colunas de Notificação mudaram de I e J para J e K
        try { await updateCell(`${SHEET_NAME}!J${linha}`, [['2']]); await updateCell(`${SHEET_NAME}!K${linha}`, [['2']]); } catch (e) { console.warn('⚠️ Falha ao marcar notificado 2h:', e && e.message ? e.message : e); }
        console.log(`⏰ Lembrete 2h enviado para linha ${linha} (${nome})`);
      }
    }
  } catch (e) { console.error('❌ Erro no job de lembretes:', e && e.message ? e.message : e); }
}

setInterval(runRemindersJob, REMINDER_INTERVAL_MINUTES * 60000);
console.log(`⏱️ Job de lembretes configurado para rodar a cada ${REMINDER_INTERVAL_MINUTES} minutos.`);

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse a página de conexão em http://localhost:${PORT}/connect.html`);
});