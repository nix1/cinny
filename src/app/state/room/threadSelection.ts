import { atom } from 'jotai';

/**
 * The currently-selected thread id for the open room, shared between the main
 * timeline (thread summaries) and the ThreadsDrawer so that clicking a thread
 * summary in the timeline can open that same thread inside the panel.
 *
 * Only one room is open at a time (RoomTimeline / ThreadsDrawer are both keyed
 * by roomId), so a single module atom is sufficient; it is reset on room leave.
 * Holds `{ roomId, threadId }` (or undefined) to avoid stale cross-room reads.
 */
export type ThreadSelection = { roomId: string; threadId: string };

export const selectedThreadAtom = atom<ThreadSelection | undefined>(undefined);

/**
 * Whether the threads panel is shown in place of the members drawer.
 * Session-only, so the persisted `isPeopleDrawer` setting is never overwritten.
 */
export const threadsPanelAtom = atom<boolean>(false);
