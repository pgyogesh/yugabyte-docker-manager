import { Action, ActionPanel, Form, Icon, useNavigation, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import { ClusterInfo } from "../types";
import { useGFlags } from "../hooks/useGFlags";
import { parseGFlagsToMap } from "../utils/docker";

interface UpdateGFlagsFormProps {
  cluster: ClusterInfo;
}

export function UpdateGFlagsForm({ cluster }: UpdateGFlagsFormProps) {
  const { setFlagsRuntime, setFlagsWithRestart } = useGFlags();
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

  const flagEntries = Array.from(allFlags.entries());
  const initialFlag = flagEntries[0]?.[0] || "";
  const initialInfo = allFlags.get(initialFlag);
  const initialValue = initialInfo?.tserver ?? initialInfo?.master ?? "";

  const [selectedFlag, setSelectedFlag] = useState(initialFlag);
  const [newValue, setNewValue] = useState(initialValue);

  const flagInfo = allFlags.get(selectedFlag);
  const currentValue = flagInfo?.tserver ?? flagInfo?.master ?? "";

  if (allFlags.size === 0) {
    return (
      <Form navigationTitle={`Update GFlags · ${cluster.name}`}>
        <Form.Description title="Cluster" text={`${cluster.name} (${cluster.nodes} node(s), ${cluster.version})`} />
        <Form.Separator />
        <Form.Description title="" text="No GFlags are currently set on this cluster." />
      </Form>
    );
  }

  return (
    <Form
      navigationTitle={`Update GFlags · ${cluster.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            icon={Icon.Pencil}
            title="Update Flag"
            onSubmit={async (values: { flagName: string; newValue: string; mode: string }) => {
              const flagName = values.flagName || selectedFlag;
              const value = (values.newValue ?? newValue)?.trim();

              if (!flagName) {
                await showToast({ style: Toast.Style.Failure, title: "Select a flag to update" });
                return;
              }
              if (!value) {
                await showToast({ style: Toast.Style.Failure, title: "New value is required" });
                return;
              }

              const info = allFlags.get(flagName);
              let serverType: "master" | "tserver" | "both" = "both";
              if (info) {
                if (info.master !== undefined && info.tserver !== undefined) serverType = "both";
                else if (info.master !== undefined) serverType = "master";
                else serverType = "tserver";
              }

              if (values.mode === "runtime") {
                await setFlagsRuntime(cluster.name, serverType, flagName, value);
              } else {
                await setFlagsWithRestart(cluster.name, serverType, flagName, value);
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
      <Form.Dropdown
        id="flagName"
        title="Flag"
        onChange={(v) => {
          setSelectedFlag(v);
          const info = allFlags.get(v);
          setNewValue(info?.tserver ?? info?.master ?? "");
        }}
      >
        {flagEntries.map(([name, values]) => {
          const parts: string[] = [];
          if (values.master !== undefined) parts.push("master");
          if (values.tserver !== undefined) parts.push("tserver");
          return (
            <Form.Dropdown.Item
              key={name}
              value={name}
              title={name}
              icon={Icon.Tag}
              keywords={[parts.join(", ")]}
            />
          );
        })}
      </Form.Dropdown>
      <Form.Description title="Current Value" text={currentValue || "(empty)"} />
      <Form.TextField
        id="newValue"
        title="New Value"
        placeholder="Enter new value..."
        value={newValue}
        onChange={setNewValue}
        info="Enter the raw value — do not escape quotes with backslashes. For CSV flags like ysql_pg_conf_csv, enter the value as-is (e.g. &quot;shared_preload_libraries=passwordcheck,auto_explain&quot;,pgaudit.log=ROLE). The tool handles all escaping automatically."
      />
      <Form.Separator />
      <Form.Dropdown
        id="mode"
        title="Mode"
        info="Runtime applies the flag immediately via yb-ts-cli without downtime. Cluster Restart stops all nodes, updates yugabyted.conf, and starts them back — guaranteeing the flag persists."
      >
        <Form.Dropdown.Item value="runtime" title="Runtime (no restart)" icon={Icon.Bolt} />
        <Form.Dropdown.Item value="restart" title="Cluster Restart" icon={Icon.ArrowClockwise} />
      </Form.Dropdown>
    </Form>
  );
}
