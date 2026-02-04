import { Action, ActionPanel, List, showToast, Toast, Icon, open, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  getAllClusters,
  startCluster,
  stopCluster,
  deleteClusterContainers,
  getClusterStatus,
  getClusterServices,
  scaleCluster,
  ClusterInfo,
} from "./utils/docker";
import ViewClusterServices from "./view-cluster-services";

export default function Command() {
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { push } = useNavigation();

  async function loadClusters(showFeedback = false) {
    try {
      setIsLoading(true);
      if (showFeedback) {
        await showToast({
          style: Toast.Style.Animated,
          title: "Refreshing clusters",
          message: "Updating cluster list and status...",
        });
      }
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
      
      if (showFeedback) {
        const runningCount = clustersWithStatus.filter(c => c.status === "running").length;
        await showToast({
          style: Toast.Style.Success,
          title: "Clusters Refreshed",
          message: `${clustersWithStatus.length} cluster(s) found, ${runningCount} running`,
        });
      }
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
                <ActionPanel.Section title="Cluster Control">
                  {cluster.status === "stopped" ? (
                    <Action
                      icon={Icon.Play}
                      title="Start Cluster"
                      onAction={() => handleStartCluster(cluster)}
                      shortcut={{ modifiers: ["cmd"], key: "s" }}
                    />
                  ) : (
                    <>
                      <Action
                        icon={Icon.Stop}
                        title="Stop Cluster"
                        onAction={() => handleStopCluster(cluster)}
                        shortcut={{ modifiers: ["cmd"], key: "s" }}
                      />
                      <Action
                        icon={Icon.ArrowClockwise}
                        title="Restart Cluster"
                        onAction={async () => {
                          await handleStopCluster(cluster);
                          await new Promise((resolve) => setTimeout(resolve, 2000));
                          await handleStartCluster(cluster);
                        }}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                      />
                    </>
                  )}
                </ActionPanel.Section>

                {cluster.status === "running" && (
                  <ActionPanel.Section title="Access UIs">
                    <Action
                      icon={Icon.Globe}
                      title="Open YugabyteDB UI"
                      onAction={async () => {
                        try {
                          const services = await getClusterServices(cluster.name);
                          if (services.length > 0 && services[0].ports.yugabytedUI) {
                            open(`http://localhost:${services[0].ports.yugabytedUI}`);
                            showToast({
                              style: Toast.Style.Success,
                              title: "Opening YugabyteDB UI",
                              message: `Node 1 UI opened in browser`,
                            });
                          } else {
                            showToast({
                              style: Toast.Style.Failure,
                              title: "UI not available",
                              message: "Cluster services may not be running",
                            });
                          }
                        } catch (error: any) {
                          showToast({
                            style: Toast.Style.Failure,
                            title: "Error",
                            message: error.message || "Could not open UI",
                          });
                        }
                      }}
                      shortcut={{ modifiers: ["cmd"], key: "u" }}
                    />
                    <Action
                      icon={Icon.Gear}
                      title="Open Master UI (Node 1)"
                      onAction={async () => {
                        try {
                          const services = await getClusterServices(cluster.name);
                          if (services.length > 0 && services[0].ports.masterUI) {
                            open(`http://localhost:${services[0].ports.masterUI}`);
                            showToast({
                              style: Toast.Style.Success,
                              title: "Opening Master UI",
                              message: `Node 1 Master UI opened in browser`,
                            });
                          } else {
                            showToast({
                              style: Toast.Style.Failure,
                              title: "UI not available",
                              message: "Master UI port not found",
                            });
                          }
                        } catch (error: any) {
                          showToast({
                            style: Toast.Style.Failure,
                            title: "Error",
                            message: error.message || "Could not open Master UI",
                          });
                        }
                      }}
                      shortcut={{ modifiers: ["cmd"], key: "m" }}
                    />
                    <Action
                      icon={Icon.Terminal}
                      title="Open TServer UI (Node 1)"
                      onAction={async () => {
                        try {
                          const services = await getClusterServices(cluster.name);
                          if (services.length > 0 && services[0].ports.tserverUI) {
                            open(`http://localhost:${services[0].ports.tserverUI}`);
                            showToast({
                              style: Toast.Style.Success,
                              title: "Opening TServer UI",
                              message: `Node 1 TServer UI opened in browser`,
                            });
                          } else {
                            showToast({
                              style: Toast.Style.Failure,
                              title: "UI not available",
                              message: "TServer UI port not found",
                            });
                          }
                        } catch (error: any) {
                          showToast({
                            style: Toast.Style.Failure,
                            title: "Error",
                            message: error.message || "Could not open TServer UI",
                          });
                        }
                      }}
                      shortcut={{ modifiers: ["cmd"], key: "t" }}
                    />
                    <Action
                      icon={Icon.Eye}
                      title="View All Services & UIs"
                      onAction={() => push(<ViewClusterServices initialClusterName={cluster.name} />)}
                      shortcut={{ modifiers: ["cmd"], key: "v" }}
                    />
                  </ActionPanel.Section>
                )}

                {cluster.status === "running" && (
                  <ActionPanel.Section title="Database Connections">
                    <Action
                      icon={Icon.Terminal}
                      title="Connect to YSQL (Node 1)"
                      onAction={async () => {
                        try {
                          const services = await getClusterServices(cluster.name);
                          if (services.length > 0) {
                            const firstNode = services[0];
                            const containerName = firstNode.containerName;
                            const { exec } = await import("child_process");
                            const { promisify } = await import("util");
                            const execAsync = promisify(exec);
                            
                            // Open terminal with ysqlsh connection
                            await execAsync(`osascript -e 'tell application "Terminal" to do script "docker exec -it ${containerName} bin/ysqlsh -h ${containerName}"'`);
                            
                            showToast({
                              style: Toast.Style.Success,
                              title: "Opening YSQL Connection",
                              message: `Connecting to ${containerName}...`,
                            });
                          } else {
                            showToast({
                              style: Toast.Style.Failure,
                              title: "Connection Failed",
                              message: "No nodes found for this cluster",
                            });
                          }
                        } catch (error: any) {
                          showToast({
                            style: Toast.Style.Failure,
                            title: "Error",
                            message: error.message || "Could not connect to YSQL",
                          });
                        }
                      }}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
                    />
                    <Action
                      icon={Icon.Terminal}
                      title="Connect to YCQL (Node 1)"
                      onAction={async () => {
                        try {
                          const services = await getClusterServices(cluster.name);
                          if (services.length > 0) {
                            const firstNode = services[0];
                            const containerName = firstNode.containerName;
                            const { exec } = await import("child_process");
                            const { promisify } = await import("util");
                            const execAsync = promisify(exec);
                            
                            // Open terminal with ycqlsh connection
                            await execAsync(`osascript -e 'tell application "Terminal" to do script "docker exec -it ${containerName} bin/ycqlsh ${containerName}"'`);
                            
                            showToast({
                              style: Toast.Style.Success,
                              title: "Opening YCQL Connection",
                              message: `Connecting to ${containerName}...`,
                            });
                          } else {
                            showToast({
                              style: Toast.Style.Failure,
                              title: "Connection Failed",
                              message: "No nodes found for this cluster",
                            });
                          }
                        } catch (error: any) {
                          showToast({
                            style: Toast.Style.Failure,
                            title: "Error",
                            message: error.message || "Could not connect to YCQL",
                          });
                        }
                      }}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                    />
                  </ActionPanel.Section>
                )}

                {cluster.status === "running" && (
                  <ActionPanel.Section title="Cluster Management">
                    <Action
                      icon={Icon.PlusMinusDivideMultiply}
                      title="Scale Cluster"
                      onAction={async () => {
                        const { Form } = await import("@raycast/api");
                        const scaleForm = (
                          <Form
                            actions={
                              <ActionPanel>
                                <Action.SubmitForm
                                  icon={Icon.Checkmark}
                                  title="Scale Cluster"
                                  onSubmit={async (values: { nodes: string }) => {
                                    try {
                                      const targetNodes = parseInt(values.nodes, 10);
                                      if (isNaN(targetNodes) || targetNodes < 1 || targetNodes > 10) {
                                        await showToast({
                                          style: Toast.Style.Failure,
                                          title: "Invalid node count",
                                          message: "Please enter a number between 1 and 10",
                                        });
                                        return;
                                      }

                                      await showToast({
                                        style: Toast.Style.Animated,
                                        title: "Scaling cluster",
                                        message: `Scaling "${cluster.name}" to ${targetNodes} nodes...`,
                                      });

                                      await scaleCluster(cluster.name, targetNodes);
                                      
                                      await showToast({
                                        style: Toast.Style.Success,
                                        title: "Cluster Scaled",
                                        message: `Cluster "${cluster.name}" scaled to ${targetNodes} nodes`,
                                      });
                                      
                                      await loadClusters();
                                    } catch (error: any) {
                                      await showToast({
                                        style: Toast.Style.Failure,
                                        title: "Error scaling cluster",
                                        message: error.message || "Unknown error occurred",
                                      });
                                    }
                                  }}
                                />
                              </ActionPanel>
                            }
                          >
                            <Form.Description
                              title="Current Nodes"
                              text={`${cluster.nodes} nodes`}
                            />
                            <Form.TextField
                              id="nodes"
                              title="Target Number of Nodes"
                              placeholder={`${cluster.nodes}`}
                              defaultValue={`${cluster.nodes}`}
                              info="Enter the target number of nodes (1-10). The cluster will be scaled up or down accordingly."
                            />
                          </Form>
                        );
                        push(scaleForm);
                      }}
                      shortcut={{ modifiers: ["cmd"], key: "n" }}
                    />
                  </ActionPanel.Section>
                )}

                <ActionPanel.Section title="Actions">
                  <Action
                    icon={Icon.ArrowClockwise}
                    title="Refresh List"
                    onAction={() => loadClusters(true)}
                    shortcut={{ modifiers: ["cmd"], key: "r" }}
                  />
                  <Action
                    icon={Icon.Trash}
                    title="Delete Cluster"
                    style={Action.Style.Destructive}
                    onAction={() => handleDeleteCluster(cluster)}
                    shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
