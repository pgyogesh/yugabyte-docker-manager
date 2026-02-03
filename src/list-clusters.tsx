import { Action, ActionPanel, List, showToast, Toast, Icon } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  getAllClusters,
  startCluster,
  stopCluster,
  deleteClusterContainers,
  getClusterStatus,
  ClusterInfo,
} from "./utils/docker";

export default function Command() {
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  async function loadClusters() {
    try {
      setIsLoading(true);
      console.log("[List Clusters] Loading clusters...");
      const allClusters = await getAllClusters();
      console.log(`[List Clusters] Found ${allClusters.length} clusters`);
      
      // Update status for each cluster
      const clustersWithStatus = await Promise.all(
        allClusters.map(async (cluster) => {
          try {
            const status = await getClusterStatus(cluster.name);
            return { ...cluster, status };
          } catch (error: any) {
            console.error(`[List Clusters] Error getting status for ${cluster.name}:`, error.message || error);
            return { ...cluster, status: "stopped" as const };
          }
        })
      );
      
      setClusters(clustersWithStatus);
      console.log("[List Clusters] Successfully loaded clusters");
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error("[List Clusters] Error loading clusters:", errorMsg);
      console.error("[List Clusters] Full error:", error);
      console.error("[List Clusters] Stack trace:", error.stack);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error loading clusters",
        message: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadClusters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleStartCluster(cluster: ClusterInfo) {
    try {
      console.log(`[List Clusters] Starting cluster: ${cluster.name}`);
      await showToast({
        style: Toast.Style.Animated,
        title: "Starting cluster",
        message: `Starting "${cluster.name}"...`,
      });
      await startCluster(cluster.name);
      console.log(`[List Clusters] Successfully started cluster: ${cluster.name}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster started",
        message: `Cluster "${cluster.name}" started successfully`,
      });
      await loadClusters();
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error(`[List Clusters] Error starting cluster ${cluster.name}:`, errorMsg);
      console.error("[List Clusters] Full error:", error);
      console.error("[List Clusters] Stack trace:", error.stack);
      if (error.stdout) console.error("[List Clusters] Docker stdout:", error.stdout);
      if (error.stderr) console.error("[List Clusters] Docker stderr:", error.stderr);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error starting cluster",
        message: errorMsg,
      });
    }
  }

  async function handleStopCluster(cluster: ClusterInfo) {
    try {
      console.log(`[List Clusters] Stopping cluster: ${cluster.name}`);
      await showToast({
        style: Toast.Style.Animated,
        title: "Stopping cluster",
        message: `Stopping "${cluster.name}"...`,
      });
      await stopCluster(cluster.name);
      console.log(`[List Clusters] Successfully stopped cluster: ${cluster.name}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster stopped",
        message: `Cluster "${cluster.name}" stopped successfully`,
      });
      await loadClusters();
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error(`[List Clusters] Error stopping cluster ${cluster.name}:`, errorMsg);
      console.error("[List Clusters] Full error:", error);
      console.error("[List Clusters] Stack trace:", error.stack);
      if (error.stdout) console.error("[List Clusters] Docker stdout:", error.stdout);
      if (error.stderr) console.error("[List Clusters] Docker stderr:", error.stderr);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error stopping cluster",
        message: errorMsg,
      });
    }
  }

  async function handleDeleteCluster(cluster: ClusterInfo) {
    try {
      console.log(`[List Clusters] Deleting cluster: ${cluster.name}`);
      await showToast({
        style: Toast.Style.Animated,
        title: "Deleting cluster",
        message: `Deleting "${cluster.name}"...`,
      });
      await deleteClusterContainers(cluster.name);
      console.log(`[List Clusters] Successfully deleted cluster: ${cluster.name}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster deleted",
        message: `Cluster "${cluster.name}" deleted successfully`,
      });
      await loadClusters();
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error(`[List Clusters] Error deleting cluster ${cluster.name}:`, errorMsg);
      console.error("[List Clusters] Full error:", error);
      console.error("[List Clusters] Stack trace:", error.stack);
      if (error.stdout) console.error("[List Clusters] Docker stdout:", error.stdout);
      if (error.stderr) console.error("[List Clusters] Docker stderr:", error.stderr);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error deleting cluster",
        message: errorMsg,
      });
    }
  }

  return (
    <List isLoading={isLoading}>
      {clusters.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.Cloud}
          title="No clusters found"
          description="Create a cluster to get started"
        />
      ) : (
        clusters.map((cluster) => (
          <List.Item
            key={cluster.name}
            title={cluster.name}
            subtitle={`${cluster.nodes} nodes • Version ${cluster.version}`}
            accessories={[
              {
                text: cluster.status === "running" ? "Running" : "Stopped",
                icon: cluster.status === "running" ? Icon.CircleFilled : Icon.Circle,
              },
            ]}
            actions={
              <ActionPanel>
                {cluster.status === "stopped" ? (
                  <Action
                    icon={Icon.Play}
                    title="Start Cluster"
                    onAction={() => handleStartCluster(cluster)}
                  />
                ) : (
                  <Action
                    icon={Icon.Stop}
                    title="Stop Cluster"
                    onAction={() => handleStopCluster(cluster)}
                  />
                )}
                <Action
                  icon={Icon.Trash}
                  title="Delete Cluster"
                  style={Action.Style.Destructive}
                  onAction={() => handleDeleteCluster(cluster)}
                />
                <Action
                  icon={Icon.ArrowClockwise}
                  title="Refresh"
                  onAction={loadClusters}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
