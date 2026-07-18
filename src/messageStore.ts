import { Collection } from 'mongodb';

export interface StoredMessage {
  jid: string;
  messageId: string;
  fromMe: boolean;
  type: string;
  text?: string;
  mediaBase64?: string;
  mediaMimetype?: string;
  timestamp: number;
}

export function makeMessageStore(collection: Collection) {
  return {
    async save(msg: StoredMessage) {
      await collection.insertOne(msg as any);
    },
    async list(jid: string, limit = 20) {
      return collection
        .find({ jid })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    },
    /** Distinct chats (by jid) with a preview of the last message, most recent first. */
    async listChats(limit = 50) {
      return collection
        .aggregate([
          { $sort: { timestamp: -1 } },
          {
            $group: {
              _id: '$jid',
              lastTimestamp: { $first: '$timestamp' },
              lastText: { $first: '$text' },
              lastType: { $first: '$type' }
            }
          },
          { $sort: { lastTimestamp: -1 } },
          { $limit: limit }
        ])
        .toArray();
    }
  };
}

export type MessageStore = ReturnType<typeof makeMessageStore>;
