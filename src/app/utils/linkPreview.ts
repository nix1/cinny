import { IPreviewUrlResponse, MatrixClient } from 'matrix-js-sdk';

/** `true`: local preview with server fallback; `'local'`: never ask the homeserver. */
export type UrlPreviewMode = boolean | 'local';

type TauriInternals = { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };

const tauri = (): TauriInternals | undefined =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

/** The desktop app can fetch previews itself, without telling the homeserver the link. */
export const hasLocalLinkPreview = (): boolean => typeof tauri()?.invoke === 'function';

export const getUrlPreviewMode = (
  encrypted: boolean,
  urlPreview: boolean,
  encUrlPreview: boolean
): UrlPreviewMode => {
  if (!encrypted) return urlPreview;
  if (encUrlPreview) return true;
  return urlPreview && hasLocalLinkPreview() ? 'local' : false;
};

const localCache = new Map<string, Promise<IPreviewUrlResponse>>();

const getLocalPreview = (url: string): Promise<IPreviewUrlResponse> => {
  let preview = localCache.get(url);
  if (!preview) {
    preview = tauri()!.invoke<IPreviewUrlResponse>('link_preview', { url });
    preview.catch(() => localCache.delete(url));
    localCache.set(url, preview);
  }
  return preview;
};

export const getLinkPreview = async (
  mx: MatrixClient,
  url: string,
  ts: number,
  allowServer: boolean
): Promise<IPreviewUrlResponse> => {
  if (hasLocalLinkPreview()) {
    try {
      return await getLocalPreview(url);
    } catch (e) {
      if (!allowServer) throw e;
    }
  }
  if (!allowServer) throw new Error('Link previews from the homeserver are disabled here');
  return mx.getUrlPreview(url, ts);
};
