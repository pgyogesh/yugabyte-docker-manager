import { executeDockerCommand, getCluster, getClusterStatus } from "../utils/docker";

type Input = {
  /**
   * The name of the YugabyteDB cluster to run the yugabyted command against.
   */
  clusterName: string;

  /**
   * The yugabyted sub-command and its arguments to execute.
   * Examples:
   *   "status"
   *   "status --master"
   *   "status --tserver"
   *   "collect_logs"
   *   "configure data_placement --fault_tolerance zone"
   *   "cert list"
   */
  subcommand: string;

  /**
   * Optional node number to target (defaults to 1).
   * Each cluster node runs its own yugabyted process.
   */
  nodeNumber?: number;
};

/**
 * Run a yugabyted command inside a YugabyteDB cluster container.
 * yugabyted is the single-binary management tool for YugabyteDB that controls
 * the node lifecycle, status reporting, log collection, and cluster configuration.
 *
 * Common sub-commands:
 * - status: Show overall node status (master, tserver, UI URLs)
 * - status --master: Show master process status
 * - status --tserver: Show tserver process status
 * - collect_logs: Collect and package node logs for troubleshooting
 * - configure data_placement: Configure data placement and fault tolerance
 * - cert list: List TLS certificates
 * - cert generate_server_certs: Generate server TLS certificates
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
  const totalNodes = cluster.nodes ?? 1;
  if (nodeNum < 1 || nodeNum > totalNodes) {
    return { error: `Invalid node number ${nodeNum}. Cluster "${input.clusterName}" has ${totalNodes} node(s).` };
  }

  const containerName = `yb-${input.clusterName}-node${nodeNum}`;
  const cmd = `docker exec ${containerName} /home/yugabyte/bin/yugabyted ${input.subcommand} --base_dir=/home/yugabyte/yb_data`;

  try {
    const { stdout, stderr } = await executeDockerCommand(cmd);
    const output = (stdout || "").trim();
    const errors = (stderr || "").trim();

    if (!output && errors) {
      return {
        clusterName: input.clusterName,
        nodeNumber: nodeNum,
        subcommand: input.subcommand,
        error: errors,
      };
    }

    return {
      clusterName: input.clusterName,
      nodeNumber: nodeNum,
      subcommand: input.subcommand,
      output,
      ...(errors ? { warnings: errors } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      clusterName: input.clusterName,
      nodeNumber: nodeNum,
      subcommand: input.subcommand,
      error: `Failed to run yugabyted: ${msg.substring(0, 500)}`,
    };
  }
}
