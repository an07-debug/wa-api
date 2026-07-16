import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from 'baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import { MongoClient } from 'mongodb';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import { useDbAuthState } from './dbAuthState';
import { HumanMessageQueue } from './humanSend';

const MONGO_URI = process.env.MONGO_URI as string;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // simple shared-secret for your own endpoint

if (!MONGO_URI) {
  throw new Error('Set MONGO_URI in your Render environment variables.');
}

const logger = P({ level: 'info' });

let queue: HumanMessageQueue | null = null;
let connectionStatus: 'connecting' | 'open' | 'close' = 'connecting';

async function start() {
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
      // Scan this once; after that, DB-persisted creds keep you logged in
      // across Render restarts/redeploys.
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      logger.info('WhatsApp connection open');
    }

    if (connection === 'close') {
      connectionStatus = 'close';
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn({ statusCode, loggedOut }, 'Connection closed');

      if (!loggedOut) {
        // Reconnect on anything except an explicit logout (e.g. you
        // unlinked the device from your phone).
        setTimeout(start, 2000);
      } else {
        logger.error('Logged out - delete the session doc in MongoDB and re-scan the QR to relink.');
      }
    }
  });

  // --- Minimal HTTP API -----------------------------------------------
  const app = express();
  app.use(express.json());

  // Hit this from an uptime pinger (UptimeRobot / cron-job.org) every
  // 5-10 min so Render's free tier doesn't spin the service down and
  // kill the WhatsApp socket.
  app.get('/health', (_req, res) => {
    res.json({ status: connectionStatus });
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
      queue!.enqueue(jid, text).catch((err) => logger.error(err, 'send failed'));
      res.json({ queued: true });
    } catch (err) {
      logger.error(err, 'failed to queue message');
      res.status(500).json({ error: 'failed to queue message' });
    }
  });

  app.listen(PORT, () => logger.info(`HTTP server listening on ${PORT}`));
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
