import { Action, ActionPanel, List, showToast, Toast, Icon, open } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  getAllClusters,
  getClusterServices,
  ClusterService,
  ClusterInfo,
} from "./utils/docker";

export default function Command() {
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const [services, setServices] = useState<ClusterService[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  async function loadClusters(showFeedback = false) {
    try {
      setIsLoading(true);
      if (showFeedback) {
        await showToast({
          style: Toast.Style.Animated,
          title: "Loading clusters",
          message: "Fetching cluster list...",
        });
      }
      console.log("[View Services] Loading clusters...");
      const allClusters = await getAllClusters();
      console.log(`[View Services] Found ${allClusters.length} clusters`);
      setClusters(allClusters);
      
      // Auto-select first cluster if available
      if (allClusters.length > 0 && !selectedCluster) {
        setSelectedCluster(allClusters[0].name);
      }
      
      if (showFeedback) {
        await showToast({
          style: Toast.Style.Success,
          title: "Clusters Refreshed",
          message: `Found ${allClusters.length} cluster(s)`,
        });
      }
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error("[View Services] Error loading clusters:", errorMsg);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error loading clusters",
        message: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function loadServices(clusterName: string, showFeedback = false) {
    try {
      setIsLoading(true);
      if (showFeedback) {
        await showToast({
          style: Toast.Style.Animated,
          title: "Loading services",
          message: `Fetching services for "${clusterName}"...`,
        });
      }
      console.log(`[View Services] Loading services for cluster: ${clusterName}`);
      const clusterServices = await getClusterServices(clusterName);
      console.log(`[View Services] Found ${clusterServices.length} nodes with services`);
      setServices(clusterServices);
      
      if (showFeedback) {
        await showToast({
          style: Toast.Style.Success,
          title: "Services Loaded",
          message: `Found ${clusterServices.length} node(s) with services`,
        });
      }
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error(`[View Services] Error loading services for ${clusterName}:`, errorMsg);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error loading services",
        message: errorMsg,
      });
      setServices([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadClusters();
  }, []);

  useEffect(() => {
    if (selectedCluster) {
      loadServices(selectedCluster);
    }
  }, [selectedCluster]);

  function openUI(url: string, serviceName: string) {
    console.log(`[View Services] Opening ${serviceName} UI: ${url}`);
    open(url);
    showToast({
      style: Toast.Style.Success,
      title: "Opening UI",
      message: `Opening ${serviceName} in browser`,
    });
  }

  function getServiceIcon(service: ClusterService["services"][keyof ClusterService["services"]]): Icon {
    return service?.running ? Icon.CircleFilled : Icon.Circle;
  }

  function getServiceStatus(service: ClusterService["services"][keyof ClusterService["services"]]): string {
    return service?.running ? "Running" : "Not Running";
  }

  if (clusters.length === 0 && !isLoading) {
    return (
      <List
        isLoading={isLoading}
        searchBarPlaceholder="Select a cluster..."
        actions={
        <ActionPanel>
          <Action
            icon={Icon.ArrowClockwise}
            title="Refresh Clusters"
            onAction={() => loadClusters(true)}
          />
        </ActionPanel>
        }
      >
        <List.EmptyView
          icon={Icon.Cloud}
          title="No clusters found"
          description="Create a cluster first to view its services"
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search services..."
      searchBarAccessory={
        clusters.length > 0 ? (
          <List.Dropdown
            tooltip="Select Cluster"
            value={selectedCluster || ""}
            onChange={setSelectedCluster}
          >
            {clusters.map((cluster) => (
              <List.Dropdown.Item
                key={cluster.name}
                title={cluster.name}
                value={cluster.name}
              />
            ))}
          </List.Dropdown>
        ) : undefined
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Actions">
            <Action
              icon={Icon.ArrowClockwise}
              title="Refresh Services"
              onAction={() => {
                if (selectedCluster) {
                  loadServices(selectedCluster, true);
                } else {
                  loadClusters(true);
                }
              }}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
            />
            <Action
              icon={Icon.ArrowClockwise}
              title="Refresh Clusters"
              onAction={() => loadClusters(true)}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    >
      {selectedCluster && services.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="No services found"
          description={`No services found for cluster "${selectedCluster}"`}
        />
      ) : (
        services.map((service) => (
          <List.Section
            key={service.containerName}
            title={`Node ${service.nodeNumber} (${service.containerName})`}
          >
            {/* YugabyteDB UI */}
            {service.services.yugabyted && (
              <List.Item
                title="YugabyteDB UI"
                subtitle={`Port ${service.ports.yugabytedUI} • ${getServiceStatus(service.services.yugabyted)}`}
                icon={getServiceIcon(service.services.yugabyted)}
                accessories={[
                  { text: `http://localhost:${service.ports.yugabytedUI}` },
                ]}
                actions={
                  <ActionPanel>
                    <ActionPanel.Section title="Open UI">
                      <Action
                        icon={Icon.Globe}
                        title="Open in Browser"
                        onAction={() => openUI(`http://localhost:${service.ports.yugabytedUI}`, "YugabyteDB UI")}
                        shortcut={{ modifiers: ["cmd"], key: "o" }}
                      />
                    </ActionPanel.Section>
                    <ActionPanel.Section title="Copy">
                      <Action.CopyToClipboard
                        title="Copy URL"
                        content={`http://localhost:${service.ports.yugabytedUI}`}
                        shortcut={{ modifiers: ["cmd"], key: "c" }}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            )}

            {/* Master UI */}
            {service.services.ybMaster && (
              <List.Item
                title="Master Web UI"
                subtitle={`Port ${service.ports.masterUI} • ${getServiceStatus(service.services.ybMaster)}`}
                icon={getServiceIcon(service.services.ybMaster)}
                accessories={[
                  { text: `http://localhost:${service.ports.masterUI}` },
                ]}
                actions={
                  <ActionPanel>
                    <ActionPanel.Section title="Open UI">
                      <Action
                        icon={Icon.Globe}
                        title="Open in Browser"
                        onAction={() => openUI(`http://localhost:${service.ports.masterUI}`, "Master Web UI")}
                        shortcut={{ modifiers: ["cmd"], key: "o" }}
                      />
                    </ActionPanel.Section>
                    <ActionPanel.Section title="Copy">
                      <Action.CopyToClipboard
                        title="Copy URL"
                        content={`http://localhost:${service.ports.masterUI}`}
                        shortcut={{ modifiers: ["cmd"], key: "c" }}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            )}

            {/* TServer UI */}
            {service.services.ybTserver && (
              <List.Item
                title="TServer Web UI"
                subtitle={`Port ${service.ports.tserverUI} • ${getServiceStatus(service.services.ybTserver)}`}
                icon={getServiceIcon(service.services.ybTserver)}
                accessories={[
                  { text: `http://localhost:${service.ports.tserverUI}` },
                ]}
                actions={
                  <ActionPanel>
                    <ActionPanel.Section title="Open UI">
                      <Action
                        icon={Icon.Globe}
                        title="Open in Browser"
                        onAction={() => openUI(`http://localhost:${service.ports.tserverUI}`, "TServer Web UI")}
                        shortcut={{ modifiers: ["cmd"], key: "o" }}
                      />
                    </ActionPanel.Section>
                    <ActionPanel.Section title="Copy">
                      <Action.CopyToClipboard
                        title="Copy URL"
                        content={`http://localhost:${service.ports.tserverUI}`}
                        shortcut={{ modifiers: ["cmd"], key: "c" }}
                      />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            )}

            {/* YSQL Endpoint */}
            <List.Item
              title="YSQL Endpoint"
              subtitle={`PostgreSQL-compatible • Port ${service.ports.ysql}`}
              icon={Icon.Terminal}
              accessories={[
                { text: `localhost:${service.ports.ysql}` },
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="Copy Connection">
                    <Action.CopyToClipboard
                      title="Copy ysqlsh Command"
                      content={`docker exec -it ${service.containerName} bin/ysqlsh -h ${service.containerName} -p ${service.ports.ysql}`}
                      shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                    <Action.CopyToClipboard
                      title="Copy Host:Port"
                      content={`localhost:${service.ports.ysql}`}
                    />
                    <Action.CopyToClipboard
                      title="Copy psql Command (PostgreSQL client)"
                      content={`psql -h localhost -p ${service.ports.ysql} -U yugabyte`}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />

            {/* YCQL Endpoint */}
            <List.Item
              title="YCQL Endpoint"
              subtitle={`Cassandra-compatible • Port ${service.ports.ycql}`}
              icon={Icon.Terminal}
              accessories={[
                { text: `localhost:${service.ports.ycql}` },
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="Copy Connection">
                    <Action.CopyToClipboard
                      title="Copy ycqlsh Command"
                      content={`docker exec -it ${service.containerName} bin/ycqlsh ${service.containerName} ${service.ports.ycql}`}
                      shortcut={{ modifiers: ["cmd"], key: "c" }}
                    />
                    <Action.CopyToClipboard
                      title="Copy Host:Port"
                      content={`localhost:${service.ports.ycql}`}
                    />
                    <Action.CopyToClipboard
                      title="Copy cqlsh Command (Cassandra client)"
                      content={`cqlsh localhost ${service.ports.ycql}`}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          </List.Section>
        ))
      )}
    </List>
  );
}
