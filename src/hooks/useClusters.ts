import { useCachedPromise } from "@raycast/utils";
import { showToast, Toast } from "@raycast/api";
import {
  getAllClusters,
  getClusterStatus,
  startCluster as startClusterCmd,
  stopCluster as stopClusterCmd,
  deleteClusterContainers,
  scaleCluster as scaleClusterCmd,
} from "../utils/docker";
import { ClusterInfo } from "../types";

/**
 * Hook that loads all clusters with their live status.
 * Uses `useCachedPromise` from @raycast/utils for automatic loading state,
 * caching between command opens, and easy revalidation.
 */
export function useClusters() {
  const { data, isLoading, revalidate, error } = useCachedPromise(
    async (): Promise<ClusterInfo[]> => {
      const all = await getAllClusters();
      const withStatus = await Promise.all(
        all.map(async (cluster) => {
          try {
            const status = await getClusterStatus(cluster.name);
            return { ...cluster, status };
          } catch {
            return { ...cluster, status: "stopped" as const };
          }
        }),
      );
      return withStatus;
    },
    [],
    { keepPreviousData: true },
  );

  async function startCluster(cluster: ClusterInfo) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Starting Cluster",
        message: `Starting "${cluster.name}"...`,
      });
      await startClusterCmd(cluster.name);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Started",
        message: `"${cluster.name}" is now running`,
      });
      revalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Failed to Start Cluster", message: msg });
    }
  }

  async function stopCluster(cluster: ClusterInfo) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Stopping Cluster",
        message: `Stopping "${cluster.name}"...`,
      });
      await stopClusterCmd(cluster.name);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Stopped",
        message: `"${cluster.name}" has been stopped`,
      });
      revalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Failed to Stop Cluster", message: msg });
    }
  }

  async function restartCluster(cluster: ClusterInfo) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Restarting Cluster",
        message: `Restarting "${cluster.name}"...`,
      });
      await stopClusterCmd(cluster.name);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await startClusterCmd(cluster.name);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Restarted",
        message: `"${cluster.name}" is running again`,
      });
      revalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Failed to Restart Cluster", message: msg });
    }
  }

  async function deleteCluster(cluster: ClusterInfo) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Deleting Cluster",
        message: `Deleting "${cluster.name}"...`,
      });
      await deleteClusterContainers(cluster.name);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Deleted",
        message: `"${cluster.name}" has been removed`,
      });
      revalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Failed to Delete Cluster", message: msg });
    }
  }

  async function scaleCluster(clusterName: string, targetNodes: number) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Scaling Cluster",
        message: `Scaling "${clusterName}" to ${targetNodes} nodes...`,
      });
      await scaleClusterCmd(clusterName, targetNodes);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Scaled",
        message: `"${clusterName}" now has ${targetNodes} nodes`,
      });
      revalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Failed to Scale Cluster", message: msg });
    }
  }

  return {
    clusters: data ?? [],
    isLoading,
    revalidate,
    error,
    startCluster,
    stopCluster,
    restartCluster,
    deleteCluster,
    scaleCluster,
  };
}
