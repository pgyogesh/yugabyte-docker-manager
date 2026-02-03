import { Form, Action, ActionPanel, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import { createYugabyteCluster, getCluster } from "./utils/docker";

export default function Command() {
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(values: Form.Values) {
    const { clusterName, nodeCount, version } = values;

    if (!clusterName || !nodeCount || !version) {
      const errorMsg = "All fields are required";
      console.error("[Create Cluster] Validation Error:", errorMsg);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: errorMsg,
      });
      return;
    }

    // Check if cluster already exists
    try {
      const existingCluster = await getCluster(clusterName);
      if (existingCluster) {
        const errorMsg = `Cluster "${clusterName}" already exists`;
        console.error("[Create Cluster] Validation Error:", errorMsg);
        await showToast({
          style: Toast.Style.Failure,
          title: "Error",
          message: errorMsg,
        });
        return;
      }
    } catch (error: any) {
      const errorMsg = `Error checking existing cluster: ${error.message || error}`;
      console.error("[Create Cluster] Error:", errorMsg);
      console.error("[Create Cluster] Stack:", error.stack);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: errorMsg,
      });
      return;
    }

    const nodes = parseInt(nodeCount, 10);
    if (isNaN(nodes) || nodes < 1) {
      const errorMsg = "Number of nodes must be a positive integer";
      console.error("[Create Cluster] Validation Error:", errorMsg);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: errorMsg,
      });
      return;
    }

    setIsLoading(true);
    try {
      console.log(`[Create Cluster] Starting creation: name=${clusterName}, nodes=${nodes}, version=${version}`);
      await showToast({
        style: Toast.Style.Animated,
        title: "Creating cluster",
        message: `Creating ${nodes}-node cluster "${clusterName}"...`,
      });

      await createYugabyteCluster(clusterName, nodes, version);

      console.log(`[Create Cluster] Successfully created cluster: ${clusterName}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster created",
        message: `Cluster "${clusterName}" with ${nodes} nodes created successfully`,
      });
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error("[Create Cluster] Error creating cluster:", errorMsg);
      console.error("[Create Cluster] Full error:", error);
      console.error("[Create Cluster] Stack trace:", error.stack);
      if (error.stdout) console.error("[Create Cluster] Docker stdout:", error.stdout);
      if (error.stderr) console.error("[Create Cluster] Docker stderr:", error.stderr);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error creating cluster",
        message: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Cluster" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="clusterName"
        title="Cluster Name"
        placeholder="my-cluster"
        defaultValue=""
      />
      <Form.TextField
        id="nodeCount"
        title="Number of Nodes"
        placeholder="3"
        defaultValue="3"
      />
      <Form.TextField
        id="version"
        title="YugabyteDB Version"
        placeholder="latest"
        defaultValue="latest"
      />
    </Form>
  );
}
