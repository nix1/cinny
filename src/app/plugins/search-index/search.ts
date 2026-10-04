import { IndexedMessage, SearchIndexDb } from './db';
import { normalizeText, tokenize } from './text';

export type LocalSearchParams = {
  term: string;
  rooms?: string[];
  senders?: string[];
  /** 'recent' or 'rank' */
  order?: string;
};

/** Upper bound of matches kept per query, to keep memory in check. */
const MAX_MATCHES = 5000;

const countOccurrences = (text: string, needle: string): number => {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
};

export type LocalMatch = { message: IndexedMessage; rank: number };

/**
 * Every query word has to appear in the message (as a substring, diacritics
 * ignored). Candidates come from the token index by word prefix; if that finds
 * nothing, all messages are scanned so words in the middle of other words match too.
 */
export const searchLocal = async (
  db: SearchIndexDb,
  params: LocalSearchParams
): Promise<LocalMatch[]> => {
  const words = tokenize(params.term);
  if (words.length === 0) return [];
  const phrase = normalizeText(params.term).trim();
  const rooms = params.rooms && params.rooms.length > 0 ? new Set(params.rooms) : undefined;
  const senders = params.senders && params.senders.length > 0 ? new Set(params.senders) : undefined;

  const accept = (msg: IndexedMessage): boolean =>
    (!rooms || rooms.has(msg.roomId)) &&
    (!senders || senders.has(msg.sender)) &&
    words.every((w) => msg.text.includes(w));

  const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
  const candidates = await db.getMany(await db.idsByTokenPrefix(longest));
  let matches = candidates.filter(accept);

  if (matches.length === 0) {
    matches = [];
    await db.scan((msg) => {
      if (accept(msg)) matches.push(msg);
      return matches.length < MAX_MATCHES;
    });
  }

  const results = matches.slice(0, MAX_MATCHES).map((message) => ({
    message,
    rank:
      words.reduce((sum, w) => sum + countOccurrences(message.text, w), 0) +
      (words.length > 1 && message.text.includes(phrase) ? 10 : 0),
  }));

  results.sort((a, b) =>
    params.order === 'rank' && a.rank !== b.rank ? b.rank - a.rank : b.message.ts - a.message.ts
  );
  return results;
};
