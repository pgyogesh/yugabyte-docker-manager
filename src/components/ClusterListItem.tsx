import { List, Icon, Color, useNavigation } from "@raycast/api";
import { ClusterInfo } from "../types";
import { ClusterActions } from "./ClusterActions";
import ViewClusterServices from "../view-cluster-services";

interface ClusterListItemProps {
  cluster: ClusterInfo;
  showDetail: boolean;
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
                    {isRunning && (
                      <List.Item.Detail.Metadata.Link
                        title="YugabyteDB UI"
                        target={`http://localhost:${firstPorts.yugabytedUI}`}
                        text={`localhost:${firstPorts.yugabytedUI}`}
                      />
                    )}
                    {isRunning && (
                      <List.Item.Detail.Metadata.Link
                        title="Master UI"
                        target={`http://localhost:${firstPorts.masterUI}`}
                        text={`localhost:${firstPorts.masterUI}`}
                      />
                    )}
                    {isRunning && (
                      <List.Item.Detail.Metadata.Link
                        title="TServer UI"
                        target={`http://localhost:${firstPorts.tserverUI}`}
                        text={`localhost:${firstPorts.tserverUI}`}
                      />
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
