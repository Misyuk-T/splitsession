import { browser } from "wxt/browser";

import type { FullApi } from "../background/full-api";
import type { ApiReply } from "../core";

/** Calls the background API from an extension page. Rejects with the background's error message. */
export async function callApi<M extends keyof FullApi>(
  method: M,
  ...args: Parameters<FullApi[M]>
): Promise<Awaited<ReturnType<FullApi[M]>>> {
  const reply = (await browser.runtime.sendMessage({
    type: "facet/api",
    method,
    args,
  })) as ApiReply | undefined;
  if (!reply) throw new Error("no reply from the SplitSession background");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as Awaited<ReturnType<FullApi[M]>>;
}

/** Typed proxy: `facetApi.createContainer({name: 'alt'})`. */
export const facetApi = new Proxy({} as FullApi, {
  get:
    (_target, method: string) =>
    (...args: unknown[]) =>
      callApi(method as keyof FullApi, ...(args as never)),
});
