import { getAllClusters, getClusterStatus } from "../utils/docker";

/**
 * Get a list of all YugabyteDB clusters managed by this extension,
 * including their current status, node count, version, and primary ports.
 */
export default async function tool() {
  const clusters = await getAllClusters();
  const results = await Promise.all(
    clusters.map(async (c) => {
      const status = await getClusterStatus(c.name).catch(() => "stopped" as const);
      const firstPorts = c.nodePorts?.[0];
      return {
        name: c.name,
        nodes: c.nodes,
        version: c.version,
        status,
        ysqlPort: firstPorts?.ysql ?? null,
        ycqlPort: firstPorts?.ycql ?? null,
        yugabytedUIUrl: firstPorts ? `http://localhost:${firstPorts.yugabytedUI}` : null,
        masterUIUrl: firstPorts ? `http://localhost:${firstPorts.masterUI}` : null,
      };
    }),
  );
  return results;
}
