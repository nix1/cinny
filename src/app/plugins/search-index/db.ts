import { IEventWithRoomId } from 'matrix-js-sdk';

export type IndexedMessage = {
  eventId: string;
  roomId: string;
  sender: string;
  ts: number;
  /** Normalized searchable text. */
  text: string;
  tokens: string[];
  /** Cleartext event, as the search results renderer expects it. */
  event: IEventWithRoomId;
};

export type RoomCrawlState = {
  roomId: string;
  /** Backwards pagination token to continue from. */
  token?: string;
  done: boolean;
  /** Time up to which the newest messages of the room are indexed. */
  syncedAt?: number;
};

export type PendingEvent = {
  eventId: string;
  roomId: string;
  raw: Record<string, unknown>;
};

export type StoredEdit = {
  /** The edited (original) event id. */
  eventId: string;
  ts: number;
  newContent: Record<string, unknown>;
};

const DB_VERSION = 1;
export const MESSAGES = 'messages';
export const CRAWL = 'crawl';
export const PENDING = 'pending';
export const EDITS = 'edits';

export const getSearchIndexDbName = (userId: string) => `cinny-search-index:${userId}`;

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('error', () => reject(tx.error));
    tx.addEventListener('abort', () => reject(tx.error));
  });

export class SearchIndexDb {
  private db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static open(userId: string): Promise<SearchIndexDb> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(getSearchIndexDbName(userId), DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const messages = db.createObjectStore(MESSAGES, { keyPath: 'eventId' });
        messages.createIndex('tokens', 'tokens', { multiEntry: true });
        messages.createIndex('ts', 'ts');
        db.createObjectStore(CRAWL, { keyPath: 'roomId' });
        db.createObjectStore(PENDING, { keyPath: 'eventId' });
        db.createObjectStore(EDITS, { keyPath: 'eventId' });
      };
      req.onsuccess = () => resolve(new SearchIndexDb(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  static delete(userId: string): Promise<void> {
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(getSearchIndexDbName(userId));
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }

  close() {
    this.db.close();
  }

  async put<T>(store: string, values: T[]): Promise<void> {
    if (values.length === 0) return;
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    values.forEach((v) => os.put(v));
    await txDone(tx);
  }

  async remove(store: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    keys.forEach((k) => os.delete(k));
    await txDone(tx);
  }

  get<T>(store: string, key: string): Promise<T | undefined> {
    return promisify(this.db.transaction(store).objectStore(store).get(key));
  }

  getAll<T>(store: string): Promise<T[]> {
    return promisify(this.db.transaction(store).objectStore(store).getAll());
  }

  count(store: string): Promise<number> {
    return promisify(this.db.transaction(store).objectStore(store).count());
  }

  /** Event ids of messages having a token starting with `prefix`. */
  async idsByTokenPrefix(prefix: string): Promise<string[]> {
    const index = this.db.transaction(MESSAGES).objectStore(MESSAGES).index('tokens');
    const keys = await promisify(index.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
    return Array.from(new Set(keys as string[]));
  }

  async getMany(ids: string[]): Promise<IndexedMessage[]> {
    const os = this.db.transaction(MESSAGES).objectStore(MESSAGES);
    const found = await Promise.all(ids.map((id) => promisify(os.get(id))));
    return found.filter((m): m is IndexedMessage => !!m);
  }

  /** Visit every message; return false from `visit` to stop. */
  scan(visit: (msg: IndexedMessage) => boolean | void): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(MESSAGES).objectStore(MESSAGES).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (visit(cursor.value as IndexedMessage) === false) {
          resolve();
          return;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
}
