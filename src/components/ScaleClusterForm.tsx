import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useForm } from "@raycast/utils";
import { ClusterInfo } from "../types";
import { useClusters } from "../hooks/useClusters";

interface ScaleClusterFormProps {
  cluster: ClusterInfo;
}

interface ScaleFormValues {
  nodes: string;
}

export function ScaleClusterForm({ cluster }: ScaleClusterFormProps) {
  const { scaleCluster } = useClusters();
  const { pop } = useNavigation();

  const { handleSubmit, itemProps } = useForm<ScaleFormValues>({
    onSubmit: async (values) => {
      const target = parseInt(values.nodes, 10);
      await scaleCluster(cluster.name, target);
      pop();
    },
    validation: {
      nodes: (value) => {
        const n = parseInt(value || "", 10);
        if (isNaN(n) || n < 1 || n > 10) return "Must be between 1 and 10";
        if (n === cluster.nodes) return `Cluster already has ${n} nodes`;
      },
    },
    initialValues: {
      nodes: String(cluster.nodes),
    },
  });

  return (
    <Form
      navigationTitle={`Scale "${cluster.name}"`}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.ArrowUpDown} title="Scale Cluster" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description title="Cluster" text={cluster.name} />
      <Form.Description title="Current Nodes" text={`${cluster.nodes} node(s)`} />
      <Form.Description title="Version" text={cluster.version} />
      <Form.Separator />
      <Form.TextField
        title="Target Number of Nodes"
        placeholder="3"
        info="Enter the target number of nodes (1-10). The cluster will be scaled up or down accordingly."
        {...itemProps.nodes}
      />
    </Form>
  );
}
