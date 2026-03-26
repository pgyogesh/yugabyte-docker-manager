import { createYugabyteCluster, getAllClusters } from "../utils/docker";

type Input = {
  /**
   * The name for the new YugabyteDB cluster.
   * Must be lowercase letters, numbers, and hyphens only, starting with a letter or number.
   * Examples: "my-cluster", "source", "target", "test-db"
   */
  name: string;

  /**
   * Number of nodes in the cluster (1-10).
   * Use 1 for quick development, 3 for testing replication and fault tolerance.
   * Defaults to 3 if not specified.
   */
  nodes?: number;

  /**
   * YugabyteDB Docker image version tag.
   * Examples: "latest", "2024.2.3.0-b37", "2.25.1.0-b185"
   * Defaults to "latest" if not specified.
   */
  version?: string;

  /**
   * Optional master GFlags as a comma-separated or newline-separated string.
   * Example: "max_log_size=256,log_min_seconds_to_retain=3600"
   */
  masterGFlags?: string;

  /**
   * Optional tserver GFlags as a comma-separated or newline-separated string.
   * Example: "ysql_max_connections=400"
   */
  tserverGFlags?: string;
};

/**
 * Create a new YugabyteDB cluster with Docker containers.
 * This provisions a multi-node cluster with a dedicated Docker network,
 * persistent data volumes, and all YugabyteDB services (YSQL, YCQL, master, tserver).
 *
 * Use this tool when the user asks to:
 * - Create a new YugabyteDB cluster
 * - Set up a new database cluster
 * - Spin up a YugabyteDB environment
 * - Create source/target clusters for replication testing
 *
 * After creation, all clusters share a common Docker network so containers
 * from different clusters can communicate with each other (useful for xCluster replication).
 */
export default async function tool(input: Input) {
  const name = input.name?.trim();
  if (!name) {
    return { error: "Cluster name is required" };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { error: "Cluster name must contain only lowercase letters, numbers, and hyphens, and start with a letter or number" };
  }

  const nodes = input.nodes ?? 3;
  if (nodes < 1 || nodes > 10) {
    return { error: "Number of nodes must be between 1 and 10" };
  }

  const version = input.version?.trim() || "latest";

  const existing = await getAllClusters();
  if (existing.some((c) => c.name === name)) {
    return { error: `Cluster "${name}" already exists. Delete it first or choose a different name.` };
  }

  try {
    await createYugabyteCluster(
      name,
      nodes,
      version,
      input.masterGFlags?.trim() || undefined,
      input.tserverGFlags?.trim() || undefined,
    );

    return {
      success: true,
      name,
      nodes,
      version,
      message: `Cluster "${name}" created successfully with ${nodes} node(s) running YugabyteDB ${version}`,
      containers: Array.from({ length: nodes }, (_, i) => `yb-${name}-node${i + 1}`),
      network: `yb-${name}-network`,
      connectionHint: `Connect via: docker exec -it yb-${name}-node1 bin/ysqlsh -h yb-${name}-node1`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      error: `Failed to create cluster "${name}": ${msg.substring(0, 500)}`,
    };
  }
}
