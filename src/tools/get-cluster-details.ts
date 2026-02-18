import { getCluster, getClusterStatus } from "../utils/docker";
import { getProxyPort } from "../utils/proxy";

type Input = {
  /**
   * The name of the YugabyteDB cluster to get details for.
   */
  name: string;
};

/**
 * Get detailed configuration for a specific YugabyteDB cluster
 * including all node ports, GFlags, connection strings, and data paths.
 */
export default async function tool(input: Input) {
  const cluster = await getCluster(input.name);
  if (!cluster) {
    return { error: `Cluster "${input.name}" not found` };
  }

  const status = await getClusterStatus(input.name).catch(() => "stopped" as const);
  const proxyPort = getProxyPort();
  const proxyBase = `http://localhost:${proxyPort}`;

  const nodes = (cluster.nodePorts ?? []).map((ports, i) => {
    const containerName = `yb-${input.name}-node${i + 1}`;
    return {
      nodeNumber: i + 1,
      containerName,
      ports: {
        ysql: ports.ysql,
        ycql: ports.ycql,
        yugabytedUI: ports.yugabytedUI,
        masterUI: ports.masterUI,
        tserverUI: ports.tserverUI,
      },
      urls: {
        yugabytedUI: `http://localhost:${ports.yugabytedUI}`,
        masterUI: `http://localhost:${ports.masterUI}`,
        tserverUI: `http://localhost:${ports.tserverUI}`,
      },
      proxyUrls: {
        masterUI: `${proxyBase}/proxy/${containerName}:7000/`,
        tserverUI: `${proxyBase}/proxy/${containerName}:9000/`,
        yugabytedUI: `${proxyBase}/proxy/${containerName}:15433/`,
        masterRpcUI: `${proxyBase}/proxy/${containerName}:7100/`,
        tserverRpcUI: `${proxyBase}/proxy/${containerName}:9100/`,
      },
      connectionStrings: {
        ysqlDocker: `docker exec -it ${containerName} bin/ysqlsh -h ${containerName}`,
        ysqlLocal: `psql -h localhost -p ${ports.ysql} -U yugabyte`,
        ycqlDocker: `docker exec -it ${containerName} bin/ycqlsh ${containerName}`,
        ycqlLocal: `cqlsh localhost ${ports.ycql}`,
      },
      dataPath: `~/yb_docker_data_${input.name}/node${i + 1}/`,
    };
  });

  return {
    name: cluster.name,
    status,
    version: cluster.version,
    totalNodes: cluster.nodes,
    masterGFlags: cluster.masterGFlags || "none",
    tserverGFlags: cluster.tserverGFlags || "none",
    networkName: `yb-${input.name}-network`,
    proxyLandingPage: proxyBase,
    nodes,
  };
}
