import { executeDockerCommand, getCluster, getClusterStatus } from "../utils/docker";

type Input = {
  /**
   * The name of the YugabyteDB cluster to run the yb-ts-cli command against.
   */
  clusterName: string;

  /**
   * The yb-ts-cli sub-command and its arguments to execute.
   * Examples:
   *   "list_tablets"
   *   "status"
   *   "current_hybrid_time"
   *   "count_intents"
   *   "dump_tablet <tablet_id>"
   *   "are_tablets_running"
   *   "is_server_ready"
   *   "list_maintenance_windows"
   */
  subcommand: string;

  /**
   * Optional: the node number (1-based) to run the command on. Defaults to 1.
   * Some commands may return different results per node (e.g. list_tablets shows only that node's tablets).
   */
  nodeNumber?: number;
};

/**
 * Run a yb-ts-cli (tablet server CLI) command inside a YugabyteDB cluster container.
 * Use this for tablet-server-level diagnostics like listing tablets, checking server readiness,
 * hybrid timestamps, intent counts, and tablet-level operations.
 *
 * Common sub-commands:
 * - list_tablets: List all tablets on this tserver with their status and table
 * - status: Get tserver status and version info
 * - current_hybrid_time: Get current hybrid timestamp
 * - count_intents: Count pending transaction intents
 * - are_tablets_running: Check if all tablets are in RUNNING state
 * - is_server_ready: Check if the tserver is ready to serve
 * - dump_tablet <tablet_id>: Dump contents of a specific tablet
 * - list_maintenance_windows: Show active maintenance windows
 */
export default async function tool(input: Input) {
  const cluster = await getCluster(input.clusterName);
  if (!cluster) {
    return { error: `Cluster "${input.clusterName}" not found` };
  }

  const status = await getClusterStatus(input.clusterName).catch(() => "stopped" as const);
  if (status !== "running") {
    return { error: `Cluster "${input.clusterName}" is not running. Start it first.` };
  }

  const nodeNum = input.nodeNumber ?? 1;
  if (nodeNum < 1 || nodeNum > (cluster.nodes ?? 1)) {
    return { error: `Node ${nodeNum} does not exist. Cluster has ${cluster.nodes} node(s).` };
  }

  const containerName = `yb-${input.clusterName}-node${nodeNum}`;
  // yb-ts-cli connects to tserver RPC port 9100
  const serverAddress = `${containerName}:9100`;

  const cmd = `docker exec ${containerName} /home/yugabyte/bin/yb-ts-cli -server_address ${serverAddress} ${input.subcommand}`;

  try {
    const { stdout, stderr } = await executeDockerCommand(cmd);
    const output = (stdout || "").trim();
    const errors = (stderr || "").trim();

    if (!output && errors) {
      return {
        clusterName: input.clusterName,
        node: nodeNum,
        subcommand: input.subcommand,
        error: errors,
      };
    }

    return {
      clusterName: input.clusterName,
      node: nodeNum,
      subcommand: input.subcommand,
      output,
      ...(errors ? { warnings: errors } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      clusterName: input.clusterName,
      node: nodeNum,
      subcommand: input.subcommand,
      error: `Failed to run yb-ts-cli: ${msg.substring(0, 500)}`,
    };
  }
}
