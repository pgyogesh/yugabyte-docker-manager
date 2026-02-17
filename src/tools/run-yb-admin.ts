import { executeDockerCommand, getCluster, getClusterStatus } from "../utils/docker";

type Input = {
  /**
   * The name of the YugabyteDB cluster to run the yb-admin command against.
   */
  clusterName: string;

  /**
   * The yb-admin sub-command and its arguments to execute.
   * Examples:
   *   "list_all_masters"
   *   "list_all_tablet_servers"
   *   "get_universe_config"
   *   "list_tables include_table_id include_table_type"
   *   "list_tablets ysql.yugabyte <table_name>"
   *   "get_load_move_completion"
   *   "get_is_load_balanced"
   *   "list_namespaces"
   *   "get_auto_flags_config"
   */
  subcommand: string;
};

/**
 * Run a yb-admin command inside a YugabyteDB cluster container to get live cluster
 * administration details such as master/tserver lists, tablet info, table metadata,
 * load balancer status, universe config, replication info, and more.
 *
 * Common sub-commands:
 * - list_all_masters: Show all master nodes
 * - list_all_tablet_servers: Show all tablet server nodes
 * - get_universe_config: Get cluster universe configuration
 * - list_tables include_table_id include_table_type: List all tables
 * - list_tablets ysql.yugabyte <table>: List tablets for a table
 * - get_load_move_completion: Check load balancer progress
 * - get_is_load_balanced: Check if load is balanced
 * - list_namespaces: List all databases/keyspaces
 * - get_auto_flags_config: Get auto-flags configuration
 * - list_snapshots: List snapshots
 * - get_cluster_config: Get cluster configuration
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

  const containerName = `yb-${input.clusterName}-node1`;
  // Build comma-separated master addresses for all nodes (each runs a master on internal port 7100)
  const totalNodes = cluster.nodes ?? 1;
  const masterAddresses = Array.from({ length: totalNodes }, (_, i) => `yb-${input.clusterName}-node${i + 1}:7100`).join(
    ",",
  );

  const cmd = `docker exec ${containerName} /home/yugabyte/bin/yb-admin -master_addresses ${masterAddresses} ${input.subcommand}`;

  try {
    const { stdout, stderr } = await executeDockerCommand(cmd);
    const output = (stdout || "").trim();
    const errors = (stderr || "").trim();

    if (!output && errors) {
      return {
        clusterName: input.clusterName,
        subcommand: input.subcommand,
        error: errors,
      };
    }

    return {
      clusterName: input.clusterName,
      subcommand: input.subcommand,
      output,
      ...(errors ? { warnings: errors } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      clusterName: input.clusterName,
      subcommand: input.subcommand,
      error: `Failed to run yb-admin: ${msg.substring(0, 500)}`,
    };
  }
}
