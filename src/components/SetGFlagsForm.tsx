import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useForm } from "@raycast/utils";
import { ClusterInfo } from "../types";
import { useGFlags } from "../hooks/useGFlags";

interface SetGFlagsFormProps {
  cluster: ClusterInfo;
}

interface GFlagFormValues {
  serverType: string;
  flagName: string;
  flagValue: string;
  mode: string;
}

export function SetGFlagsForm({ cluster }: SetGFlagsFormProps) {
  const { setFlagsRuntime, setFlagsWithRestart } = useGFlags();
  const { pop } = useNavigation();

  const { handleSubmit, itemProps } = useForm<GFlagFormValues>({
    onSubmit: async (values) => {
      const serverType = values.serverType as "master" | "tserver" | "both";
      const flagName = values.flagName.trim().replace(/^--+/, "");
      const flagValue = values.flagValue.trim();

      if (values.mode === "runtime") {
        await setFlagsRuntime(cluster.name, serverType, flagName, flagValue);
      } else {
        await setFlagsWithRestart(cluster.name, serverType, flagName, flagValue);
      }
      pop();
    },
    validation: {
      flagName: (value) => {
        if (!value?.trim()) return "Flag name is required";
        const clean = value.trim().replace(/^--+/, "");
        if (clean.includes("=")) return "Flag name should not contain '='";
        if (clean.includes(" ")) return "Flag name should not contain spaces";
      },
      flagValue: (value) => {
        if (value === undefined || value === null || value === "") return "Flag value is required";
      },
    },
    initialValues: {
      serverType: "both",
      mode: "runtime",
      flagName: "",
      flagValue: "",
    },
  });

  return (
    <Form
      navigationTitle={`Set GFlags · ${cluster.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Gear} title="Apply GFlag" onSubmit={handleSubmit} />
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
      <Form.TextField
        title="Flag Name"
        placeholder="e.g. emergency_repair_mode"
        {...itemProps.flagName}
      />
      <Form.TextField
        title="Flag Value"
        placeholder="e.g. true"
        {...itemProps.flagValue}
      />
      <Form.Separator />
      <Form.Dropdown
        title="Mode"
        info="Runtime applies the flag immediately via yb-ts-cli without downtime. Cluster Restart stops all nodes, updates yugabyted.conf, and starts them back — guaranteeing the flag persists."
        {...itemProps.mode}
      >
        <Form.Dropdown.Item value="runtime" title="Runtime (no restart)" icon={Icon.Bolt} />
        <Form.Dropdown.Item value="restart" title="Cluster Restart" icon={Icon.ArrowClockwise} />
      </Form.Dropdown>
    </Form>
  );
}
