import { getClusterServices } from "../utils/docker";
import { getProxyPort } from "../utils/proxy";

type Input = {
  /**
   * The name of the YugabyteDB cluster to check services for.
   */
  name: string;
};

/**
 * Get live service status for each node in a YugabyteDB cluster,
 * including which processes (yugabyted, yb-master, yb-tserver) are running.
 */
export default async function tool(input: Input) {
  const services = await getClusterServices(input.name);

  if (services.length === 0) {
    return { error: `No services found for cluster "${input.name}". The cluster may be stopped or not exist.` };
  }

  const proxyPort = getProxyPort();
  const proxyBase = `http://localhost:${proxyPort}`;

  return services.map((s) => ({
    nodeNumber: s.nodeNumber,
    containerName: s.containerName,
    processes: {
      yugabyted: s.services.yugabyted?.running ?? false,
      ybMaster: s.services.ybMaster?.running ?? false,
      ybTserver: s.services.ybTserver?.running ?? false,
    },
    ports: {
      ysql: s.ports.ysql,
      ycql: s.ports.ycql,
      yugabytedUI: s.ports.yugabytedUI,
      masterUI: s.ports.masterUI,
      tserverUI: s.ports.tserverUI,
    },
    proxyUrls: {
      masterUI: `${proxyBase}/proxy/${s.containerName}:7000/`,
      tserverUI: `${proxyBase}/proxy/${s.containerName}:9000/`,
      yugabytedUI: `${proxyBase}/proxy/${s.containerName}:15433/`,
      masterRpcUI: `${proxyBase}/proxy/${s.containerName}:7100/`,
      tserverRpcUI: `${proxyBase}/proxy/${s.containerName}:9100/`,
    },
  }));
}
