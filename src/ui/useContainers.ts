import { useCallback, useEffect, useState } from "preact/hooks";

import type { ContainerInfo } from "../background/facet";
import { facetApi } from "../engine/api-client";
import { describeError } from "./format";

/** The container list (with tab counts) from the background, plus `reload`. */
export function useContainers(): {
  containers: ContainerInfo[] | null;
  error: string | null;
  reload(): Promise<void>;
} {
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setContainers(await facetApi.listContainers());
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { containers, error, reload };
}
