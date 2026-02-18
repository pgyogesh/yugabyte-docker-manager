import { List, Icon, Color, useNavigation } from "@raycast/api";
import { ClusterInfo } from "../types";
import { ClusterActions } from "./ClusterActions";
import ViewClusterServices from "../view-cluster-services";

interface ClusterListItemProps {
  cluster: ClusterInfo;
  showDetail: boolean;
  proxyUrl: string | null;
  onToggleDetail: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onRevalidate: () => void;
}

export function ClusterListItem({
  cluster,
  showDetail,
  proxyUrl,
  onToggleDetail,
  onStart,
  onStop,
  onRestart,
  onDelete,
  onRevalidate,
}: ClusterListItemProps) {
  const { push } = useNavigation();
  const isRunning = cluster.status === "running";
  const statusColor = isRunning ? Color.Green : Color.SecondaryText;
  const statusIcon = { source: Icon.CircleFilled, tintColor: statusColor };
  const firstPorts = cluster.nodePorts?.[0];
  const firstContainer = `yb-${cluster.name}-node1`;

  return (
    <List.Item
      key={cluster.name}
      title={cluster.name}
      subtitle={showDetail ? undefined : `${cluster.nodes} node${cluster.nodes > 1 ? "s" : ""} · v${cluster.version}`}
      icon={{ source: Icon.HardDrive, tintColor: statusColor }}
      accessories={showDetail ? [] : [{ text: isRunning ? "Running" : "Stopped", icon: statusIcon }]}
      detail={
        showDetail ? (
          <List.Item.Detail
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label
                  title="Status"
                  text={isRunning ? "Running" : "Stopped"}
                  icon={statusIcon}
                />
                <List.Item.Detail.Metadata.Label title="Nodes" text={String(cluster.nodes)} icon={Icon.ComputerChip} />
                <List.Item.Detail.Metadata.Label title="Version" text={cluster.version} icon={Icon.Tag} />
                <List.Item.Detail.Metadata.Separator />
                {firstPorts ? (
                  <>
                    <List.Item.Detail.Metadata.Label
                      title="YSQL Port"
                      text={String(firstPorts.ysql)}
                      icon={Icon.Terminal}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="YCQL Port"
                      text={String(firstPorts.ycql)}
                      icon={Icon.Terminal}
                    />
                    <List.Item.Detail.Metadata.Separator />

                    {/* Web UIs — proxy links are shown first as the default */}
                    {isRunning && proxyUrl && (
                      <>
                        <List.Item.Detail.Metadata.Link
                          title="Master UI"
                          target={`${proxyUrl}/proxy/${firstContainer}:7000/`}
                          text="proxy → :7000"
                        />
                        <List.Item.Detail.Metadata.Link
                          title="TServer UI"
                          target={`${proxyUrl}/proxy/${firstContainer}:9000/`}
                          text="proxy → :9000"
                        />
                        <List.Item.Detail.Metadata.Link
                          title="YugabyteDB UI"
                          target={`${proxyUrl}/proxy/${firstContainer}:15433/`}
                          text="proxy → :15433"
                        />
                        <List.Item.Detail.Metadata.Link
                          title="Master RPC UI"
                          target={`${proxyUrl}/proxy/${firstContainer}:7100/`}
                          text="proxy → :7100"
                        />
                        <List.Item.Detail.Metadata.Link
                          title="TServer RPC UI"
                          target={`${proxyUrl}/proxy/${firstContainer}:9100/`}
                          text="proxy → :9100"
                        />
                      </>
                    )}

                    {/* Direct links (fallback when proxy is unavailable) */}
                    {isRunning && !proxyUrl && (
                      <>
                        <List.Item.Detail.Metadata.Link
                          title="YugabyteDB UI"
                          target={`http://localhost:${firstPorts.yugabytedUI}`}
                          text={`localhost:${firstPorts.yugabytedUI}`}
                        />
                        <List.Item.Detail.Metadata.Link
                          title="Master UI"
                          target={`http://localhost:${firstPorts.masterUI}`}
                          text={`localhost:${firstPorts.masterUI}`}
                        />
                        <List.Item.Detail.Metadata.Link
                          title="TServer UI"
                          target={`http://localhost:${firstPorts.tserverUI}`}
                          text={`localhost:${firstPorts.tserverUI}`}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <List.Item.Detail.Metadata.Label title="Ports" text="Not available" />
                )}
                {cluster.masterGFlags && (
                  <>
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label title="Master GFlags" text={cluster.masterGFlags} />
                  </>
                )}
                {cluster.tserverGFlags && (
                  <List.Item.Detail.Metadata.Label title="TServer GFlags" text={cluster.tserverGFlags} />
                )}
              </List.Item.Detail.Metadata>
            }
          />
        ) : undefined
      }
      actions={
        <ClusterActions
          cluster={cluster}
          proxyUrl={proxyUrl}
          onStart={onStart}
          onStop={onStop}
          onRestart={onRestart}
          onDelete={onDelete}
          onRevalidate={onRevalidate}
          onToggleDetail={onToggleDetail}
          showDetail={showDetail}
          onPush={push}
          onViewServices={() => push(<ViewClusterServices initialClusterName={cluster.name} />)}
        />
      }
    />
  );
}
