import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from 'baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import { MongoClient } from 'mongodb';
import P from 'pino';
import QRCode from 'qrcode';
import { useDbAuthState } from './dbAuthState';
import { HumanMessageQueue } from './humanSend';

const MONGO_URI = process.env.MONGO_URI as string;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // simple shared-secret for your own /send endpoint

if (!MONGO_URI) {
  throw new Error('Set MONGO_URI in your Render environment variables.');
}

const logger = P({ level: 'info' });

let queue: HumanMessageQueue | null = null;
let connectionStatus: 'connecting' | 'open' | 'close' = 'connecting';
// Latest QR string (raw, not yet rendered as an image) - used by the /qr page.
let latestQr: string | null = null;

// The HTTP server is created ONCE and never restarted. Only the WhatsApp
// socket reconnects on its own - this avoids a real bug where re-running
// app.listen() on every reconnect would crash with "address already in use".
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: connectionStatus });
});

// Open this URL in a browser to scan the QR - far more reliable than
// squeezing ASCII art into Render's log panel, and doesn't race an
// expiring pairing code. The page auto-refreshes every 20s so an
// expired QR is replaced with a fresh one automatically.
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

app.post('/send', async (req, res) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { jid, text } = req.body || {};
  if (!jid || !text) {
    return res.status(400).json({ error: 'jid and text are required' });
  }
  if (connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp connection not open yet' });
  }

  try {
    // Enqueued, not sent directly - this is what gives you the typing
    // simulation + randomized delay + spacing between messages.
    queue!.enqueue(jid, text).catch((err: any) => logger.error(err, 'send failed'));
    res.json({ queued: true });
  } catch (err) {
    logger.error(err, 'failed to queue message');
    res.status(500).json({ error: 'failed to queue message' });
  }
});

app.listen(PORT, () => logger.info(`HTTP server listening on ${PORT}`));

async function connectToWhatsApp() {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const sessions = mongo.db('wa-api').collection('sessions');

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

  queue = new HumanMessageQueue(sock, {
    minGapMs: 1500,
    maxGapMs: 6000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      logger.info(`QR ready - open https://<your-render-url>/qr in a browser to scan it.`);
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
        // Reconnect on anything except an explicit logout (e.g. you
        // unlinked the device from your phone). Only the socket restarts -
        // the HTTP server above keeps running the whole time.
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
