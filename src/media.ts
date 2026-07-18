import type { WASocket } from 'baileys';

interface MediaSendOptions {
  jid: string;
  source: string; // http(s) URL or raw base64 string
  caption?: string;
  filename?: string; // documents only
  mimetype?: string; // documents only
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveBuffer(source: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch media from URL: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return Buffer.from(source, 'base64');
}

/** Sends an image with a short "composing" pause first, like uploading a photo. */
export async function sendImage(sock: WASocket, opts: MediaSendOptions) {
  const buffer = await resolveBuffer(opts.source);
  await sock.sendPresenceUpdate('composing', opts.jid);
  await sleep(1000 + Math.random() * 2000);
  return sock.sendMessage(opts.jid, { image: buffer, caption: opts.caption });
}

/** Sends a document (PDF, etc). */
export async function sendDocument(sock: WASocket, opts: MediaSendOptions) {
  const buffer = await resolveBuffer(opts.source);
  await sock.sendPresenceUpdate('composing', opts.jid);
  await sleep(1000 + Math.random() * 2000);
  return sock.sendMessage(opts.jid, {
    document: buffer,
    fileName: opts.filename ?? 'file',
    mimetype: opts.mimetype ?? 'application/octet-stream',
    caption: opts.caption
  });
}

/** Sends a voice note (push-to-talk style), with a "recording" presence pause first. */
export async function sendVoiceNote(sock: WASocket, opts: MediaSendOptions) {
  const buffer = await resolveBuffer(opts.source);
  await sock.sendPresenceUpdate('recording', opts.jid);
  await sleep(1200 + Math.random() * 2500);
  return sock.sendMessage(opts.jid, {
    audio: buffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true
  });
}
