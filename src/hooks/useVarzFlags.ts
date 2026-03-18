import { useCachedPromise } from "@raycast/utils";
import { fetchVarzFlags, VarzFlag } from "../utils/docker";

/**
 * Fetches the list of all GFlags from the cluster's varz endpoint.
 * When serverType is "both", fetches from master (port 7000) and
 * tserver (port 9000) separately and merges the results.
 * Returns an empty array if the cluster is stopped or the fetch fails.
 */
export function useVarzFlags(clusterName: string, serverType: "master" | "tserver" | "both") {
  const { data, isLoading, error } = useCachedPromise(
    async (cluster: string, type: "master" | "tserver" | "both") => {
      try {
        if (type === "both") {
          const [masterFlags, tserverFlags] = await Promise.all([
            fetchVarzFlags(cluster, "master").catch(() => [] as VarzFlag[]),
            fetchVarzFlags(cluster, "tserver").catch(() => [] as VarzFlag[]),
          ]);
          const merged = new Map<string, VarzFlag>();
          for (const f of masterFlags) {
            merged.set(f.name, f);
          }
          for (const f of tserverFlags) {
            merged.set(f.name, f);
          }
          return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
        }
        return await fetchVarzFlags(cluster, type);
      } catch {
        return [] as VarzFlag[];
      }
    },
    [clusterName, serverType],
    { keepPreviousData: true },
  );

  return {
    flags: data ?? [],
    isLoading,
    error,
  };
}
