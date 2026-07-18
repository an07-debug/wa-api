import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  WASocket
} from 'baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import { MongoClient } from 'mongodb';
import P from 'pino';
import QRCode from 'qrcode';
import { useDbAuthState } from './dbAuthState';
import { HumanMessageQueue } from './humanSend';
import { sendImage, sendDocument, sendVoiceNote } from './media';
import { makeMessageStore, MessageStore } from './messageStore';
import { listGroups } from './groups';
import { DASHBOARD_HTML } from './dashboard';

const MONGO_URI = process.env.MONGO_URI as string;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // shared secret protecting all POST endpoints

if (!MONGO_URI) {
  throw new Error('Set MONGO_URI in your Render environment variables.');
}

const logger = P({ level: 'info' });

let queue: HumanMessageQueue | null = null;
let currentSock: WASocket | null = null;
let messageStore: MessageStore | null = null;
let connectionStatus: 'connecting' | 'open' | 'close' = 'connecting';
let latestQr: string | null = null;

function requireAuth(req: express.Request, res: express.Response): boolean {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function requireConnected(res: express.Response): boolean {
  if (connectionStatus !== 'open' || !currentSock) {
    res.status(503).json({ error: 'WhatsApp connection not open yet' });
    return false;
  }
  return true;
}

// --- HTTP server: created once, never restarted ---------------------------
const app = express();
app.use(express.json({ limit: '15mb' })); // room for base64 media in request bodies

app.get('/health', (_req, res) => {
  res.json({ status: connectionStatus });
});

// The dashboard: browse chats/groups, read messages, send text - all
// from a normal webpage instead of curl. API key is entered once and
// saved in this browser's localStorage.
app.get('/', (_req, res) => {
  res.send(DASHBOARD_HTML);
});

// Scan this in a browser - far more reliable than terminal ASCII art.
app.get('/qr', async (_req, res) => {
  if (connectionStatus === 'open') {
    return res.send('<h2>Already connected - no QR needed.</h2>');
  }
  if (!latestQr) {
    return res.send('<h2>Waiting for QR to generate... refreshing in 3s.</h2><script>setTimeout(()=>location.reload(),3000)</script>');
  }
  const dataUrl = await QRCode.toDataURL(latestQr, { width: 320 });
  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="20"></head>
      <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;">
        <h2>Scan with WhatsApp &gt; Linked Devices &gt; Link a Device</h2>
        <img src="${dataUrl}" width="320" height="320" />
        <p>This page refreshes every 20s to keep the QR current.</p>
      </body>
    </html>
  `);
});

// Send a text message - queued through the human-like typing simulation.
app.post('/send', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { jid, text } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: 'jid and text are required' });
  if (!requireConnected(res)) return;

  queue!.enqueue(jid, text).catch((err: any) => logger.error(err, 'send failed'));
  res.json({ queued: true });
});

// Send media: image, document, or voice note.
// body: { jid, type: 'image' | 'document' | 'audio', source: <url or base64>, caption?, filename?, mimetype? }
app.post('/send-media', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { jid, type, source, caption, filename, mimetype } = req.body || {};
  if (!jid || !type || !source) {
    return res.status(400).json({ error: 'jid, type, and source are required' });
  }
  if (!requireConnected(res)) return;

  try {
    let result;
    if (type === 'image') result = await sendImage(currentSock!, { jid, source, caption });
    else if (type === 'document') result = await sendDocument(currentSock!, { jid, source, caption, filename, mimetype });
    else if (type === 'audio') result = await sendVoiceNote(currentSock!, { jid, source });
    else return res.status(400).json({ error: "type must be 'image', 'document', or 'audio'" });

    res.json({ sent: true, id: result?.key?.id });
  } catch (err: any) {
    logger.error(err, 'media send failed');
    res.status(500).json({ error: err.message || 'media send failed' });
  }
});

// List recent chats (distinct jids) with a preview of the last message.
app.get('/chats', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!messageStore) return res.status(503).json({ error: 'not ready yet' });

  const chats = await messageStore.listChats(50);
  res.json({ chats });
});

// Fetch recent stored messages for a chat (personal-use inbox read).
app.get('/messages', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const jid = req.query.jid as string;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  if (!jid) return res.status(400).json({ error: 'jid query param is required' });
  if (!messageStore) return res.status(503).json({ error: 'not ready yet' });

  const msgs = await messageStore.list(jid, limit);
  res.json({ messages: msgs });
});

// Explicitly mark a message as read (auto-read with a delay already happens
// on incoming messages - this is for cases you want to control it manually).
app.post('/read', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { jid, messageId, fromMe } = req.body || {};
  if (!jid || !messageId) return res.status(400).json({ error: 'jid and messageId are required' });
  if (!requireConnected(res)) return;

  await currentSock!.readMessages([{ remoteJid: jid, id: messageId, fromMe: !!fromMe }]);
  res.json({ read: true });
});

// List groups the account is in.
app.get('/groups', async (_req, res) => {
  if (!requireAuth(_req, res)) return;
  if (!requireConnected(res)) return;

  const groups = await listGroups(currentSock!);
  res.json({ groups });
});

// Toggle presence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'.
// jid is optional for available/unavailable (broadcasts your overall online state);
// required for composing/recording/paused (per-chat typing/recording indicator).
app.post('/presence', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { jid, state } = req.body || {};
  const validStates = ['available', 'unavailable', 'composing', 'recording', 'paused'];
  if (!validStates.includes(state)) {
    return res.status(400).json({ error: `state must be one of ${validStates.join(', ')}` });
  }
  if (!requireConnected(res)) return;

  await currentSock!.sendPresenceUpdate(state, jid);
  res.json({ updated: true });
});

app.listen(PORT, () => logger.info(`HTTP server listening on ${PORT}`));

// --- WhatsApp connection: restarts itself on disconnect --------------------
async function connectToWhatsApp() {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const db = mongo.db('wa-api');
  const sessions = db.collection('sessions');
  messageStore = makeMessageStore(db.collection('messages'));

  const { state, saveCreds } = await useDbAuthState(sessions);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('WA-API'),
    // Keep this false so the linked device shows a normal "last seen" pattern
    // instead of appearing always-online, which looks bot-like.
    markOnlineOnConnect: false,
    printQRInTerminal: false
  });

  currentSock = sock;
  queue = new HumanMessageQueue(sock, { minGapMs: 1500, maxGapMs: 6000 });

  sock.ev.on('creds.update', saveCreds);

  // Incoming messages: store text + media, and auto-mark-read after a
  // randomized human-like delay (instant read receipts are a bot signal).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || !msg.key.remoteJid) continue;

      const jid = msg.key.remoteJid;
      const fromMe = !!msg.key.fromMe;
      const msgType = Object.keys(msg.message)[0];

      let text: string | undefined;
      let mediaBase64: string | undefined;
      let mediaMimetype: string | undefined;

      if (msg.message.conversation) {
        text = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        text = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage || msg.message.documentMessage || msg.message.audioMessage) {
        try {
          const buffer = (await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          )) as Buffer;
          mediaBase64 = buffer.toString('base64');
          mediaMimetype =
            msg.message.imageMessage?.mimetype ||
            msg.message.documentMessage?.mimetype ||
            msg.message.audioMessage?.mimetype ||
            undefined;
          text = msg.message.imageMessage?.caption || msg.message.documentMessage?.caption || undefined;
        } catch (err) {
          logger.error(err, 'failed to download incoming media');
        }
      }

      await messageStore?.save({
        jid,
        messageId: msg.key.id || '',
        fromMe,
        type: msgType,
        text,
        mediaBase64,
        mediaMimetype,
        timestamp: Number(msg.messageTimestamp) * 1000 || Date.now()
      });

      if (!fromMe) {
        const delay = 2000 + Math.random() * 6000;
        setTimeout(() => {
          sock.readMessages([msg.key]).catch(() => {});
        }, delay);
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      logger.info('QR ready - open https://<your-render-url>/qr in a browser to scan it.');
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      latestQr = null;
      logger.info('WhatsApp connection open');
    }

    if (connection === 'close') {
      connectionStatus = 'close';
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn({ statusCode, loggedOut }, 'Connection closed');

      if (!loggedOut) {
        setTimeout(connectToWhatsApp, 2000);
      } else {
        logger.error('Logged out - delete the session doc in MongoDB and restart to get a fresh QR.');
      }
    }
  });
}

connectToWhatsApp().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
