import { useEffect, useState } from 'react';
import { MatrixClient } from 'matrix-js-sdk';
import { SearchIndexDb } from './db';
import { SearchIndexer, SearchIndexStatus } from './SearchIndexer';

export * from './search';
export type { SearchIndexStatus } from './SearchIndexer';

let indexer: SearchIndexer | undefined;
/** Bumped on every start/stop, so a start that lost a race does not install its indexer. */
let generation = 0;
const startListeners = new Set<() => void>();

export const getSearchIndexer = (): SearchIndexer | undefined => indexer;

export const startSearchIndexer = async (mx: MatrixClient): Promise<SearchIndexer | undefined> => {
  if (indexer && indexer.mx === mx) return indexer;
  indexer?.stop();
  indexer = undefined;
  generation += 1;
  const myGeneration = generation;

  const db = await SearchIndexDb.open(mx.getSafeUserId());
  if (myGeneration !== generation) {
    db.close();
    return undefined;
  }
  indexer = new SearchIndexer(mx, db);
  await indexer.start();
  startListeners.forEach((l) => l());
  return indexer;
};

export const stopSearchIndexer = () => {
  generation += 1;
  indexer?.stop();
  indexer = undefined;
};

/** Drop the local index, e.g. on logout. */
export const deleteSearchIndex = async (userId: string) => {
  stopSearchIndexer();
  await SearchIndexDb.delete(userId);
};

export const useSearchIndexStatus = (): SearchIndexStatus | undefined => {
  const [status, setStatus] = useState(indexer?.getStatus());

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const bind = () => {
      unsubscribe?.();
      if (!indexer) return;
      setStatus(indexer.getStatus());
      unsubscribe = indexer.subscribe(setStatus);
    };
    bind();
    startListeners.add(bind);
    return () => {
      startListeners.delete(bind);
      unsubscribe?.();
    };
  }, []);

  return status;
};
