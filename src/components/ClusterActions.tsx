import { Action, ActionPanel, Icon, Color, confirmAlert, Alert, launchCommand, LaunchType } from "@raycast/api";
import { ClusterInfo } from "../types";
import { openInTerminal } from "../utils/terminal";
import { ScaleClusterForm } from "./ScaleClusterForm";
import { SetGFlagsForm } from "./SetGFlagsForm";

interface ClusterActionsProps {
  cluster: ClusterInfo;
  proxyUrl: string | null;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onRevalidate: () => void;
  onToggleDetail: () => void;
  showDetail: boolean;
  onPush: (component: React.ReactNode) => void;
  onViewServices: () => void;
}

export function ClusterActions({
  cluster,
  proxyUrl,
  onStart,
  onStop,
  onRestart,
  onDelete,
  onRevalidate,
  onToggleDetail,
  showDetail,
  onPush,
  onViewServices,
}: ClusterActionsProps) {
  const isRunning = cluster.status === "running";
  const firstNodePorts = cluster.nodePorts?.[0];
  const firstContainerName = `yb-${cluster.name}-node1`;

  return (
    <ActionPanel>
      {/* Cluster Control */}
      <ActionPanel.Section title="Cluster Control">
        {!isRunning ? (
          <Action
            icon={Icon.Play}
            title="Start Cluster"
            onAction={onStart}
            shortcut={{ modifiers: ["cmd"], key: "s" }}
          />
        ) : (
          <>
            <Action
              icon={Icon.Stop}
              title="Stop Cluster"
              onAction={onStop}
              shortcut={{ modifiers: ["cmd"], key: "s" }}
            />
            <Action
              icon={Icon.ArrowClockwise}
              title="Restart Cluster"
              onAction={onRestart}
              shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            />
          </>
        )}
      </ActionPanel.Section>

      {/* Web UIs via Proxy (default) */}
      {isRunning && proxyUrl && (
        <ActionPanel.Section title="Web UIs (via Proxy)">
          <Action.OpenInBrowser
            title="Open Master UI"
            url={`${proxyUrl}/proxy/${firstContainerName}:7000/`}
            icon={{ source: Icon.Globe, tintColor: Color.Blue }}
            shortcut={{ modifiers: ["cmd"], key: "m" }}
          />
          <Action.OpenInBrowser
            title="Open TServer UI"
            url={`${proxyUrl}/proxy/${firstContainerName}:9000/`}
            icon={{ source: Icon.Globe, tintColor: Color.Blue }}
            shortcut={{ modifiers: ["cmd"], key: "t" }}
          />
          <Action.OpenInBrowser
            title="Open YugabyteDB UI"
            url={`${proxyUrl}/proxy/${firstContainerName}:15433/`}
            icon={{ source: Icon.Globe, tintColor: Color.Blue }}
            shortcut={{ modifiers: ["cmd"], key: "u" }}
          />
          <Action.OpenInBrowser
            title="Open Master RPC UI"
            url={`${proxyUrl}/proxy/${firstContainerName}:7100/`}
            icon={{ source: Icon.Globe, tintColor: Color.Blue }}
          />
          <Action.OpenInBrowser
            title="Open TServer RPC UI"
            url={`${proxyUrl}/proxy/${firstContainerName}:9100/`}
            icon={{ source: Icon.Globe, tintColor: Color.Blue }}
          />
          <Action
            icon={Icon.AppWindowList}
            title="View All Services"
            onAction={onViewServices}
            shortcut={{ modifiers: ["cmd"], key: "v" }}
          />
        </ActionPanel.Section>
      )}

      {/* Direct Web UIs (fallback / secondary) */}
      {isRunning && firstNodePorts && (
        <ActionPanel.Section title={proxyUrl ? "Web UIs (Direct)" : "Web UIs"}>
          <Action.OpenInBrowser
            title={proxyUrl ? "Open YugabyteDB UI (Direct)" : "Open YugabyteDB UI"}
            url={`http://localhost:${firstNodePorts.yugabytedUI}`}
            shortcut={proxyUrl ? undefined : { modifiers: ["cmd"], key: "u" }}
          />
          <Action.OpenInBrowser
            title={proxyUrl ? "Open Master UI (Direct)" : "Open Master UI"}
            url={`http://localhost:${firstNodePorts.masterUI}`}
            shortcut={proxyUrl ? undefined : { modifiers: ["cmd"], key: "m" }}
          />
          <Action.OpenInBrowser
            title={proxyUrl ? "Open TServer UI (Direct)" : "Open TServer UI"}
            url={`http://localhost:${firstNodePorts.tserverUI}`}
            shortcut={proxyUrl ? undefined : { modifiers: ["cmd"], key: "t" }}
          />
          {!proxyUrl && (
            <Action
              icon={Icon.AppWindowList}
              title="View All Services"
              onAction={onViewServices}
              shortcut={{ modifiers: ["cmd"], key: "v" }}
            />
          )}
        </ActionPanel.Section>
      )}

      {/* Database Connections */}
      {isRunning && (
        <ActionPanel.Section title="Database Connections">
          <Action
            icon={Icon.Terminal}
            title="Connect to YSQL (PostgreSQL)"
            onAction={async () => {
              const command = `docker exec -it ${firstContainerName} bin/ysqlsh -h ${firstContainerName}`;
              await openInTerminal(command, `YSQL · ${cluster.name}`);
            }}
            shortcut={{ modifiers: ["cmd", "shift"], key: "y" }}
          />
          <Action
            icon={Icon.Terminal}
            title="Connect to YCQL (Cassandra)"
            onAction={async () => {
              const command = `docker exec -it ${firstContainerName} bin/ycqlsh ${firstContainerName}`;
              await openInTerminal(command, `YCQL · ${cluster.name}`);
            }}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel.Section>
      )}

      {/* Management */}
      {isRunning && (
        <ActionPanel.Section title="Cluster Management">
          <Action
            icon={Icon.ArrowUpDown}
            title="Scale Cluster"
            onAction={() => onPush(<ScaleClusterForm cluster={cluster} />)}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
          />
          <Action
            icon={Icon.Gear}
            title="Set GFlags"
            onAction={() => onPush(<SetGFlagsForm cluster={cluster} />)}
            shortcut={{ modifiers: ["cmd"], key: "g" }}
          />
        </ActionPanel.Section>
      )}

      {/* General Actions */}
      <ActionPanel.Section>
        <Action
          icon={Icon.Sidebar}
          title={showDetail ? "Hide Details" : "Show Details"}
          onAction={onToggleDetail}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
        />
        <Action
          icon={Icon.ArrowClockwise}
          title="Refresh List"
          onAction={onRevalidate}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
        />
        <Action
          icon={Icon.Plus}
          title="Create New Cluster"
          onAction={async () => {
            await launchCommand({ name: "create-cluster", type: LaunchType.UserInitiated });
          }}
        />
        <Action
          icon={Icon.Trash}
          title="Delete Cluster"
          style={Action.Style.Destructive}
          onAction={async () => {
            const confirmed = await confirmAlert({
              title: "Delete Cluster",
              message: `Are you sure you want to delete "${cluster.name}"? This will remove all containers and data.`,
              primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
            });
            if (confirmed) onDelete();
          }}
          shortcut={{ modifiers: ["cmd"], key: "backspace" }}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}
