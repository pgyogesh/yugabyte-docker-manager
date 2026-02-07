import { useCachedPromise } from "@raycast/utils";
import { getClusterServices } from "../utils/docker";
import { ClusterService } from "../types";

/**
 * Hook that loads services for a specific cluster.
 * Automatically reloads when clusterName changes.
 */
export function useClusterServices(clusterName: string | null) {
  const { data, isLoading, revalidate, error } = useCachedPromise(
    async (name: string): Promise<ClusterService[]> => {
      return getClusterServices(name);
    },
    [clusterName ?? ""],
    {
      execute: !!clusterName,
      keepPreviousData: true,
    },
  );

  return {
    services: data ?? [],
    isLoading,
    revalidate,
    error,
  };
}
