import { Action, ActionPanel, List, Icon, Color, showToast, Toast } from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { useClusters } from "./hooks/useClusters";
import { useClusterServices } from "./hooks/useClusterServices";
import { openInTerminal } from "./utils/terminal";
import { ClusterService } from "./types";

interface ViewClusterServicesProps {
  initialClusterName?: string;
}

export default function Command({ initialClusterName }: ViewClusterServicesProps = {}) {
  const { clusters, isLoading: isLoadingClusters } = useClusters();
  const [selectedCluster, setSelectedCluster] = useState<string | null>(initialClusterName ?? null);
  const { services, isLoading: isLoadingServices, revalidate } = useClusterServices(selectedCluster);

  // Auto-select first cluster if none selected
  useEffect(() => {
    if (!selectedCluster && clusters.length > 0) {
      setSelectedCluster(clusters[0].name);
    }
  }, [clusters, selectedCluster]);

  const isLoading = isLoadingClusters || isLoadingServices;

  if (clusters.length === 0 && !isLoadingClusters) {
    return (
      <List isLoading={isLoading} searchBarPlaceholder="Select a cluster...">
        <List.EmptyView
          icon={Icon.HardDrive}
          title="No Clusters Found"
          description="Create a cluster first to view its services."
          actions={
            <ActionPanel>
              <Action icon={Icon.ArrowClockwise} title="Refresh" onAction={revalidate} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      navigationTitle="Cluster Services"
      searchBarPlaceholder="Search nodes..."
      searchBarAccessory={
        clusters.length > 0 ? (
          <List.Dropdown tooltip="Select Cluster" value={selectedCluster || ""} onChange={setSelectedCluster}>
            {clusters.map((cluster) => (
              <List.Dropdown.Item key={cluster.name} title={cluster.name} value={cluster.name} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
    >
      {selectedCluster && services.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="No Services Found"
          description={`No services found for cluster "${selectedCluster}". The cluster may be stopped.`}
          actions={
            <ActionPanel>
              <Action
                icon={Icon.ArrowClockwise}
                title="Refresh"
                onAction={revalidate}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      ) : (
        services.map((service) => (
          <NodeServiceItem
            key={service.containerName}
            service={service}
            clusterName={selectedCluster ?? ""}
            onRefresh={revalidate}
          />
        ))
      )}
    </List>
  );
}

// ---------------------------------------------------------------------------
// Node list item with detail pane
// ---------------------------------------------------------------------------

function NodeServiceItem({
  service,
  clusterName,
  onRefresh,
}: {
  service: ClusterService;
  clusterName: string;
  onRefresh: () => void;
}) {
  const allRunning =
    service.services.yugabyted?.running && service.services.ybMaster?.running && service.services.ybTserver?.running;
  const anyRunning =
    service.services.yugabyted?.running || service.services.ybMaster?.running || service.services.ybTserver?.running;

  const statusColor = allRunning ? Color.Green : anyRunning ? Color.Orange : Color.SecondaryText;
  const statusText = allRunning ? "Healthy" : anyRunning ? "Degraded" : "Stopped";

  const ysqlDockerCmd = `docker exec -it ${service.containerName} bin/ysqlsh -h ${service.containerName}`;
  const ycqlDockerCmd = `docker exec -it ${service.containerName} bin/ycqlsh ${service.containerName}`;
  const bashDockerCmd = `docker exec -it ${service.containerName} /bin/bash`;
  const ysqlLocalCmd = `psql -h localhost -p ${service.ports.ysql} -U yugabyte`;
  const ycqlLocalCmd = `cqlsh localhost ${service.ports.ycql}`;

  const handleOpenTerminal = useCallback(
    async (protocol: "ysql" | "ycql") => {
      const cmd = protocol === "ysql" ? ysqlDockerCmd : ycqlDockerCmd;
      const label = `${protocol.toUpperCase()} · ${clusterName}`;
      try {
        const terminalUsed = await openInTerminal(cmd, label);
        await showToast({
          style: Toast.Style.Success,
          title: `Opening ${protocol === "ysql" ? "ysqlsh" : "ycqlsh"}`,
          message: `Connecting via ${terminalUsed}...`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Could not open shell";
        await showToast({ style: Toast.Style.Failure, title: "Error", message: msg });
      }
    },
    [ysqlDockerCmd, ycqlDockerCmd, clusterName],
  );

  return (
    <List.Item
      title={`Node ${service.nodeNumber}`}
      subtitle={service.containerName}
      icon={{ source: Icon.ComputerChip, tintColor: statusColor }}
      accessories={[{ tag: { value: statusText, color: statusColor } }]}
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              {/* Status Overview */}
              <List.Item.Detail.Metadata.Label title="Container" text={service.containerName} icon={Icon.Box} />
              <List.Item.Detail.Metadata.Label
                title="Status"
                text={statusText}
                icon={{ source: Icon.CircleFilled, tintColor: statusColor }}
              />

              <List.Item.Detail.Metadata.Separator />

              {/* Processes */}
              <List.Item.Detail.Metadata.Label title="Processes" />
              <ProcessLabel title="  yugabyted" running={service.services.yugabyted?.running ?? false} />
              <ProcessLabel title="  yb-master" running={service.services.ybMaster?.running ?? false} />
              <ProcessLabel title="  yb-tserver" running={service.services.ybTserver?.running ?? false} />

              <List.Item.Detail.Metadata.Separator />

              {/* Web UIs */}
              <List.Item.Detail.Metadata.Label title="Web UIs" />
              {anyRunning ? (
                <>
                  <List.Item.Detail.Metadata.Link
                    title="  YugabyteDB UI"
                    target={`http://localhost:${service.ports.yugabytedUI}`}
                    text={`localhost:${service.ports.yugabytedUI}`}
                  />
                  <List.Item.Detail.Metadata.Link
                    title="  Master UI"
                    target={`http://localhost:${service.ports.masterUI}`}
                    text={`localhost:${service.ports.masterUI}`}
                  />
                  <List.Item.Detail.Metadata.Link
                    title="  TServer UI"
                    target={`http://localhost:${service.ports.tserverUI}`}
                    text={`localhost:${service.ports.tserverUI}`}
                  />
                </>
              ) : (
                <List.Item.Detail.Metadata.Label title="  —" text="Node is stopped" />
              )}

              <List.Item.Detail.Metadata.Separator />

              {/* Database Ports */}
              <List.Item.Detail.Metadata.Label title="Database Ports" />
              <List.Item.Detail.Metadata.Label
                title="  YSQL (PostgreSQL)"
                text={`localhost:${service.ports.ysql}`}
                icon={Icon.Terminal}
              />
              <List.Item.Detail.Metadata.Label
                title="  YCQL (Cassandra)"
                text={`localhost:${service.ports.ycql}`}
                icon={Icon.Terminal}
              />

              <List.Item.Detail.Metadata.Separator />

              {/* Connection Strings */}
              <List.Item.Detail.Metadata.Label title="Connection Strings" />
              <List.Item.Detail.Metadata.Label title="  bash (docker)" text={bashDockerCmd} />
              <List.Item.Detail.Metadata.Label title="  ysqlsh (docker)" text={ysqlDockerCmd} />
              <List.Item.Detail.Metadata.Label title="  psql (local)" text={ysqlLocalCmd} />
              <List.Item.Detail.Metadata.Label title="  ycqlsh (docker)" text={ycqlDockerCmd} />
              <List.Item.Detail.Metadata.Label title="  cqlsh (local)" text={ycqlLocalCmd} />
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          {/* Connect */}
          <ActionPanel.Section title="Connect">
            <Action
              icon={Icon.Terminal}
              title="Open YSQL Shell"
              onAction={() => handleOpenTerminal("ysql")}
              shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
            />
            <Action
              icon={Icon.Terminal}
              title="Open YCQL Shell"
              onAction={() => handleOpenTerminal("ycql")}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
          </ActionPanel.Section>

          {/* Web UIs */}
          {anyRunning && (
            <ActionPanel.Section title="Web UIs">
              <Action.OpenInBrowser
                title="Open YugabyteDB UI"
                url={`http://localhost:${service.ports.yugabytedUI}`}
                shortcut={{ modifiers: ["cmd"], key: "u" }}
              />
              <Action.OpenInBrowser
                title="Open Master UI"
                url={`http://localhost:${service.ports.masterUI}`}
                shortcut={{ modifiers: ["cmd"], key: "m" }}
              />
              <Action.OpenInBrowser
                title="Open TServer UI"
                url={`http://localhost:${service.ports.tserverUI}`}
                shortcut={{ modifiers: ["cmd"], key: "t" }}
              />
            </ActionPanel.Section>
          )}

          {/* Copy */}
          <ActionPanel.Section title="Copy Connection">
            <Action.CopyToClipboard
              title="Copy Bash Command"
              content={bashDockerCmd}
              shortcut={{ modifiers: ["cmd", "shift"], key: "b" }}
            />
            <Action.CopyToClipboard
              title="Copy YSQL Docker Command"
              content={ysqlDockerCmd}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
            <Action.CopyToClipboard title="Copy YSQL Local Command" content={ysqlLocalCmd} />
            <Action.CopyToClipboard title="Copy YCQL Docker Command" content={ycqlDockerCmd} />
            <Action.CopyToClipboard title="Copy YCQL Local Command" content={ycqlLocalCmd} />
            <Action.CopyToClipboard title="Copy YSQL Host:Port" content={`localhost:${service.ports.ysql}`} />
            <Action.CopyToClipboard title="Copy YCQL Host:Port" content={`localhost:${service.ports.ycql}`} />
          </ActionPanel.Section>

          {/* Refresh */}
          <ActionPanel.Section>
            <Action
              icon={Icon.ArrowClockwise}
              title="Refresh"
              onAction={onRefresh}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Helper: process status label
// ---------------------------------------------------------------------------

function ProcessLabel({ title, running }: { title: string; running: boolean }) {
  return (
    <List.Item.Detail.Metadata.Label
      title={title}
      text={running ? "Running" : "Stopped"}
      icon={{
        source: running ? Icon.CircleFilled : Icon.Circle,
        tintColor: running ? Color.Green : Color.SecondaryText,
      }}
    />
  );
}
