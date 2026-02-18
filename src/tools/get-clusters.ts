import { getAllClusters, getClusterStatus } from "../utils/docker";
import { getProxyPort } from "../utils/proxy";

/**
 * Get a list of all YugabyteDB clusters managed by this extension,
 * including their current status, node count, version, and primary ports.
 */
export default async function tool() {
  const clusters = await getAllClusters();
  const proxyPort = getProxyPort();
  const proxyBase = `http://localhost:${proxyPort}`;

  const results = await Promise.all(
    clusters.map(async (c) => {
      const status = await getClusterStatus(c.name).catch(() => "stopped" as const);
      const firstPorts = c.nodePorts?.[0];
      const firstContainer = `yb-${c.name}-node1`;
      return {
        name: c.name,
        nodes: c.nodes,
        version: c.version,
        status,
        ysqlPort: firstPorts?.ysql ?? null,
        ycqlPort: firstPorts?.ycql ?? null,
        yugabytedUIUrl: firstPorts ? `http://localhost:${firstPorts.yugabytedUI}` : null,
        masterUIUrl: firstPorts ? `http://localhost:${firstPorts.masterUI}` : null,
        proxyUrls: {
          masterUI: `${proxyBase}/proxy/${firstContainer}:7000/`,
          tserverUI: `${proxyBase}/proxy/${firstContainer}:9000/`,
          yugabytedUI: `${proxyBase}/proxy/${firstContainer}:15433/`,
          masterRpcUI: `${proxyBase}/proxy/${firstContainer}:7100/`,
          tserverRpcUI: `${proxyBase}/proxy/${firstContainer}:9100/`,
        },
      };
    }),
  );
  return results;
}
