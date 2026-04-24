import { Action, ActionPanel, Form, showToast, Toast, Icon, launchCommand, LaunchType } from "@raycast/api";
import { useForm } from "@raycast/utils";
import { useMemo, useRef, useState } from "react";
import { createYugabyteCluster } from "./utils/docker";
import { useDockerHubReleases } from "./hooks/useDockerHubReleases";
import { ProgressCallback, ClusterPlacement } from "./types";
import {
  CLOUDS,
  Cloud,
  FaultTolerance,
  FAULT_TOLERANCE_OPTIONS,
  PLACEMENT_CATALOG,
  decodeZone,
  encodeZone,
  minimumZonesFor,
} from "./utils/placement";

interface CreateClusterValues {
  name: string;
  nodes: string;
  version: string;
  masterGFlags: string;
  tserverGFlags: string;
}

const DEFAULT_CLOUD: Cloud = "aws";
const DEFAULT_FT: FaultTolerance = "zone";
const DEFAULT_ZONES = PLACEMENT_CATALOG[DEFAULT_CLOUD].filter((z) => z.region === "us-west-1").map(encodeZone);

export default function Command() {
  const { releases, isLoading: isLoadingReleases, revalidate: refreshReleases } = useDockerHubReleases();
  const toastRef = useRef<Toast | null>(null);
  const isSubmittingRef = useRef(false);

  const [cloud, setCloud] = useState<Cloud>(DEFAULT_CLOUD);
  const [selectedZones, setSelectedZones] = useState<string[]>(DEFAULT_ZONES);
  const [faultTolerance, setFaultTolerance] = useState<FaultTolerance>(DEFAULT_FT);

  const availableZones = useMemo(() => PLACEMENT_CATALOG[cloud], [cloud]);

  const handleCloudChange = (value: string) => {
    const next = value as Cloud;
    setCloud(next);
    setSelectedZones((prev) => {
      const validTokens = new Set(PLACEMENT_CATALOG[next].map(encodeZone));
      const retained = prev.filter((t) => validTokens.has(t));
      if (retained.length > 0) return retained;
      return PLACEMENT_CATALOG[next].slice(0, 3).map(encodeZone);
    });
  };

  const { handleSubmit, itemProps } = useForm<CreateClusterValues>({
    async onSubmit(values) {
      if (isSubmittingRef.current) return;

      const name = values.name.trim();
      const nodes = parseInt(values.nodes, 10);
      const version = values.version.trim() || "latest";
      const masterGFlags = values.masterGFlags?.trim() || undefined;
      const tserverGFlags = values.tserverGFlags?.trim() || undefined;

      const decodedZones = selectedZones
        .map(decodeZone)
        .filter((z): z is { region: string; zone: string } => z !== null);

      if (decodedZones.length === 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Select at least one zone",
          message: `Pick one or more zones from the ${cloud.toUpperCase()} catalog`,
        });
        return;
      }

      const minZones = minimumZonesFor(faultTolerance);
      if (decodedZones.length < minZones) {
        await showToast({
          style: Toast.Style.Failure,
          title: `Fault tolerance "${faultTolerance}" needs ${minZones}+ zones`,
          message: `Currently ${decodedZones.length} selected. Add more zones or set Fault Tolerance to None.`,
        });
        return;
      }

      if (faultTolerance === "region") {
        const distinctRegions = new Set(decodedZones.map((z) => z.region));
        if (distinctRegions.size < 3) {
          await showToast({
            style: Toast.Style.Failure,
            title: "Region-level FT needs 3+ distinct regions",
            message: `Currently ${distinctRegions.size} region(s) across selected zones.`,
          });
          return;
        }
      }

      const placement: ClusterPlacement = {
        cloud,
        zones: decodedZones,
        faultTolerance,
      };

      isSubmittingRef.current = true;

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
          placement: "Configuring Data Placement",
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
        await createYugabyteCluster(name, nodes, version, masterGFlags, tserverGFlags, progressCallback, placement);

        toastRef.current?.hide();
        await showToast({
          style: Toast.Style.Success,
          title: "Cluster Created",
          message: `"${name}" created successfully with ${nodes} node(s)`,
        });

        try {
          await launchCommand({ name: "manage-clusters", type: LaunchType.UserInitiated });
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
      <Form.Description
        title="Placement"
        text="YBA-style dummy cloud/region/zone selector. Selected zones are distributed round-robin across nodes via --cloud_location."
      />
      <Form.Dropdown
        id="cloud"
        title="Cloud Provider"
        value={cloud}
        onChange={handleCloudChange}
        info="Dummy cloud — values are cosmetic and passed to yugabyted as --cloud_location=<cloud>.<region>.<zone>."
      >
        {CLOUDS.map((c) => (
          <Form.Dropdown.Item key={c.value} value={c.value} title={c.label} />
        ))}
      </Form.Dropdown>
      <Form.TagPicker
        id="zones"
        title="Zones"
        value={selectedZones}
        onChange={setSelectedZones}
        info="Pick one or more zones from the selected cloud. Nodes are distributed round-robin across zones (node i → zones[i % zones.length])."
      >
        {availableZones.map((z) => {
          const token = encodeZone(z);
          return <Form.TagPicker.Item key={token} value={token} title={`${z.region} / ${z.zone}`} />;
        })}
      </Form.TagPicker>
      <Form.Dropdown
        id="faultTolerance"
        title="Fault Tolerance"
        value={faultTolerance}
        onChange={(v) => setFaultTolerance(v as FaultTolerance)}
        info="Applied via `yugabyted configure data_placement --fault_tolerance=<level>` after the cluster is up. Zone/region/cloud FT require 3+ distinct zones."
      >
        {FAULT_TOLERANCE_OPTIONS.map((ft) => (
          <Form.Dropdown.Item key={ft.value} value={ft.value} title={ft.label} />
        ))}
      </Form.Dropdown>
      <Form.Separator />
      <Form.TextArea
        title="Master GFlags (Optional)"
        placeholder={`max_log_size=256\nlog_min_seconds_to_retain=3600`}
        info="One flag per line in name=value format. No special escaping needed — commas in values are preserved as-is."
        {...itemProps.masterGFlags}
      />
      <Form.TextArea
        title="TServer GFlags (Optional)"
        placeholder={`ysql_max_connections=400\nysql_pg_conf_csv="shared_preload_libraries=passwordcheck,auto_explain",pgaudit.log=ROLE`}
        info="One flag per line in name=value format. For CSV flags like ysql_pg_conf_csv, just write the value as-is — commas within the value are handled automatically."
        {...itemProps.tserverGFlags}
      />
    </Form>
  );
}
