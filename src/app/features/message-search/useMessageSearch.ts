import {
  IEventWithRoomId,
  IResultContext,
  ISearchRequestBody,
  ISearchResult,
  SearchOrderBy,
} from 'matrix-js-sdk';
import { useCallback, useRef } from 'react';
import { getSearchIndexer, LocalMatch, searchLocal } from '../../plugins/search-index';
import { useMatrixClient } from '../../hooks/useMatrixClient';

export type ResultItem = {
  rank: number;
  event: IEventWithRoomId;
  context: IResultContext;
};

export type ResultGroup = {
  roomId: string;
  items: ResultItem[];
};

export type SearchResult = {
  nextToken?: string;
  highlights: string[];
  groups: ResultGroup[];
};

const groupSearchResult = (results: ISearchResult[]): ResultGroup[] => {
  const groups: ResultGroup[] = [];

  results.forEach((item) => {
    const roomId = item.result.room_id;
    const resultItem: ResultItem = {
      rank: item.rank,
      event: item.result,
      context: item.context,
    };

    const lastAddedGroup: ResultGroup | undefined = groups[groups.length - 1];
    if (lastAddedGroup && roomId === lastAddedGroup.roomId) {
      lastAddedGroup.items.push(resultItem);
      return;
    }
    groups.push({
      roomId,
      items: [resultItem],
    });
  });

  return groups;
};

export type MessageSearchParams = {
  term?: string;
  order?: string;
  rooms?: string[];
  senders?: string[];
};
const LOCAL_PREFIX = 'l:';
const SERVER_PREFIX = 's:';
const PAGE_SIZE = 20;

const localMatchesToResults = (matches: LocalMatch[]): ISearchResult[] =>
  matches.map(({ message, rank }) => ({
    rank,
    result: message.event,
    context: { events_before: [], events_after: [] } as unknown as IResultContext,
  }));

/**
 * Searches the local index first (it covers encrypted rooms), then pages
 * through server results, skipping events the local index already returned.
 */
export const useMessageSearch = (params: MessageSearchParams) => {
  const mx = useMatrixClient();
  const { term, order, rooms, senders } = params;
  const localMatchesRef = useRef<{ key: string; matches: LocalMatch[] }>();

  const searchServer = useCallback(
    async (nextBatch: string | undefined, seen: Set<string>): Promise<SearchResult> => {
      const requestBody: ISearchRequestBody = {
        search_categories: {
          room_events: {
            event_context: {
              before_limit: 0,
              after_limit: 0,
              include_profile: false,
            },
            filter: {
              limit: PAGE_SIZE,
              rooms,
              senders,
            },
            include_state: false,
            order_by: order as SearchOrderBy.Recent,
            search_term: term,
          },
        },
      };

      const r = await mx.search({
        body: requestBody,
        next_batch: nextBatch || undefined,
      });
      const roomEvents = r.search_categories.room_events;
      const results = (roomEvents?.results ?? []).filter((item) => !seen.has(item.result.event_id));
      return {
        nextToken: roomEvents?.next_batch ? `${SERVER_PREFIX}${roomEvents.next_batch}` : undefined,
        highlights: roomEvents?.highlights ?? [],
        groups: groupSearchResult(results),
      };
    },
    [mx, term, order, rooms, senders]
  );

  const searchMessages = useCallback(
    async (nextBatch?: string): Promise<SearchResult> => {
      if (!term)
        return {
          highlights: [],
          groups: [],
        };

      const indexer = getSearchIndexer();
      if (!indexer) {
        const serverToken = nextBatch?.startsWith(SERVER_PREFIX)
          ? nextBatch.slice(SERVER_PREFIX.length)
          : undefined;
        return searchServer(serverToken, new Set());
      }

      const key = JSON.stringify([term, order, rooms, senders]);
      if (localMatchesRef.current?.key !== key || !nextBatch) {
        const matches = await searchLocal(indexer.db, { term, order, rooms, senders });
        localMatchesRef.current = { key, matches };
      }
      const { matches } = localMatchesRef.current;
      const seen = new Set(matches.map((m) => m.message.eventId));

      if (nextBatch?.startsWith(SERVER_PREFIX)) {
        try {
          return await searchServer(nextBatch.slice(SERVER_PREFIX.length), seen);
        } catch {
          return { highlights: [], groups: [] };
        }
      }

      const offset = nextBatch?.startsWith(LOCAL_PREFIX)
        ? Number(nextBatch.slice(LOCAL_PREFIX.length))
        : 0;
      const page = matches.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + PAGE_SIZE;
      return {
        nextToken: nextOffset < matches.length ? `${LOCAL_PREFIX}${nextOffset}` : SERVER_PREFIX,
        highlights: term.split(/\s+/).filter(Boolean),
        groups: groupSearchResult(localMatchesToResults(page)),
      };
    },
    [term, order, rooms, senders, searchServer]
  );

  return searchMessages;
};
