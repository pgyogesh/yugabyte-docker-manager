import { exec } from "child_process";
import { promisify } from "util";
import { NodePorts, ClusterInfo, ClusterCreationProgress, ProgressCallback, ClusterService } from "../types";

// Re-export types so existing consumers don't break
export type { NodePorts, ClusterInfo, ClusterCreationProgress, ProgressCallback, ClusterService };

const execAsync = promisify(exec);

const CLUSTER_STORAGE_FILE = `${process.env.HOME}/.yugabyte-clusters.json`;
const SHARED_NETWORK = "yb-shared-network";

async function ensureSharedNetwork(): Promise<void> {
  try {
    await execAsync(`docker network inspect ${SHARED_NETWORK} >/dev/null 2>&1`);
  } catch {
    await executeDockerCommand(`docker network create ${SHARED_NETWORK} 2>&1`);
  }
}

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

  const normalizedMaster = normalizeGFlagsForStorage(masterGFlags);
  const normalizedTserver = normalizeGFlagsForStorage(tserverGFlags);
  await saveCluster({ name, nodes, version, status: "running", masterGFlags: normalizedMaster, tserverGFlags: normalizedTserver, nodePorts });
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

/**
 * Splits a flag string into individual flag entries, respecting quoted values
 * and curly braces so that commas/spaces inside them aren't treated as
 * flag separators.
 *
 * Handles three formats (auto-detected in priority order):
 *  1. "--flag=val --flag2=val2"  → split on -- boundaries
 *  2. "flag=val\nflag2=val2"    → one flag per line (newline-separated)
 *  3. "flag=val,flag2=val2"     → comma-separated (values with commas
 *                                  must be wrapped in {})
 *
 * Format 2 is the safest for complex values that contain commas (like
 * ysql_pg_conf_csv) because commas within a line are always part of
 * the value, never a separator.
 */
function splitFlagEntries(input: string): string[] {
  const s = input.trim();
  if (!s) return [];

  const useDashBoundaries = /(?:^|[\s,])--/.test(s);

  // Multi-line without -- prefix: one flag per line — the safest format
  // for values that contain commas (no escaping or {} needed).
  if (!useDashBoundaries && s.includes("\n")) {
    return s
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  const entries: string[] = [];
  let i = 0;

  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;

    const start = i;
    let inQuote = false;
    let quoteChar = "";
    let braceDepth = 0;

    while (i < s.length) {
      const ch = s[i];

      if (inQuote) {
        if (ch === quoteChar) inQuote = false;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
        i++;
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === "}" && braceDepth > 0) {
        braceDepth--;
        i++;
        continue;
      }

      if (braceDepth === 0 && /[\s,]/.test(ch)) {
        if (useDashBoundaries) {
          let j = i;
          while (j < s.length && /[\s,]/.test(s[j])) j++;
          if (j >= s.length || (s[j] === "-" && j + 1 < s.length && s[j + 1] === "-")) {
            break;
          }
        } else {
          break;
        }
      }

      i++;
    }

    const entry = s.substring(start, i).trim();
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Converts a stored flag string into the comma-separated format expected by
 * yugabyted's --master_flags / --tserver_flags.
 *
 * Flag values that contain commas are wrapped in {} so that yugabyted does
 * not treat inner commas as flag separators.
 */
function processGFlags(flags: string): string {
  return splitFlagEntries(flags)
    .map((f) => {
      const stripped = f.replace(/^--+/, "").trim();
      if (!stripped) return "";
      const eqIdx = stripped.indexOf("=");
      if (eqIdx <= 0) return stripped;

      const name = stripped.substring(0, eqIdx);
      const value = stripped.substring(eqIdx + 1);

      if (value.includes(",") && !(value.startsWith("{") && value.endsWith("}"))) {
        return `${name}={${value}}`;
      }
      return stripped;
    })
    .filter((f) => f.length > 0)
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
  await ensureSharedNetwork();

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
    await executeDockerCommand(`docker network connect ${SHARED_NETWORK} ${nodeName}`);
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
  await ensureSharedNetwork();
  for (const container of containers) {
    await executeDockerCommand(`docker start ${container} 2>/dev/null || true`);
    try {
      await execAsync(`docker network connect ${SHARED_NETWORK} ${container} 2>/dev/null`);
    } catch {
      /* already connected */
    }
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
    await ensureSharedNetwork();
    await executeDockerCommand(`docker network connect ${SHARED_NETWORK} ${nodeName}`);
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

  // Remove shared network if no containers remain on it
  try {
    const { stdout } = await execAsync(
      `docker network inspect ${SHARED_NETWORK} --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null`,
    );
    if (!stdout.trim()) {
      await execAsync(`docker network rm ${SHARED_NETWORK} 2>/dev/null || true`);
    }
  } catch {
    /* shared network doesn't exist or already removed */
  }

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
// GFlags management
// ---------------------------------------------------------------------------

export function parseGFlagsToMap(flags?: string): Record<string, string> {
  if (!flags?.trim()) return {};
  const result: Record<string, string> = {};
  const parts = splitFlagEntries(flags.trim());
  for (const part of parts) {
    const clean = part.replace(/^--+/, "").trim();
    const eqIdx = clean.indexOf("=");
    if (eqIdx > 0) {
      let value = clean.substring(eqIdx + 1);
      if (value.startsWith("{") && value.endsWith("}")) {
        value = value.substring(1, value.length - 1);
      }
      result[clean.substring(0, eqIdx)] = value;
    }
  }
  return result;
}

function gflagsMapToString(flags: Record<string, string>): string {
  return Object.entries(flags)
    .map(([k, v]) => `--${k}=${v}`)
    .join(" ");
}

function normalizeGFlagsForStorage(flags?: string): string | undefined {
  if (!flags?.trim()) return undefined;
  const map = parseGFlagsToMap(flags);
  if (Object.keys(map).length === 0) return undefined;
  return gflagsMapToString(map);
}

export async function setGFlagRuntime(
  clusterName: string,
  serverType: "master" | "tserver",
  flagName: string,
  flagValue: string,
): Promise<{ node: string; success: boolean; error?: string }[]> {
  const cluster = await getCluster(clusterName);
  if (!cluster) throw new Error(`Cluster "${clusterName}" not found`);
  if (cluster.status !== "running") throw new Error(`Cluster "${clusterName}" must be running to set flags`);

  const results: { node: string; success: boolean; error?: string }[] = [];
  const firstContainer = `yb-${clusterName}-node1`;
  const port = serverType === "master" ? 7100 : 9100;

  for (let i = 1; i <= cluster.nodes; i++) {
    const nodeName = `yb-${clusterName}-node${i}`;
    const escapedValue = flagValue.replace(/'/g, "'\\''");
    const cmd = `docker exec ${firstContainer} /home/yugabyte/bin/yb-ts-cli --server_address ${nodeName}:${port} set_flag --force ${flagName} '${escapedValue}'`;
    try {
      await executeDockerCommand(cmd);
      results.push({ node: nodeName, success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      results.push({ node: nodeName, success: false, error: msg });
    }
  }

  return results;
}

export async function updateClusterGFlags(
  clusterName: string,
  serverType: "master" | "tserver",
  flags: Record<string, string>,
): Promise<void> {
  const cluster = await getCluster(clusterName);
  if (!cluster) throw new Error(`Cluster "${clusterName}" not found`);

  const existing = parseGFlagsToMap(
    serverType === "master" ? cluster.masterGFlags : cluster.tserverGFlags,
  );
  for (const [key, value] of Object.entries(flags)) {
    existing[key] = value;
  }

  const merged = gflagsMapToString(existing);
  if (serverType === "master") {
    cluster.masterGFlags = merged;
  } else {
    cluster.tserverGFlags = merged;
  }

  await saveCluster(cluster);
}

export async function removeClusterGFlags(
  clusterName: string,
  serverType: "master" | "tserver",
  flagNames: string[],
): Promise<void> {
  const cluster = await getCluster(clusterName);
  if (!cluster) throw new Error(`Cluster "${clusterName}" not found`);

  const existing = parseGFlagsToMap(
    serverType === "master" ? cluster.masterGFlags : cluster.tserverGFlags,
  );
  for (const name of flagNames) {
    delete existing[name];
  }

  const updated = gflagsMapToString(existing);
  if (serverType === "master") {
    cluster.masterGFlags = updated;
  } else {
    cluster.tserverGFlags = updated;
  }

  await saveCluster(cluster);
}

export async function restartClusterWithoutFlag(
  clusterName: string,
  serverType: "master" | "tserver" | "both",
  flagNames: string[],
  onProgress?: ProgressCallback,
): Promise<void> {
  const cluster = await getCluster(clusterName);
  if (!cluster) throw new Error(`Cluster "${clusterName}" not found`);

  const types: ("master" | "tserver")[] =
    serverType === "both" ? ["master", "tserver"] : [serverType];

  for (const type of types) {
    const existing = parseGFlagsToMap(
      type === "master" ? cluster.masterGFlags : cluster.tserverGFlags,
    );
    for (const name of flagNames) {
      delete existing[name];
    }
    const merged = gflagsMapToString(existing);
    if (type === "master") {
      cluster.masterGFlags = merged;
    } else {
      cluster.tserverGFlags = merged;
    }
  }
  await saveCluster(cluster);

  onProgress?.({ stage: "stopping", message: "Stopping cluster..." });
  await stopCluster(clusterName);

  onProgress?.({ stage: "config", message: "Updating configuration..." });
  for (let i = 1; i <= cluster.nodes; i++) {
    await updateYugabytedConf(clusterName, i, cluster);
  }

  onProgress?.({ stage: "starting", message: "Starting cluster..." });
  await startCluster(clusterName);

  onProgress?.({ stage: "ready", message: "Waiting for cluster to be ready..." });
  await waitForClusterReady(clusterName, cluster.nodes);

  onProgress?.({ stage: "complete", message: "Cluster restarted with flags removed" });
}

/**
 * Waits until `yb-admin list_all_masters` reports all expected masters as
 * ALIVE with at least one LEADER. This is deliberately lighter than
 * `list_all_tablet_servers` which requires the master leader to have fully
 * loaded the sys_catalog (and will always fail when flags like
 * `emergency_repair_mode` are set).
 *
 * Throws if the cluster doesn't become ready within the timeout.
 */
async function waitForClusterReady(
  clusterName: string,
  numNodes: number,
  timeoutMs: number = 180000,
): Promise<void> {
  const masterAddresses = Array.from(
    { length: numNodes },
    (_, i) => `yb-${clusterName}-node${i + 1}:7100`,
  ).join(",");

  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    for (let i = 1; i <= numNodes; i++) {
      try {
        const container = `yb-${clusterName}-node${i}`;
        const { stdout } = await executeDockerCommand(
          `docker exec ${container} /home/yugabyte/bin/yb-admin -master_addresses ${masterAddresses} list_all_masters`,
        );
        const lines = stdout.trim().split("\n").filter((l) => l.trim());
        const aliveCount = lines.filter((l) => l.includes("ALIVE")).length;
        const hasLeader = lines.some((l) => l.includes("LEADER"));
        if (aliveCount >= numNodes && hasLeader) {
          return;
        }
        lastError = `Masters alive: ${aliveCount}/${numNodes}, leader elected: ${hasLeader}`;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : "Unknown error";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Cluster readiness check timed out after ${timeoutMs / 1000}s. Last status: ${lastError.substring(0, 200)}`);
}

// Flags whose values are CSV lists of PostgreSQL settings. When merging
// with an existing yugabyted.conf these need setting-level merging so that
// presets (e.g. yb_enable_cbo=on) aren't duplicated or lost.
const CSV_VALUE_FLAGS = new Set(["ysql_pg_conf_csv", "ysql_hba_conf_csv"]);

/**
 * Splits a CSV-style flag value (e.g. the value of ysql_pg_conf_csv) into
 * individual PostgreSQL settings, respecting quoted entries that may contain
 * commas.
 */
function splitCSVSettings(csv: string): string[] {
  if (!csv.trim()) return [];
  const settings: string[] = [];
  let i = 0;
  const s = csv.trim();

  while (i < s.length) {
    while (i < s.length && s[i] === ",") i++;
    if (i >= s.length) break;

    const start = i;
    let inQuote = false;

    while (i < s.length) {
      if (inQuote) {
        if (s[i] === '"') inQuote = false;
      } else {
        if (s[i] === '"') inQuote = true;
        else if (s[i] === ",") break;
      }
      i++;
    }

    const entry = s.substring(start, i).trim();
    if (entry) settings.push(entry);
  }

  return settings;
}

function extractPGSettingName(setting: string): string {
  let s = setting.trim();
  if (s.startsWith('"')) s = s.substring(1);
  const eqIdx = s.indexOf("=");
  return eqIdx > 0 ? s.substring(0, eqIdx).trim() : s;
}

/**
 * Merges two CSV-style flag values at the PostgreSQL-setting level.
 * Incoming settings override existing ones with the same setting name;
 * existing settings with different names (presets) are preserved.
 */
function mergeCSVFlagValues(existing: string, incoming: string): string {
  const merged = new Map<string, string>();
  for (const s of splitCSVSettings(existing)) {
    merged.set(extractPGSettingName(s), s);
  }
  for (const s of splitCSVSettings(incoming)) {
    merged.set(extractPGSettingName(s), s);
  }
  return Array.from(merged.values()).join(",");
}

/**
 * Merges our stored flags with the flags already present in the
 * yugabyted.conf. For most flags our value simply overrides; for CSV-value
 * flags (ysql_pg_conf_csv, ysql_hba_conf_csv) the individual PostgreSQL
 * settings are merged so that presets from yugabyted are preserved.
 *
 * Returns the merged comma-separated string for the conf, or empty string
 * if there are no flags.
 */
function mergeConfFlags(existingConfStr: string | undefined, ourStoredFlags: string | undefined): string {
  const existingMap = parseGFlagsToMap(existingConfStr || "");
  const ourMap = parseGFlagsToMap(ourStoredFlags || "");

  const merged = { ...existingMap };

  for (const [key, value] of Object.entries(ourMap)) {
    if (CSV_VALUE_FLAGS.has(key) && merged[key]) {
      merged[key] = mergeCSVFlagValues(merged[key], value);
    } else {
      merged[key] = value;
    }
  }

  const entries = Object.entries(merged);
  if (entries.length === 0) return "";

  return entries
    .map(([k, v]) => {
      if (v.includes(",") && !(v.startsWith("{") && v.endsWith("}"))) {
        return `${k}={${v}}`;
      }
      return `${k}=${v}`;
    })
    .join(",");
}

/**
 * Reads the existing yugabyted.conf from a node's host-mounted data volume,
 * merges our flags with existing conf flags (preserving yugabyted presets),
 * and writes it back. On the next `docker start` yugabyted picks up the
 * updated conf automatically.
 */
async function updateYugabytedConf(
  clusterName: string,
  nodeNumber: number,
  cluster: ClusterInfo,
): Promise<void> {
  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs/promises");

  const confDir = path.join(
    os.homedir(),
    `yb_docker_data_${clusterName}`,
    `node${nodeNumber}`,
    "conf",
  );
  const confPath = path.join(confDir, "yugabyted.conf");

  let conf: Record<string, unknown> = {};
  try {
    const data = await fs.readFile(confPath, "utf-8");
    conf = JSON.parse(data);
  } catch {
    // File doesn't exist or is invalid — will be created from scratch
  }

  const existingMaster = typeof conf.master_flags === "string" ? (conf.master_flags as string) : undefined;
  const existingTserver = typeof conf.tserver_flags === "string" ? (conf.tserver_flags as string) : undefined;

  const mergedMaster = mergeConfFlags(existingMaster, cluster.masterGFlags);
  const mergedTserver = mergeConfFlags(existingTserver, cluster.tserverGFlags);

  if (mergedMaster) {
    conf.master_flags = mergedMaster;
  } else {
    delete conf.master_flags;
  }
  if (mergedTserver) {
    conf.tserver_flags = mergedTserver;
  } else {
    delete conf.tserver_flags;
  }

  await fs.mkdir(confDir, { recursive: true });
  await fs.writeFile(confPath, JSON.stringify(conf, null, 2), "utf-8");
}

/**
 * Stops the entire cluster, writes updated yugabyted.conf files on each
 * node's host volume, then starts all containers again. This is the most
 * reliable way to change GFlags — yugabyted reads its conf on startup.
 */
export async function restartClusterWithFlags(
  clusterName: string,
  serverType: "master" | "tserver" | "both",
  flagName: string,
  flagValue: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const cluster = await getCluster(clusterName);
  if (!cluster) throw new Error(`Cluster "${clusterName}" not found`);

  const types: ("master" | "tserver")[] =
    serverType === "both" ? ["master", "tserver"] : [serverType];

  for (const type of types) {
    const existing = parseGFlagsToMap(
      type === "master" ? cluster.masterGFlags : cluster.tserverGFlags,
    );
    existing[flagName] = flagValue;
    const merged = gflagsMapToString(existing);
    if (type === "master") {
      cluster.masterGFlags = merged;
    } else {
      cluster.tserverGFlags = merged;
    }
  }
  await saveCluster(cluster);

  onProgress?.({ stage: "stopping", message: "Stopping cluster..." });
  await stopCluster(clusterName);

  onProgress?.({ stage: "config", message: "Updating configuration..." });
  for (let i = 1; i <= cluster.nodes; i++) {
    await updateYugabytedConf(clusterName, i, cluster);
  }

  onProgress?.({ stage: "starting", message: "Starting cluster..." });
  await startCluster(clusterName);

  onProgress?.({ stage: "ready", message: "Waiting for cluster to be ready..." });
  await waitForClusterReady(clusterName, cluster.nodes);

  onProgress?.({ stage: "complete", message: "Cluster restarted with updated flags" });
}

// ---------------------------------------------------------------------------
// Varz flag discovery
// ---------------------------------------------------------------------------

export interface VarzFlag {
  name: string;
  value: string;
}

function parseVarzJson(raw: string): VarzFlag[] | null {
  try {
    const data = JSON.parse(raw) as { flags?: { name: string; value: string }[] };
    if (data.flags && Array.isArray(data.flags)) {
      return data.flags
        .map((f) => ({ name: f.name, value: String(f.value ?? "") }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function parseVarzRaw(raw: string): VarzFlag[] {
  const flags: VarzFlag[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("--")) continue;
    const clean = trimmed.replace(/^--/, "");
    const eqIdx = clean.indexOf("=");
    if (eqIdx > 0) {
      flags.push({ name: clean.substring(0, eqIdx), value: clean.substring(eqIdx + 1) });
    }
  }
  return flags.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetches the full list of GFlags from a running cluster node.
 * Strategy:
 *  1. Try the local proxy (http://localhost:15080/proxy/container:port/...)
 *  2. Fall back to docker exec curl using the container hostname
 *     (YugabyteDB binds to the hostname, not localhost)
 */
export async function fetchVarzFlags(
  clusterName: string,
  serverType: "master" | "tserver",
): Promise<VarzFlag[]> {
  const container = `yb-${clusterName}-node1`;
  const port = serverType === "master" ? 7000 : 9000;
  const PROXY_PORT = 15080;

  // --- Strategy 1: via the local proxy ---
  try {
    const proxyUrl = `http://localhost:${PROXY_PORT}/proxy/${container}:${port}/api/v1/varz`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const text = await res.text();
      const parsed = parseVarzJson(text);
      if (parsed) return parsed;
    }
  } catch {
    // proxy not running or unreachable — fall through
  }

  // Proxy fallback: /varz?raw
  try {
    const rawUrl = `http://localhost:${PROXY_PORT}/proxy/${container}:${port}/varz?raw`;
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const text = await res.text();
      const flags = parseVarzRaw(text);
      if (flags.length > 0) return flags;
    }
  } catch {
    // fall through to docker exec
  }

  // --- Strategy 2: docker exec with container hostname (not localhost) ---
  try {
    const { stdout } = await executeDockerCommand(
      `docker exec ${container} curl -sS 'http://${container}:${port}/api/v1/varz'`,
    );
    const parsed = parseVarzJson(stdout);
    if (parsed) return parsed;
  } catch {
    // fall through to raw
  }

  const { stdout } = await executeDockerCommand(
    `docker exec ${container} curl -sS 'http://${container}:${port}/varz?raw'`,
  );
  return parseVarzRaw(stdout);
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
