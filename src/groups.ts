import type { WASocket } from 'baileys';

export async function listGroups(sock: WASocket) {
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map((g: any) => ({
    id: g.id,
    subject: g.subject,
    participants: g.participants?.length ?? 0
  }));
}
