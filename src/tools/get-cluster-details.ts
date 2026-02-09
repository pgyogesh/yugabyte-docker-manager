import { getCluster, getClusterStatus } from "../utils/docker";

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

  const nodes = (cluster.nodePorts ?? []).map((ports, i) => ({
    nodeNumber: i + 1,
    containerName: `yb-${input.name}-node${i + 1}`,
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
    connectionStrings: {
      ysqlDocker: `docker exec -it yb-${input.name}-node${i + 1} bin/ysqlsh -h yb-${input.name}-node${i + 1}`,
      ysqlLocal: `psql -h localhost -p ${ports.ysql} -U yugabyte`,
      ycqlDocker: `docker exec -it yb-${input.name}-node${i + 1} bin/ycqlsh yb-${input.name}-node${i + 1}`,
      ycqlLocal: `cqlsh localhost ${ports.ycql}`,
    },
    dataPath: `~/yb_docker_data_${input.name}/node${i + 1}/`,
  }));

  return {
    name: cluster.name,
    status,
    version: cluster.version,
    totalNodes: cluster.nodes,
    masterGFlags: cluster.masterGFlags || "none",
    tserverGFlags: cluster.tserverGFlags || "none",
    networkName: `yb-${input.name}-network`,
    nodes,
  };
}
