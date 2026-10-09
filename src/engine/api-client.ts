import { browser } from 'wxt/browser';
import type { ApiReply } from '../core';
import type { FacetApi } from '../background/api';

/** Calls the background API from an extension page. Rejects with the background's error message. */
export async function callApi<M extends keyof FacetApi>(method: M, ...args: Parameters<FacetApi[M]>): Promise<Awaited<ReturnType<FacetApi[M]>>> {
  const reply = (await browser.runtime.sendMessage({ type: 'facet/api', method, args })) as ApiReply | undefined;
  if (!reply) throw new Error('no reply from the Facet background');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as Awaited<ReturnType<FacetApi[M]>>;
}

/** Typed proxy: `facetApi.createContainer({name: 'alt'})`. */
export const facetApi = new Proxy({} as FacetApi, {
  get: (_target, method: string) => (...args: unknown[]) => callApi(method as keyof FacetApi, ...(args as never)),
});
