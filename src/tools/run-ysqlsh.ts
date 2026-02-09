import { executeDockerCommand, getCluster, getClusterStatus } from "../utils/docker";

type Input = {
  /**
   * The name of the YugabyteDB cluster to run the YSQL query against.
   */
  clusterName: string;

  /**
   * The SQL query or ysqlsh command to execute.
   * Examples:
   *   "SELECT version();"
   *   "\\dt"
   *   "\\l"
   *   "SELECT * FROM pg_stat_activity;"
   *   "SELECT * FROM pg_tables WHERE schemaname = 'public';"
   *   "SELECT yb_servers();"
   *   "SELECT * FROM yb_local_tablets;"
   */
  query: string;

  /**
   * Optional: the database to connect to. Defaults to "yugabyte".
   */
  database?: string;
};

/**
 * Run a SQL query or ysqlsh meta-command inside a YugabyteDB cluster using ysqlsh (PostgreSQL-compatible shell).
 * Use this to query live data, inspect schema, check pg_catalog views, and run YugabyteDB-specific functions.
 *
 * Common queries:
 * - "SELECT version();" - Get YugabyteDB version
 * - "\\dt" - List tables in current database
 * - "\\l" - List all databases
 * - "\\d <table>" - Describe a table's schema
 * - "\\di" - List indexes
 * - "SELECT * FROM pg_stat_activity;" - Show active connections
 * - "SELECT * FROM pg_tables WHERE schemaname = 'public';" - List user tables
 * - "SELECT yb_servers();" - List YugabyteDB server info
 * - "SELECT * FROM yb_local_tablets;" - List local tablet info
 * - "SELECT * FROM pg_stat_user_tables;" - Table statistics
 * - "SELECT pg_size_pretty(pg_database_size(current_database()));" - Database size
 * - "EXPLAIN ANALYZE <query>;" - Query execution plan
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
  const database = input.database || "yugabyte";

  // Escape single quotes in the query for the shell
  const escapedQuery = input.query.replace(/'/g, "'\\''");

  const cmd = `docker exec ${containerName} bin/ysqlsh -h ${containerName} -d ${database} -c '${escapedQuery}'`;

  try {
    const { stdout, stderr } = await executeDockerCommand(cmd);
    const output = (stdout || "").trim();
    const errors = (stderr || "").trim();

    if (!output && errors) {
      return {
        clusterName: input.clusterName,
        database,
        query: input.query,
        error: errors,
      };
    }

    return {
      clusterName: input.clusterName,
      database,
      query: input.query,
      output,
      ...(errors ? { warnings: errors } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      clusterName: input.clusterName,
      database,
      query: input.query,
      error: `Failed to run ysqlsh: ${msg.substring(0, 500)}`,
    };
  }
}
