import { Action, ActionPanel, Form, showToast, Toast, Icon, launchCommand, LaunchType } from "@raycast/api";
import { useForm } from "@raycast/utils";
import { useRef } from "react";
import { createYugabyteCluster } from "./utils/docker";
import { useDockerHubReleases } from "./hooks/useDockerHubReleases";
import { ProgressCallback } from "./types";

interface CreateClusterValues {
  name: string;
  nodes: string;
  version: string;
  masterGFlags: string;
  tserverGFlags: string;
}

export default function Command() {
  const { releases, isLoading: isLoadingReleases, revalidate: refreshReleases } = useDockerHubReleases();
  const toastRef = useRef<Toast | null>(null);
  const isSubmittingRef = useRef(false);

  const { handleSubmit, itemProps } = useForm<CreateClusterValues>({
    async onSubmit(values) {
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;

      const name = values.name.trim();
      const nodes = parseInt(values.nodes, 10);
      const version = values.version.trim() || "latest";
      const masterGFlags = values.masterGFlags?.trim() || undefined;
      const tserverGFlags = values.tserverGFlags?.trim() || undefined;

      const initialToast = await showToast({
        style: Toast.Style.Animated,
        title: "Creating Cluster",
        message: "Initializing...",
      });
      toastRef.current = initialToast;

      const progressCallback: ProgressCallback = async (progress) => {
        const titles: Record<string, string> = {
          cleanup: "Preparing",
          image: "Checking Image",
          network: "Setting Up Network",
          node: `Creating Node ${progress.nodeNumber ?? ""}/${progress.totalNodes ?? ""}`,
          init: "Initializing Cluster",
          finalize: "Finalizing",
          complete: "Cluster Created",
        };
        const title = titles[progress.stage] || "Creating Cluster";

        if (toastRef.current) {
          toastRef.current.title = title;
          toastRef.current.message = progress.message;
        }
      };

      try {
        await createYugabyteCluster(name, nodes, version, masterGFlags, tserverGFlags, progressCallback);

        toastRef.current?.hide();
        await showToast({
          style: Toast.Style.Success,
          title: "Cluster Created",
          message: `"${name}" created successfully with ${nodes} node(s)`,
        });

        try {
          await launchCommand({ name: "list-clusters", type: LaunchType.UserInitiated });
        } catch {
          // User can navigate manually
        }
      } catch (error: unknown) {
        toastRef.current?.hide();
        const msg = error instanceof Error ? error.message : "Unknown error occurred";
        const displayMsg = msg.length > 150 ? msg.substring(0, 150) + "..." : msg;
        await showToast({
          style: Toast.Style.Failure,
          title: "Error Creating Cluster",
          message: displayMsg,
        });
      } finally {
        isSubmittingRef.current = false;
        toastRef.current = null;
      }
    },

    validation: {
      name: (value) => {
        if (!value?.trim()) return "Cluster name is required";
        if (!/^[a-z0-9][a-z0-9-]*$/.test(value.trim())) {
          return "Only lowercase letters, numbers, and hyphens (must start with letter or number)";
        }
      },
      nodes: (value) => {
        const n = parseInt(value || "", 10);
        if (isNaN(n) || n < 1 || n > 10) return "Must be between 1 and 10";
      },
    },

    initialValues: {
      name: "my-cluster",
      nodes: "3",
      version: "latest",
      masterGFlags: "",
      tserverGFlags: "",
    },
  });

  return (
    <Form
      navigationTitle="Create YugabyteDB Cluster"
      isLoading={isLoadingReleases}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Plus} title="Create Cluster" onSubmit={handleSubmit} />
          <Action
            icon={Icon.ArrowClockwise}
            title="Refresh Releases"
            onAction={refreshReleases}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        title="Cluster Name"
        placeholder="my-cluster"
        info="A unique name for your cluster. Only lowercase letters, numbers, and hyphens."
        {...itemProps.name}
      />
      <Form.TextField
        title="Number of Nodes"
        placeholder="3"
        info="Number of nodes (1-10). Recommended: 1 for development, 3+ for testing replication."
        {...itemProps.nodes}
      />
      <Form.Dropdown
        title="YugabyteDB Version"
        info="Select a version. Press Cmd+R to refresh the list from Docker Hub."
        isLoading={isLoadingReleases}
        {...itemProps.version}
      >
        {releases.map((release) => (
          <Form.Dropdown.Item key={release.tag} value={release.tag} title={release.name} />
        ))}
      </Form.Dropdown>
      <Form.Separator />
      <Form.TextArea
        title="Master GFlags (Optional)"
        placeholder="max_log_size=256,log_min_seconds_to_retain=3600"
        info="Custom GFlags for yb-master. Format: flag1=value1,flag2=value2 (comma-separated, no -- prefix)"
        {...itemProps.masterGFlags}
      />
      <Form.TextArea
        title="TServer GFlags (Optional)"
        placeholder="pg_yb_session_timeout_ms=1200000,ysql_max_connections=400"
        info="Custom GFlags for yb-tserver. Format: flag1=value1,flag2=value2 (comma-separated, no -- prefix)"
        {...itemProps.tserverGFlags}
      />
    </Form>
  );
}
