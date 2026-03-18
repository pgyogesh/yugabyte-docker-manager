import { Action, ActionPanel, Form, Icon, useNavigation, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import { ClusterInfo } from "../types";
import { useGFlags } from "../hooks/useGFlags";
import { useVarzFlags } from "../hooks/useVarzFlags";

interface SetGFlagsFormProps {
  cluster: ClusterInfo;
}

export function SetGFlagsForm({ cluster }: SetGFlagsFormProps) {
  const { setFlagsRuntime, setFlagsWithRestart } = useGFlags();
  const { pop } = useNavigation();

  const [serverType, setServerType] = useState("both");
  const { flags, isLoading: isLoadingFlags } = useVarzFlags(
    cluster.name,
    serverType as "master" | "tserver" | "both",
  );

  const [selectedFlag, setSelectedFlag] = useState("");
  const currentFlagValue = flags.find((f) => f.name === selectedFlag)?.value;

  return (
    <Form
      navigationTitle={`Set GFlags · ${cluster.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            icon={Icon.Gear}
            title="Apply GFlag"
            onSubmit={async (values: { serverType: string; flagName: string; flagValue: string; mode: string }) => {
              const st = values.serverType as "master" | "tserver" | "both";
              const flagName = values.flagName?.trim().replace(/^--+/, "");
              const flagValue = values.flagValue?.trim();

              if (!flagName) {
                await showToast({ style: Toast.Style.Failure, title: "Flag name is required" });
                return;
              }
              if (!flagValue && flagValue !== "0") {
                await showToast({ style: Toast.Style.Failure, title: "Flag value is required" });
                return;
              }

              if (values.mode === "runtime") {
                await setFlagsRuntime(cluster.name, st, flagName, flagValue);
              } else {
                await setFlagsWithRestart(cluster.name, st, flagName, flagValue);
              }
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Cluster"
        text={`${cluster.name} (${cluster.nodes} node(s), ${cluster.version})`}
      />
      <Form.Separator />
      <Form.Dropdown id="serverType" title="Server Type" defaultValue="both" onChange={setServerType}>
        <Form.Dropdown.Item value="both" title="Both (Master & TServer)" icon={Icon.Layers} />
        <Form.Dropdown.Item value="master" title="YB-Master" icon={Icon.Crown} />
        <Form.Dropdown.Item value="tserver" title="YB-TServer" icon={Icon.HardDrive} />
      </Form.Dropdown>
      <Form.Dropdown
        id="flagName"
        title="Flag Name"
        isLoading={isLoadingFlags}
        onChange={setSelectedFlag}
      >
        {flags.map((flag) => (
          <Form.Dropdown.Item key={flag.name} value={flag.name} title={flag.name} icon={Icon.Tag} />
        ))}
      </Form.Dropdown>
      {selectedFlag && currentFlagValue !== undefined && (
        <Form.Description title="Current Value" text={currentFlagValue || "(empty)"} />
      )}
      <Form.TextField
        id="flagValue"
        title="New Value"
        placeholder={currentFlagValue ?? "e.g. true"}
        info="Enter the raw value — do not escape quotes with backslashes. For CSV flags like ysql_pg_conf_csv, enter the full value including quotes."
      />
      <Form.Separator />
      <Form.Dropdown
        id="mode"
        title="Mode"
        defaultValue="runtime"
        info="Runtime applies the flag immediately via yb-ts-cli without downtime. Cluster Restart stops all nodes, updates yugabyted.conf, and starts them back."
      >
        <Form.Dropdown.Item value="runtime" title="Runtime (no restart)" icon={Icon.Bolt} />
        <Form.Dropdown.Item value="restart" title="Cluster Restart" icon={Icon.ArrowClockwise} />
      </Form.Dropdown>
    </Form>
  );
}
