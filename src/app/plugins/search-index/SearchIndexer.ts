import {
  Direction,
  EventStatus,
  IEventWithRoomId,
  KnownMembership,
  MatrixClient,
  MatrixError,
  MatrixEvent,
  MatrixEventEvent,
  MatrixEventHandlerMap,
  RelationType,
  RoomEvent,
  RoomEventHandlerMap,
} from 'matrix-js-sdk';
import {
  CRAWL,
  EDITS,
  IndexedMessage,
  MESSAGES,
  PENDING,
  PendingEvent,
  RoomCrawlState,
  SearchIndexDb,
  StoredEdit,
} from './db';
import { normalizeText, tokenize } from './text';

export type SearchIndexStatus = {
  running: boolean;
  messages: number;
  roomsDone: number;
  roomsTotal: number;
};

const PAGE_LIMIT = 100;
/** Pages fetched per room before moving to the next room. */
const PAGES_PER_TURN = 3;
const PAGE_DELAY_MS = 300;
/** How far back a catch-up crawl goes looking for already indexed events. */
const CATCHUP_MAX_PAGES = 20;
/** Undecryptable events are retried periodically, keys can arrive later (backup, key sharing). */
const PENDING_RETRY_MS = 10 * 60 * 1000;

const INDEXED_TYPES = ['m.room.message', 'm.sticker'];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type Listener = (status: SearchIndexStatus) => void;

const toMessage = (mEvent: MatrixEvent): IndexedMessage | undefined => {
  const content = mEvent.getContent();
  const body = typeof content.body === 'string' ? content.body : undefined;
  const eventId = mEvent.getId();
  const roomId = mEvent.getRoomId();
  if (!body || !eventId || !roomId) return undefined;

  return {
    eventId,
    roomId,
    sender: mEvent.getSender() ?? '',
    ts: mEvent.getTs(),
    text: normalizeText(body),
    tokens: tokenize(body),
    event: { ...mEvent.getEffectiveEvent(), room_id: roomId } as IEventWithRoomId,
  };
};

/**
 * Keeps a local full-text index of every joined room, including encrypted ones,
 * because server-side search cannot see E2EE message content.
 */
export class SearchIndexer {
  readonly mx: MatrixClient;

  readonly db: SearchIndexDb;

  private stopped = false;

  private retryTimer?: ReturnType<typeof setInterval>;

  private status: SearchIndexStatus = { running: false, messages: 0, roomsDone: 0, roomsTotal: 0 };

  private listeners = new Set<Listener>();

  constructor(mx: MatrixClient, db: SearchIndexDb) {
    this.mx = mx;
    this.db = db;
  }

  getStatus() {
    return this.status;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(partial: Partial<SearchIndexStatus>) {
    this.status = { ...this.status, ...partial };
    this.listeners.forEach((l) => l(this.status));
  }

  async start() {
    this.mx.on(RoomEvent.Timeline, this.handleTimeline);
    this.mx.on(RoomEvent.LocalEchoUpdated, this.handleLocalEcho);
    this.mx.on(RoomEvent.Redaction, this.handleRedaction);
    this.mx.on(MatrixEventEvent.Decrypted, this.handleDecrypted);

    this.setStatus({ messages: await this.db.count(MESSAGES) });
    await this.retryPending();
    this.retryTimer = setInterval(() => {
      this.retryPending().catch(() => undefined);
    }, PENDING_RETRY_MS);
    this.crawl().catch(() => {
      // Database closed on stop, or the client went away.
      this.setStatus({ running: false });
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.retryTimer);
    this.mx.removeListener(RoomEvent.Timeline, this.handleTimeline);
    this.mx.removeListener(RoomEvent.LocalEchoUpdated, this.handleLocalEcho);
    this.mx.removeListener(RoomEvent.Redaction, this.handleRedaction);
    this.mx.removeListener(MatrixEventEvent.Decrypted, this.handleDecrypted);
    this.db.close();
  }

  private handleTimeline: RoomEventHandlerMap[RoomEvent.Timeline] = (mEvent) => {
    if (mEvent.isEncrypted() && (mEvent.isBeingDecrypted() || !mEvent.getClearContent())) {
      // handleDecrypted indexes it once the keys are there.
      return;
    }
    this.indexEvents([mEvent]).catch(() => undefined);
  };

  private handleLocalEcho: RoomEventHandlerMap[RoomEvent.LocalEchoUpdated] = (mEvent) => {
    if (mEvent.status === null || mEvent.status === EventStatus.SENT) {
      this.indexEvents([mEvent]).catch(() => undefined);
    }
  };

  private handleRedaction: RoomEventHandlerMap[RoomEvent.Redaction] = (redaction) => {
    this.indexEvents([redaction]).catch(() => undefined);
  };

  private handleDecrypted: MatrixEventHandlerMap[MatrixEventEvent.Decrypted] = (mEvent, err) => {
    if (err || mEvent.isDecryptionFailure()) return;
    this.indexEvents([mEvent]).catch(() => undefined);
  };

  /** Index events; returns how many of them were already in the index. */
  async indexEvents(events: MatrixEvent[]): Promise<number> {
    const messages: IndexedMessage[] = [];
    const removed: string[] = [];
    const pending: PendingEvent[] = [];
    const resolved: string[] = [];
    const edits: StoredEdit[] = [];

    const usable = events.filter((e) => !!e.getId() && !!e.getRoomId() && e.status === null);
    const existing = await this.db.getMany(usable.map((e) => e.getId() as string));
    const known = existing.length;

    usable.forEach((mEvent) => {
      const eventId = mEvent.getId() as string;
      const roomId = mEvent.getRoomId() as string;

      if (mEvent.isEncrypted() && mEvent.isDecryptionFailure()) {
        pending.push({
          eventId,
          roomId,
          raw: mEvent.getEffectiveEvent() as Record<string, unknown>,
        });
        return;
      }
      if (mEvent.isEncrypted()) resolved.push(eventId);

      const type = mEvent.getType();
      if (type === 'm.room.redaction') {
        const redacts = mEvent.event.redacts ?? mEvent.getContent().redacts;
        if (typeof redacts === 'string') removed.push(redacts);
        return;
      }
      if (mEvent.isRedacted()) {
        removed.push(eventId);
        return;
      }
      if (!INDEXED_TYPES.includes(type)) return;

      const content = mEvent.getContent();
      const relation = content['m.relates_to'];
      if (relation?.rel_type === RelationType.Replace && relation.event_id) {
        const newContent = content['m.new_content'];
        if (newContent && typeof newContent === 'object') {
          edits.push({ eventId: relation.event_id, ts: mEvent.getTs(), newContent });
        }
        return;
      }

      const msg = toMessage(mEvent);
      if (msg) messages.push(msg);
    });

    const added = messages.length;
    const toStore = await this.applyEdits(messages, edits);
    await this.db.put(MESSAGES, toStore);
    await this.db.remove(MESSAGES, removed);
    await this.db.put(PENDING, pending);
    await this.db.remove(PENDING, resolved);

    if (added > 0 || removed.length > 0) {
      this.setStatus({
        messages: Math.max(0, this.status.messages + added - known - removed.length),
      });
    }
    return known;
  }

  /** Returns the messages with their latest edit applied, plus already indexed messages that got edited. */
  private async applyEdits(
    messages: IndexedMessage[],
    newEdits: StoredEdit[]
  ): Promise<IndexedMessage[]> {
    const latestEdits = new Map<string, StoredEdit>();
    const keepLatest = (edit: StoredEdit | undefined) => {
      if (!edit) return;
      const current = latestEdits.get(edit.eventId);
      if (!current || current.ts < edit.ts) latestEdits.set(edit.eventId, edit);
    };

    const editedIds = new Set([
      ...messages.map((m) => m.eventId),
      ...newEdits.map((e) => e.eventId),
    ]);
    const stored = await Promise.all(
      Array.from(editedIds).map((id) => this.db.get<StoredEdit>(EDITS, id))
    );
    stored.forEach(keepLatest);
    newEdits.forEach(keepLatest);
    await this.db.put(
      EDITS,
      newEdits.filter((e) => latestEdits.get(e.eventId) === e)
    );

    // Edits whose original is already indexed but not part of this batch.
    const batchIds = new Set(messages.map((m) => m.eventId));
    const outside = await this.db.getMany(
      newEdits.map((e) => e.eventId).filter((id) => !batchIds.has(id))
    );

    return [...messages, ...outside].map((msg) => {
      const edit = latestEdits.get(msg.eventId);
      const body = edit?.newContent.body;
      if (!edit || typeof body !== 'string') return msg;
      return {
        ...msg,
        text: normalizeText(body),
        tokens: tokenize(body),
        event: {
          ...msg.event,
          content: { ...msg.event.content, 'm.new_content': edit.newContent },
        },
      };
    });
  }

  private async decrypt(raw: Record<string, unknown>): Promise<MatrixEvent> {
    const mEvent = new MatrixEvent(raw);
    if (mEvent.isEncrypted()) {
      await this.mx.decryptEventIfNeeded(mEvent);
    }
    return mEvent;
  }

  private async retryPending() {
    const pending = await this.db.getAll<PendingEvent>(PENDING);
    const events = await Promise.all(pending.map((p) => this.decrypt(p.raw)));
    await this.indexEvents(events.filter((e) => !e.isDecryptionFailure()));
  }

  private async fetchPage(roomId: string, token: string | null) {
    for (;;) {
      if (this.stopped) return undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.mx.createMessagesRequest(roomId, token, PAGE_LIMIT, Direction.Backward);
      } catch (err) {
        if (err instanceof MatrixError && err.errcode === 'M_LIMIT_EXCEEDED') {
          // eslint-disable-next-line no-await-in-loop
          await sleep(Number(err.data.retry_after_ms) || 5000);
        } else {
          throw err;
        }
      }
    }
  }

  /** Fetch and index one page; returns the next token or undefined at the start of the room. */
  private async crawlPage(
    roomId: string,
    token: string | null
  ): Promise<{ next?: string; known: number; oldestTs?: number }> {
    const page = await this.fetchPage(roomId, token);
    if (!page || page.chunk.length === 0) return { known: 0 };
    const events = await Promise.all(
      page.chunk.map((raw) => this.decrypt({ ...raw, room_id: roomId }))
    );
    const known = await this.indexEvents(events);
    const oldestTs = Math.min(...events.map((e) => e.getTs()));
    return { next: page.end, known, oldestTs };
  }

  /**
   * Index the newest messages down to the last catch-up. Live sync can skip
   * messages (limited sync), so known events alone do not prove there is no gap.
   */
  private async catchUpRoom(state: RoomCrawlState) {
    const startedAt = Date.now();
    const syncedAt = state.syncedAt ?? 0;
    let token: string | null = null;
    for (let i = 0; i < CATCHUP_MAX_PAGES && !this.stopped; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page: { next?: string; oldestTs?: number } | undefined = await this.crawlPage(
        state.roomId,
        token
      ).catch(() => undefined);
      if (!page?.next || (page.oldestTs !== undefined && page.oldestTs <= syncedAt)) break;
      token = page.next;
      // eslint-disable-next-line no-await-in-loop
      await sleep(PAGE_DELAY_MS);
    }
    await this.db.put(CRAWL, [{ ...state, syncedAt: startedAt }]);
  }

  private async crawl() {
    this.setStatus({ running: true });
    const states = new Map((await this.db.getAll<RoomCrawlState>(CRAWL)).map((s) => [s.roomId, s]));
    const rooms = this.mx
      .getRooms()
      .filter((r) => r.getMyMembership() === KnownMembership.Join && !r.isSpaceRoom());

    // Catch up on messages missed while the app was closed.
    const seenRooms = rooms.flatMap((r) => states.get(r.roomId) ?? []);
    for (let i = 0; i < seenRooms.length && !this.stopped; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await this.catchUpRoom(seenRooms[i]);
    }
    if (this.stopped) return;

    const queue = rooms.filter((r) => !states.get(r.roomId)?.done).map((r) => r.roomId);
    const roomsTotal = rooms.length;
    this.setStatus({ roomsTotal, roomsDone: roomsTotal - queue.length });

    // Round-robin backfill, a few pages per room at a time.
    while (queue.length > 0 && !this.stopped) {
      const roomId = queue.shift() as string;
      const state: RoomCrawlState = states.get(roomId) ?? {
        roomId,
        done: false,
        syncedAt: Date.now(),
      };
      for (let i = 0; i < PAGES_PER_TURN && !state.done; i += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { next } = await this.crawlPage(roomId, state.token ?? null);
          state.token = next;
          state.done = !next;
        } catch {
          // Forbidden history, left room, etc. Do not retry forever.
          state.done = true;
        }
        if (this.stopped) return;
        // eslint-disable-next-line no-await-in-loop
        await this.db.put(CRAWL, [state]);
        states.set(roomId, state);
        // eslint-disable-next-line no-await-in-loop
        await sleep(PAGE_DELAY_MS);
      }
      if (state.done) {
        this.setStatus({ roomsDone: this.status.roomsDone + 1 });
      } else {
        queue.push(roomId);
      }
    }
    this.setStatus({ running: false });
  }
}
