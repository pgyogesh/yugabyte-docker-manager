import { Action, ActionPanel, List, Icon, Color, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { useClusters } from "./hooks/useClusters";
import { useClusterServices } from "./hooks/useClusterServices";
import { openInTerminal } from "./utils/terminal";

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
      navigationTitle="Cluster Services"
      searchBarPlaceholder="Search services..."
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
          <List.Section key={service.containerName} title={`Node ${service.nodeNumber} (${service.containerName})`}>
            {/* YugabyteDB UI */}
            {service.services.yugabyted && (
              <ServiceItem
                title="YugabyteDB UI"
                port={service.ports.yugabytedUI}
                running={service.services.yugabyted.running}
                url={`http://localhost:${service.ports.yugabytedUI}`}
                onRefresh={revalidate}
              />
            )}

            {/* Master UI */}
            {service.services.ybMaster && (
              <ServiceItem
                title="Master Web UI"
                port={service.ports.masterUI}
                running={service.services.ybMaster.running}
                url={`http://localhost:${service.ports.masterUI}`}
                onRefresh={revalidate}
              />
            )}

            {/* TServer UI */}
            {service.services.ybTserver && (
              <ServiceItem
                title="TServer Web UI"
                port={service.ports.tserverUI}
                running={service.services.ybTserver.running}
                url={`http://localhost:${service.ports.tserverUI}`}
                onRefresh={revalidate}
              />
            )}

            {/* YSQL Endpoint */}
            <DatabaseEndpointItem
              title="YSQL Endpoint"
              subtitle="PostgreSQL-compatible"
              port={service.ports.ysql}
              containerName={service.containerName}
              protocol="ysql"
              onRefresh={revalidate}
            />

            {/* YCQL Endpoint */}
            <DatabaseEndpointItem
              title="YCQL Endpoint"
              subtitle="Cassandra-compatible"
              port={service.ports.ycql}
              containerName={service.containerName}
              protocol="ycql"
              onRefresh={revalidate}
            />
          </List.Section>
        ))
      )}
    </List>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ServiceItem({
  title,
  port,
  running,
  url,
  onRefresh,
}: {
  title: string;
  port: number;
  running: boolean;
  url: string;
  onRefresh: () => void;
}) {
  const statusIcon = running
    ? { source: Icon.CircleFilled, tintColor: Color.Green }
    : { source: Icon.Circle, tintColor: Color.SecondaryText };

  return (
    <List.Item
      title={title}
      subtitle={`Port ${port}`}
      icon={statusIcon}
      accessories={[{ text: url }]}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open in Browser" url={url} />
          <Action.CopyToClipboard title="Copy URL" content={url} shortcut={{ modifiers: ["cmd"], key: "c" }} />
          <Action
            icon={Icon.ArrowClockwise}
            title="Refresh"
            onAction={onRefresh}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
        </ActionPanel>
      }
    />
  );
}

function DatabaseEndpointItem({
  title,
  subtitle,
  port,
  containerName,
  protocol,
  onRefresh,
}: {
  title: string;
  subtitle: string;
  port: number;
  containerName: string;
  protocol: "ysql" | "ycql";
  onRefresh: () => void;
}) {
  const shellBinary = protocol === "ysql" ? "ysqlsh" : "ycqlsh";
  const dockerCommand =
    protocol === "ysql"
      ? `docker exec -it ${containerName} bin/ysqlsh -h ${containerName}`
      : `docker exec -it ${containerName} bin/ycqlsh ${containerName}`;
  const copyCommand =
    protocol === "ysql"
      ? `docker exec -it ${containerName} bin/ysqlsh -h ${containerName} -p ${port}`
      : `docker exec -it ${containerName} bin/ycqlsh ${containerName} ${port}`;
  const clientCommand = protocol === "ysql" ? `psql -h localhost -p ${port} -U yugabyte` : `cqlsh localhost ${port}`;

  return (
    <List.Item
      title={title}
      subtitle={`${subtitle} · Port ${port}`}
      icon={Icon.Terminal}
      accessories={[{ text: `localhost:${port}` }]}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Connect">
            <Action
              icon={Icon.Terminal}
              title={`Open ${shellBinary} in Terminal`}
              onAction={async () => {
                try {
                  const terminalUsed = await openInTerminal(
                    dockerCommand,
                    `${protocol.toUpperCase()} · ${containerName}`,
                  );
                  await showToast({
                    style: Toast.Style.Success,
                    title: `Opening ${shellBinary}`,
                    message: `Connecting via ${terminalUsed}...`,
                  });
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : "Could not open shell";
                  await showToast({ style: Toast.Style.Failure, title: "Error", message: msg });
                }
              }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Copy Connection">
            <Action.CopyToClipboard
              title={`Copy ${shellBinary} Command`}
              content={copyCommand}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
            <Action.CopyToClipboard title="Copy Host:Port" content={`localhost:${port}`} />
            <Action.CopyToClipboard
              title={`Copy ${protocol === "ysql" ? "psql" : "cqlsh"} Command`}
              content={clientCommand}
            />
          </ActionPanel.Section>
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
