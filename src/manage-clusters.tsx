import { Action, ActionPanel, List, Icon, launchCommand, LaunchType } from "@raycast/api";
import { useState, useCallback } from "react";
import { useClusters } from "./hooks/useClusters";
import { useProxy } from "./hooks/useProxy";
import { ClusterListItem } from "./components/ClusterListItem";

export default function Command() {
  const { clusters, isLoading, revalidate, startCluster, stopCluster, restartCluster, deleteCluster } = useClusters();
  const { proxyRunning, proxyUrl } = useProxy();
  const [showDetail, setShowDetail] = useState(true);
  const toggleDetail = useCallback(() => setShowDetail((prev) => !prev), []);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showDetail && clusters.length > 0}
      searchBarPlaceholder="Search clusters..."
    >
      {clusters.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.HardDrive}
          title="No Clusters Found"
          description="Create a YugabyteDB cluster to get started."
          actions={
            <ActionPanel>
              <Action
                icon={Icon.Plus}
                title="Create Cluster"
                onAction={async () => {
                  await launchCommand({ name: "create-cluster", type: LaunchType.UserInitiated });
                }}
              />
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
        clusters.map((cluster) => (
          <ClusterListItem
            key={cluster.name}
            cluster={cluster}
            showDetail={showDetail}
            proxyUrl={proxyRunning ? proxyUrl : null}
            onToggleDetail={toggleDetail}
            onStart={() => startCluster(cluster)}
            onStop={() => stopCluster(cluster)}
            onRestart={() => restartCluster(cluster)}
            onDelete={() => deleteCluster(cluster)}
            onRevalidate={revalidate}
          />
        ))
      )}
    </List>
  );
}
