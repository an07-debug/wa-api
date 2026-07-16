import type { WASocket } from 'baileys';

/** Random integer between min and max inclusive. */
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Simple sleep helper. */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HumanSendOptions {
  /** Minimum ms to "compose" before sending, on top of the typing-speed estimate. Default 800. */
  minTypingMs?: number;
  /** Extra random jitter ceiling added on top of the typing estimate. Default 2500. */
  jitterMs?: number;
  /** Roughly how many ms per character a human "types" - keeps long messages feeling real. Default 35. */
  msPerChar?: number;
  /** Hard cap on the typing delay so a huge message doesn't stall the queue for a minute. Default 6000. */
  maxTypingMs?: number;
}

/**
 * Sends a text message the way a human would: shows "typing...", waits a
 * length-proportional + randomized delay, then sends. This is the single
 * highest-value anti-ban behavior for a personal bot - instant, robotic-
 * timed replies are one of the strongest signals WhatsApp's detection
 * uses against unofficial clients.
 */
export async function sendWithTyping(
  sock: WASocket,
  jid: string,
  text: string,
  opts: HumanSendOptions = {}
) {
  const {
    minTypingMs = 800,
    jitterMs = 2500,
    msPerChar = 35,
    maxTypingMs = 6000
  } = opts;

  // Let the recipient see you're "online" and about to type.
  await sock.presenceSubscribe(jid).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid);

  const lengthBasedDelay = Math.min(text.length * msPerChar, maxTypingMs);
  const delay = minTypingMs + lengthBasedDelay + randInt(0, jitterMs);

  await sleep(delay);

  // Briefly show "paused" before the message lands, like a real send.
  await sock.sendPresenceUpdate('paused', jid);

  return sock.sendMessage(jid, { text });
}

/**
 * A tiny in-memory queue that serializes all outgoing messages through
 * sendWithTyping and adds a randomized gap BETWEEN messages too, so a
 * burst of sends doesn't come out back-to-back regardless of typing time.
 * Good enough for personal/single-user volume; swap for a real queue
 * (BullMQ etc.) if you outgrow it.
 */
export class HumanMessageQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(
    private sock: WASocket,
    private opts: HumanSendOptions & { minGapMs?: number; maxGapMs?: number } = {}
  ) {}

  enqueue(jid: string, text: string) {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await sendWithTyping(this.sock, jid, text, this.opts);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length) {
      const job = this.queue.shift()!;
      await job();

      if (this.queue.length) {
        const gap = randInt(this.opts.minGapMs ?? 1500, this.opts.maxGapMs ?? 6000);
        await sleep(gap);
      }
    }

    this.running = false;
  }
}
