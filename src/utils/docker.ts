import { exec } from "child_process";
import { promisify } from "util";
import { NodePorts, ClusterInfo, ClusterCreationProgress, ProgressCallback, ClusterService } from "../types";

// Re-export types so existing consumers don't break
export type { NodePorts, ClusterInfo, ClusterCreationProgress, ProgressCallback, ClusterService };

const execAsync = promisify(exec);

const CLUSTER_STORAGE_FILE = `${process.env.HOME}/.yugabyte-clusters.json`;

// ---------------------------------------------------------------------------
// Cluster storage (JSON file)
// ---------------------------------------------------------------------------

async function readClusters(): Promise<Record<string, ClusterInfo>> {
  try {
    const fs = await import("fs/promises");
    const data = await fs.readFile(CLUSTER_STORAGE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeClusters(clusters: Record<string, ClusterInfo>): Promise<void> {
  const fs = await import("fs/promises");
  await fs.writeFile(CLUSTER_STORAGE_FILE, JSON.stringify(clusters, null, 2), "utf-8");
}

export async function saveCluster(cluster: ClusterInfo): Promise<void> {
  const clusters = await readClusters();
  clusters[cluster.name] = cluster;
  await writeClusters(clusters);
}

export async function getAllClusters(): Promise<ClusterInfo[]> {
  const clusters = await readClusters();
  return Object.values(clusters);
}

export async function getCluster(name: string): Promise<ClusterInfo | null> {
  const clusters = await readClusters();
  return clusters[name] || null;
}

export async function deleteCluster(name: string): Promise<void> {
  const clusters = await readClusters();
  delete clusters[name];
  await writeClusters(clusters);
}

export async function updateClusterStatus(name: string, status: "running" | "stopped"): Promise<void> {
  const clusters = await readClusters();
  if (clusters[name]) {
    clusters[name].status = status;
    await writeClusters(clusters);
  }
}

// ---------------------------------------------------------------------------
// Docker command execution
// ---------------------------------------------------------------------------

export async function executeDockerCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execAsync(command);
    return result;
  } catch (error: unknown) {
    const err = error as { message?: string; stdout?: string; stderr?: string; code?: number | string };
    const stdout = err.stdout || "";
    const stderr = err.stderr || "";
    const errorCode = err.code || "unknown";

    let errorMsg = `Docker command failed: ${err.message || "Unknown error"}`;
    if (stderr) errorMsg += `\nDocker stderr: ${stderr}`;
    if (stdout) errorMsg += `\nDocker stdout: ${stdout}`;
    errorMsg += `\nExit code: ${errorCode}`;

    console.error(`[Docker] Command failed: ${command.substring(0, 120)}`);
    if (stderr) console.error(`[Docker] stderr: ${stderr.substring(0, 300)}`);

    const enhancedError = new Error(errorMsg);
    (enhancedError as Record<string, unknown>).stdout = stdout;
    (enhancedError as Record<string, unknown>).stderr = stderr;
    (enhancedError as Record<string, unknown>).code = errorCode;
    throw enhancedError;
  }
}

// ---------------------------------------------------------------------------
// Port checking & assignment
// ---------------------------------------------------------------------------

async function isPortAvailable(port: number): Promise<boolean> {
  // Check Docker containers (running + stopped)
  try {
    const { stdout } = await executeDockerCommand(`docker ps -a --format "{{.Ports}}" 2>/dev/null || echo ""`);
    if (
      stdout.includes(`:${port}->`) ||
      stdout.includes(`:${port}/tcp`) ||
      stdout.match(new RegExp(`[^0-9]${port}->`))
    ) {
      return false;
    }
  } catch {
    // Continue to lsof check
  }

  // Check with lsof
  try {
    const lsofResult = await execAsync(`lsof -ti:${port} 2>&1`);
    const output = (lsofResult.stdout || "").trim();
    if (output && /^\d+$/.test(output)) {
      return false;
    }
  } catch (lsofError: unknown) {
    const err = lsofError as { code?: number; stdout?: string; stderr?: string };
    if (err.code === 1) return true; // Port not in use
    const errorOutput = (err.stdout || err.stderr || "").trim();
    if (errorOutput && /^\d+$/.test(errorOutput)) return false;
    return true; // Assume available on unexpected errors
  }

  return true;
}

async function findAvailablePortSet(startOffset: number, claimedPorts: Set<number>): Promise<NodePorts> {
  let offset = startOffset;
  const maxOffset = 1000;

  while (offset < maxOffset) {
    const ports: NodePorts = {
      yugabytedUI: 15433 + offset,
      masterUI: 7000 + offset,
      tserverUI: 9000 + offset,
      ysql: 5433 + offset,
      ycql: 9042 + offset,
    };

    // Skip if any port in this set was already claimed in this batch
    const allPortValues = [ports.yugabytedUI, ports.masterUI, ports.tserverUI, ports.ysql, ports.ycql];
    if (allPortValues.some((p) => claimedPorts.has(p))) {
      offset++;
      continue;
    }

    const checks = await Promise.all([
      isPortAvailable(ports.yugabytedUI),
      isPortAvailable(ports.masterUI),
      isPortAvailable(ports.tserverUI),
      isPortAvailable(ports.ysql),
      isPortAvailable(ports.ycql),
    ]);

    if (checks.every(Boolean)) {
      return ports;
    }
    offset++;
  }

  throw new Error(`Could not find available port set after checking ${maxOffset} offsets`);
}

export async function findAvailablePortsForNodes(nodes: number): Promise<NodePorts[]> {
  const nodePorts: NodePorts[] = [];
  const claimedPorts = new Set<number>();

  for (let i = 0; i < nodes; i++) {
    const ports = await findAvailablePortSet(i, claimedPorts);
    nodePorts.push(ports);
    // Track all ports from this set so subsequent nodes won't reuse them
    claimedPorts.add(ports.yugabytedUI);
    claimedPorts.add(ports.masterUI);
    claimedPorts.add(ports.tserverUI);
    claimedPorts.add(ports.ysql);
    claimedPorts.add(ports.ycql);
  }
  return nodePorts;
}

// ---------------------------------------------------------------------------
// Cluster creation
// ---------------------------------------------------------------------------

export async function createYugabyteCluster(
  name: string,
  nodes: number,
  version: string,
  masterGFlags?: string,
  tserverGFlags?: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  onProgress?.({ stage: "checking", message: "Finding available ports..." });
  const nodePorts = await findAvailablePortsForNodes(nodes);

  // Clean up existing containers with the same name pattern
  onProgress?.({ stage: "cleanup", message: "Cleaning up existing containers..." });
  try {
    const existing = await executeDockerCommand(
      `docker ps -a --filter "name=^yb-${name}-node" --format "{{.Names}}" 2>/dev/null || echo ""`,
    );
    if (existing.stdout?.trim()) {
      for (const c of existing.stdout.trim().split("\n").filter(Boolean)) {
        try {
          await executeDockerCommand(`docker rm -f ${c} 2>/dev/null || true`);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  const networkName = `yb-${name}-network`;
  try {
    await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
  } catch {
    /* ignore */
  }

  // Pull image if needed
  onProgress?.({ stage: "image", message: `Checking for YugabyteDB image (${version})...` });
  await ensureImage(version, onProgress);

  // Create cluster
  onProgress?.({ stage: "network", message: "Creating Docker network..." });
  const createdContainers: string[] = [];

  try {
    await createYugabytedCluster(
      name,
      nodes,
      version,
      createdContainers,
      masterGFlags,
      tserverGFlags,
      onProgress,
      nodePorts,
    );
  } catch (error) {
    // Rollback
    for (const container of createdContainers) {
      try {
        await executeDockerCommand(`docker rm -f ${container} 2>/dev/null || true`);
      } catch {
        /* ignore */
      }
    }
    try {
      await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
    } catch {
      /* ignore */
    }
    throw error;
  }

  onProgress?.({ stage: "finalize", message: "Finalizing cluster formation..." });
  await new Promise((resolve) => setTimeout(resolve, 5000));

  onProgress?.({ stage: "complete", message: "Cluster created successfully!" });
  await saveCluster({ name, nodes, version, status: "running", masterGFlags, tserverGFlags, nodePorts });
}

async function ensureImage(version: string, onProgress?: ProgressCallback): Promise<void> {
  try {
    await executeDockerCommand(`docker image inspect yugabytedb/yugabyte:${version} 2>/dev/null`);
    onProgress?.({ stage: "image", message: "Image found locally" });
    return;
  } catch {
    // Not found locally
  }

  onProgress?.({ stage: "image", message: `Pulling YugabyteDB image (${version})...` });
  try {
    await executeDockerCommand(`docker pull yugabytedb/yugabyte:${version}`);
    onProgress?.({ stage: "image", message: "Image pulled successfully" });
  } catch (pullError: unknown) {
    const err = pullError as { stderr?: string; message?: string };
    const errorMsg = err.stderr || err.message || "Unknown error";
    if (errorMsg.includes("docker-credential-desktop") || errorMsg.includes("credentials")) {
      // Credential helper workaround
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const os = await import("os");
        const tempDir = path.join(os.tmpdir(), `yugabyte-docker-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(path.join(tempDir, "config.json"), JSON.stringify({}), "utf-8");
        const env = { ...process.env, DOCKER_CONFIG: tempDir };
        await execAsync(`docker pull yugabytedb/yugabyte:${version}`, { env });
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        throw new Error(
          `Docker credential helper error. Please fix Docker configuration or manually pull the image. Run: docker pull yugabytedb/yugabyte:${version}`,
        );
      }
    } else {
      throw new Error(`Failed to pull Docker image: ${errorMsg}`);
    }
  }
}

function processGFlags(flags: string): string {
  return flags
    .trim()
    .split(/[\s,\n]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map((f) => f.replace(/^--+/, ""))
    .join(",");
}

async function createYugabytedCluster(
  name: string,
  nodes: number,
  version: string,
  createdContainers: string[],
  masterGFlags?: string,
  tserverGFlags?: string,
  onProgress?: ProgressCallback,
  nodePorts?: NodePorts[],
): Promise<void> {
  const networkName = `yb-${name}-network`;

  try {
    await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
  } catch {
    /* ignore */
  }

  onProgress?.({ stage: "network", message: `Creating network: ${networkName}...` });
  await executeDockerCommand(`docker network create ${networkName} 2>&1`);

  const firstNodeName = `yb-${name}-node1`;

  for (let i = 0; i < nodes; i++) {
    const nodeName = `yb-${name}-node${i + 1}`;
    const ports = nodePorts?.[i] ?? {
      yugabytedUI: 15433 + i,
      masterUI: 7000 + i,
      tserverUI: 9000 + i,
      ysql: 5433 + i,
      ycql: 9042 + i,
    };

    const os = await import("os");
    const path = await import("path");
    const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`, `node${i + 1}`);
    const containerDataDir = `/home/yugabyte/yb_data`;

    onProgress?.({
      stage: "node",
      message: `Creating node ${i + 1} of ${nodes}...`,
      nodeNumber: i + 1,
      totalNodes: nodes,
    });

    // Build yugabyted args
    let yugabytedArgs = `--base_dir=${containerDataDir} --background=false`;
    if (i > 0) yugabytedArgs += ` --join=${firstNodeName}`;

    if (masterGFlags?.trim()) {
      const escaped = processGFlags(masterGFlags).replace(/"/g, '\\"');
      yugabytedArgs += ` --master_flags="${escaped}"`;
    }
    if (tserverGFlags?.trim()) {
      const escaped = processGFlags(tserverGFlags).replace(/"/g, '\\"');
      yugabytedArgs += ` --tserver_flags="${escaped}"`;
    }

    // Ensure data directory exists
    const fs = await import("fs/promises");
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch {
      /* ignore */
    }

    const cmd = `docker run -d --name ${nodeName} \
      --network ${networkName} \
      --hostname ${nodeName} \
      -p ${ports.yugabytedUI}:15433 \
      -p ${ports.masterUI}:7000 \
      -p ${ports.tserverUI}:9000 \
      -p ${ports.ysql}:5433 \
      -p ${ports.ycql}:9042 \
      -v ${dataDir}:${containerDataDir} \
      --restart unless-stopped \
      yugabytedb/yugabyte:${version} \
      bin/yugabyted start ${yugabytedArgs}`;

    await executeDockerCommand(cmd);
    createdContainers.push(nodeName);

    onProgress?.({
      stage: "node",
      message: `Node ${i + 1} container created, starting...`,
      nodeNumber: i + 1,
      totalNodes: nodes,
    });

    // Wait and verify
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await verifyContainerRunning(nodeName);

    // First node needs extra time to initialize
    if (i === 0) {
      onProgress?.({
        stage: "init",
        message: "Waiting for first node to initialize...",
        nodeNumber: 1,
        totalNodes: nodes,
      });
      await new Promise((resolve) => setTimeout(resolve, 15000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function verifyContainerRunning(nodeName: string): Promise<void> {
  let retries = 3;
  while (retries > 0) {
    try {
      const { stdout } = await executeDockerCommand(`docker ps --filter "name=${nodeName}" --format "{{.Status}}"`);
      if (stdout?.trim().includes("Up")) return;
    } catch {
      /* retry */
    }
    retries--;
    if (retries > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const logs = await executeDockerCommand(`docker logs ${nodeName} 2>&1`);
  throw new Error(`Container ${nodeName} stopped: ${logs.stdout || logs.stderr}`);
}

// ---------------------------------------------------------------------------
// Cluster lifecycle
// ---------------------------------------------------------------------------

async function getClusterContainers(name: string): Promise<string[]> {
  try {
    const { stdout } = await executeDockerCommand(
      `docker ps -a --filter "name=^yb-${name}-node" --format "{{.Names}}"`,
    );
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

export async function startCluster(name: string): Promise<void> {
  const containers = await getClusterContainers(name);
  for (const container of containers) {
    await executeDockerCommand(`docker start ${container} 2>/dev/null || true`);
  }
  await updateClusterStatus(name, "running");
}

export async function stopCluster(name: string): Promise<void> {
  const containers = await getClusterContainers(name);
  for (const container of containers) {
    await executeDockerCommand(`docker stop ${container} 2>/dev/null || true`);
  }
  await updateClusterStatus(name, "stopped");
}

export async function scaleCluster(name: string, targetNodes: number, onProgress?: ProgressCallback): Promise<void> {
  const cluster = await getCluster(name);
  if (!cluster) throw new Error(`Cluster "${name}" not found`);
  if (targetNodes === cluster.nodes) throw new Error(`Cluster already has ${targetNodes} nodes`);
  if (targetNodes < 1 || targetNodes > 10) throw new Error("Number of nodes must be between 1 and 10");
  if (cluster.status !== "running")
    throw new Error(`Cluster "${name}" must be running to scale. Please start it first.`);

  if (targetNodes > cluster.nodes) {
    await scaleUp(cluster, targetNodes, onProgress);
  } else {
    await scaleDown(cluster, targetNodes, onProgress);
  }
}

async function scaleUp(cluster: ClusterInfo, targetNodes: number, onProgress?: ProgressCallback): Promise<void> {
  const nodesToAdd = targetNodes - cluster.nodes;
  onProgress?.({ stage: "scaling", message: `Adding ${nodesToAdd} node(s) to cluster...` });

  const networkName = `yb-${cluster.name}-network`;
  const firstNodeName = `yb-${cluster.name}-node1`;
  const existingContainers = await getClusterContainers(cluster.name);
  const lastNodeNumber = existingContainers.length;

  const newNodePorts: NodePorts[] = [];
  const claimedPorts = new Set<number>();
  for (let i = 0; i < nodesToAdd; i++) {
    const ports = await findAvailablePortSet(lastNodeNumber + i, claimedPorts);
    newNodePorts.push(ports);
    claimedPorts.add(ports.yugabytedUI);
    claimedPorts.add(ports.masterUI);
    claimedPorts.add(ports.tserverUI);
    claimedPorts.add(ports.ysql);
    claimedPorts.add(ports.ycql);
  }

  for (let i = 0; i < nodesToAdd; i++) {
    const nodeNumber = lastNodeNumber + i + 1;
    const nodeName = `yb-${cluster.name}-node${nodeNumber}`;
    const ports = newNodePorts[i];

    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs/promises");
    const dataDir = path.join(os.homedir(), `yb_docker_data_${cluster.name}`, `node${nodeNumber}`);
    const containerDataDir = `/home/yugabyte/yb_data`;

    onProgress?.({
      stage: "scaling",
      message: `Creating node ${nodeNumber} of ${targetNodes}...`,
      nodeNumber,
      totalNodes: targetNodes,
    });

    let yugabytedArgs = `--base_dir=${containerDataDir} --background=false --join=${firstNodeName}`;
    if (cluster.masterGFlags?.trim()) {
      const escaped = processGFlags(cluster.masterGFlags).replace(/"/g, '\\"');
      yugabytedArgs += ` --master_flags="${escaped}"`;
    }
    if (cluster.tserverGFlags?.trim()) {
      const escaped = processGFlags(cluster.tserverGFlags).replace(/"/g, '\\"');
      yugabytedArgs += ` --tserver_flags="${escaped}"`;
    }

    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch {
      /* ignore */
    }

    const cmd = `docker run -d --name ${nodeName} \
      --network ${networkName} \
      --hostname ${nodeName} \
      -p ${ports.yugabytedUI}:15433 \
      -p ${ports.masterUI}:7000 \
      -p ${ports.tserverUI}:9000 \
      -p ${ports.ysql}:5433 \
      -p ${ports.ycql}:9042 \
      -v ${dataDir}:${containerDataDir} \
      --restart unless-stopped \
      yugabytedb/yugabyte:${cluster.version} \
      bin/yugabyted start ${yugabytedArgs}`;

    await executeDockerCommand(cmd);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await verifyContainerRunning(nodeName);

    if (i < nodesToAdd - 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  const updatedNodePorts = cluster.nodePorts ? [...cluster.nodePorts, ...newNodePorts] : newNodePorts;
  await saveCluster({ ...cluster, nodes: targetNodes, nodePorts: updatedNodePorts });
  onProgress?.({ stage: "complete", message: `Successfully scaled cluster to ${targetNodes} nodes` });
}

async function scaleDown(cluster: ClusterInfo, targetNodes: number, onProgress?: ProgressCallback): Promise<void> {
  const nodesToRemove = cluster.nodes - targetNodes;
  onProgress?.({ stage: "scaling", message: `Removing ${nodesToRemove} node(s) from cluster...` });

  const containers = await getClusterContainers(cluster.name);
  const containersToRemove = containers
    .sort((a, b) => {
      const aNum = parseInt(a.match(/node(\d+)/)?.[1] || "0", 10);
      const bNum = parseInt(b.match(/node(\d+)/)?.[1] || "0", 10);
      return bNum - aNum;
    })
    .slice(0, nodesToRemove);

  for (const containerName of containersToRemove) {
    const nodeMatch = containerName.match(/node(\d+)/);
    const nodeNum = nodeMatch ? parseInt(nodeMatch[1], 10) : 0;
    onProgress?.({ stage: "scaling", message: `Removing node ${nodeNum}...` });

    await executeDockerCommand(`docker stop ${containerName} 2>/dev/null || true`);
    await executeDockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);

    // Clean up data directory
    try {
      const os = await import("os");
      const path = await import("path");
      const fs = await import("fs/promises");
      const dataDir = path.join(os.homedir(), `yb_docker_data_${cluster.name}`, `node${nodeNum}`);
      await fs.rm(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const updatedNodePorts = cluster.nodePorts?.slice(0, targetNodes);
  await saveCluster({ ...cluster, nodes: targetNodes, nodePorts: updatedNodePorts });
  onProgress?.({ stage: "complete", message: `Successfully scaled cluster to ${targetNodes} nodes` });
}

export async function deleteClusterContainers(name: string): Promise<void> {
  const containers = await getClusterContainers(name);
  for (const container of containers) {
    await executeDockerCommand(`docker rm -f ${container} 2>/dev/null || true`);
  }
  await executeDockerCommand(`docker network rm yb-${name}-network 2>/dev/null || true`);

  // Delete data directory
  try {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs/promises");
    const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`);
    await fs.rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  await deleteCluster(name);
}

// ---------------------------------------------------------------------------
// Cluster status & services
// ---------------------------------------------------------------------------

export async function getClusterStatus(name: string): Promise<"running" | "stopped"> {
  let allContainers: string[];
  try {
    const { stdout } = await executeDockerCommand(
      `docker ps -a --filter "name=^yb-${name}-node" --format "{{.Names}}"`,
    );
    allContainers = stdout.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return "stopped";
  }

  if (allContainers.length === 0) return "stopped";

  try {
    const { stdout } = await executeDockerCommand(`docker ps --filter "name=^yb-${name}-node" --format "{{.Names}}"`);
    const running = stdout.split("\n").filter((l) => l.trim().length > 0);
    return running.length === allContainers.length ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}

export async function getClusterServices(name: string): Promise<ClusterService[]> {
  const containers = await getClusterContainers(name);
  const services: ClusterService[] = [];

  for (const containerName of containers) {
    const nodeMatch = containerName.match(/node(\d+)/);
    const nodeNumber = nodeMatch ? parseInt(nodeMatch[1], 10) : 1;

    // Resolve ports from stored metadata or calculate defaults
    let ports: NodePorts;
    try {
      const cluster = await getCluster(name);
      if (cluster?.nodePorts?.[nodeNumber - 1]) {
        ports = cluster.nodePorts[nodeNumber - 1];
      } else {
        ports = defaultPorts(nodeNumber - 1);
      }
    } catch {
      ports = defaultPorts(nodeNumber - 1);
    }

    // Check if container is running
    let isRunning = false;
    try {
      const { stdout } = await executeDockerCommand(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`);
      isRunning = stdout.trim() === containerName;
    } catch {
      /* not running */
    }

    let hasYugabyted = false;
    let hasYbMaster = false;
    let hasYbTserver = false;

    if (isRunning) {
      try {
        const { stdout } = await executeDockerCommand(
          `docker exec ${containerName} ps aux 2>&1 | grep -E "(yugabyted|yb-master|yb-tserver)" || echo ""`,
        );
        hasYugabyted = stdout.includes("yugabyted");
        hasYbMaster = stdout.includes("yb-master");
        hasYbTserver = stdout.includes("yb-tserver");
      } catch {
        hasYugabyted = isRunning;
      }
    }

    services.push({
      containerName,
      nodeNumber,
      services: {
        yugabyted: hasYugabyted ? { running: true, port: ports.yugabytedUI } : undefined,
        ybMaster: hasYbMaster ? { running: true, port: ports.masterUI } : undefined,
        ybTserver: hasYbTserver ? { running: true, port: ports.tserverUI } : undefined,
      },
      ports,
    });
  }

  return services.sort((a, b) => a.nodeNumber - b.nodeNumber);
}

function defaultPorts(offset: number): NodePorts {
  return {
    yugabytedUI: 15433 + offset,
    masterUI: 7000 + offset,
    tserverUI: 9000 + offset,
    ysql: 5433 + offset,
    ycql: 9042 + offset,
  };
}

// ---------------------------------------------------------------------------
// Docker Hub releases
// ---------------------------------------------------------------------------

export async function fetchDockerHubReleases(): Promise<{ name: string; tag: string }[]> {
  let allTags: { name: string }[] = [];
  let nextUrl: string | null =
    "https://hub.docker.com/v2/repositories/yugabytedb/yugabyte/tags?page_size=100&ordering=-last_updated";
  let pageCount = 0;
  const maxPages = 10;

  while (nextUrl && pageCount < maxPages) {
    const response = await fetch(nextUrl);
    const data = (await response.json()) as { results?: { name: string }[]; next?: string };
    if (data.results && Array.isArray(data.results)) {
      allTags = allTags.concat(data.results);
      nextUrl = data.next || null;
      pageCount++;
    } else {
      break;
    }
  }

  const validReleases = allTags
    .filter((tag) => {
      const t = tag.name || "";
      if (/rc|alpha|beta|dev|test|nightly|snapshot/.test(t)) return false;
      if (t.startsWith("v2.")) return false;
      if (/^\d+\.\d+$/.test(t)) return false;
      if (/^[a-z]/.test(t) && t !== "latest") return false;
      return t === "latest" || /^\d+\.\d+\.\d+\.\d+(-b\d+)?$/.test(t);
    })
    .map((tag) => ({ name: tag.name === "latest" ? "Latest" : tag.name, tag: tag.name }));

  validReleases.sort((a, b) => {
    if (a.tag === "latest") return -1;
    if (b.tag === "latest") return 1;
    const parse = (t: string) => {
      const m = t.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(-b(\d+))?$/);
      return m ? [+m[1], +m[2], +m[3], +m[4], m[6] ? +m[6] : 0] : [0, 0, 0, 0, 0];
    };
    const av = parse(a.tag),
      bv = parse(b.tag);
    for (let i = 0; i < 5; i++) {
      if (av[i] !== bv[i]) return bv[i] - av[i];
    }
    return 0;
  });

  return validReleases.slice(0, 50);
}
