import { MatrixClient, MatrixEvent, ReceiptType } from 'matrix-js-sdk';

/**
 * @param unthreaded send an unthreaded receipt, which also clears unread thread replies.
 * Use it for explicit "mark as read" actions; the timeline auto-read keeps threads unread.
 */
export async function markAsRead(
  mx: MatrixClient,
  roomId: string,
  privateReceipt: boolean,
  unthreaded = false
) {
  const room = mx.getRoom(roomId);
  if (!room) return;

  const timeline = room.getLiveTimeline().getEvents();
  const readEventId = room.getEventReadUpTo(mx.getUserId()!);

  const getLatestValidEvent = () => {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const latestEvent = timeline[i];
      if (latestEvent.getId() === readEventId) return null;
      if (!latestEvent.isSending()) return latestEvent;
    }
    return null;
  };

  const getLatestEventInRoom = (): MatrixEvent | null => {
    let latest: MatrixEvent | null = null;
    const consider = (evt: MatrixEvent | undefined | null) => {
      if (!evt || evt.isSending()) return;
      if (!latest || evt.getTs() > latest.getTs()) latest = evt;
    };
    consider(timeline[timeline.length - 1]);
    room.getThreads().forEach((thread) => {
      consider(thread.replyToEvent ?? thread.rootEvent);
    });
    return latest;
  };

  if (unthreaded) {
    if (!room.hasThreadUnreadNotification() && timeline.length === 0) return;
    const latestEvent = getLatestEventInRoom();
    if (!latestEvent) return;
    await mx.sendReadReceipt(
      latestEvent,
      privateReceipt ? ReceiptType.ReadPrivate : ReceiptType.Read,
      true
    );
    return;
  }

  if (timeline.length === 0) return;
  const latestEvent = getLatestValidEvent();
  if (latestEvent === null) return;

  await mx.sendReadReceipt(
    latestEvent,
    privateReceipt ? ReceiptType.ReadPrivate : ReceiptType.Read
  );
}
