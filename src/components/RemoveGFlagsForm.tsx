import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useForm } from "@raycast/utils";
import { ClusterInfo } from "../types";
import { useGFlags } from "../hooks/useGFlags";
import { parseGFlagsToMap } from "../utils/docker";

interface RemoveGFlagsFormProps {
  cluster: ClusterInfo;
}

interface RemoveGFlagFormValues {
  serverType: string;
  flagNames: string[];
  mode: string;
}

export function RemoveGFlagsForm({ cluster }: RemoveGFlagsFormProps) {
  const { removeFlagsFromMetadata, removeFlagsWithRestart } = useGFlags();
  const { pop } = useNavigation();

  const masterFlags = parseGFlagsToMap(cluster.masterGFlags);
  const tserverFlags = parseGFlagsToMap(cluster.tserverGFlags);

  const allFlags = new Map<string, { master?: string; tserver?: string }>();
  for (const [k, v] of Object.entries(masterFlags)) {
    allFlags.set(k, { ...allFlags.get(k), master: v });
  }
  for (const [k, v] of Object.entries(tserverFlags)) {
    allFlags.set(k, { ...allFlags.get(k), tserver: v });
  }

  const hasFlags = allFlags.size > 0;

  const { handleSubmit, itemProps } = useForm<RemoveGFlagFormValues>({
    onSubmit: async (values) => {
      const serverType = values.serverType as "master" | "tserver" | "both";
      const flagNames = values.flagNames;

      if (values.mode === "metadata") {
        await removeFlagsFromMetadata(cluster.name, serverType, flagNames);
      } else {
        await removeFlagsWithRestart(cluster.name, serverType, flagNames);
      }
      pop();
    },
    validation: {
      flagNames: (value) => {
        if (!value || value.length === 0) return "Select at least one flag to remove";
      },
    },
    initialValues: {
      serverType: "both",
      mode: "restart",
      flagNames: [],
    },
  });

  if (!hasFlags) {
    return (
      <Form navigationTitle={`Remove GFlags · ${cluster.name}`}>
        <Form.Description title="Cluster" text={`${cluster.name} (${cluster.nodes} node(s), ${cluster.version})`} />
        <Form.Separator />
        <Form.Description title="" text="No GFlags are currently set on this cluster." />
      </Form>
    );
  }

  const flagItems = Array.from(allFlags.entries()).map(([name, values]) => {
    const parts: string[] = [];
    if (values.master !== undefined) parts.push(`master=${values.master}`);
    if (values.tserver !== undefined) parts.push(`tserver=${values.tserver}`);
    return { name, subtitle: parts.join(", ") };
  });

  return (
    <Form
      navigationTitle={`Remove GFlags · ${cluster.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Trash} title="Remove Selected Flags" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Cluster"
        text={`${cluster.name} (${cluster.nodes} node(s), ${cluster.version})`}
      />
      <Form.Separator />
      <Form.Dropdown title="Server Type" {...itemProps.serverType}>
        <Form.Dropdown.Item value="both" title="Both (Master & TServer)" icon={Icon.Layers} />
        <Form.Dropdown.Item value="master" title="YB-Master" icon={Icon.Crown} />
        <Form.Dropdown.Item value="tserver" title="YB-TServer" icon={Icon.HardDrive} />
      </Form.Dropdown>
      <Form.TagPicker title="Flags to Remove" {...itemProps.flagNames}>
        {flagItems.map((flag) => (
          <Form.TagPicker.Item key={flag.name} value={flag.name} title={flag.name} icon={Icon.Tag} />
        ))}
      </Form.TagPicker>
      <Form.Separator />
      <Form.Dropdown
        title="Mode"
        info="Remove from metadata only removes the flag from stored configuration — it takes effect on the next restart. Cluster Restart stops all nodes, removes the flag from configuration, and restarts — guaranteeing the flag is fully removed."
        {...itemProps.mode}
      >
        <Form.Dropdown.Item value="restart" title="Cluster Restart" icon={Icon.ArrowClockwise} />
        <Form.Dropdown.Item value="metadata" title="Remove from Metadata Only" icon={Icon.Document} />
      </Form.Dropdown>
    </Form>
  );
}
