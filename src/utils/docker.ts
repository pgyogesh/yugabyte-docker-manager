import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ClusterInfo {
  name: string;
  nodes: number;
  version: string;
  status: "running" | "stopped";
}

const CLUSTER_STORAGE_FILE = `${process.env.HOME}/.yugabyte-clusters.json`;

async function readClusters(): Promise<Record<string, ClusterInfo>> {
  try {
    const fs = await import("fs/promises");
    const data = await fs.readFile(CLUSTER_STORAGE_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
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

export async function executeDockerCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    console.log(`[Docker] Executing: ${command}`);
    const result = await execAsync(command);
    if (result.stdout) console.log(`[Docker] stdout: ${result.stdout.trim()}`);
    if (result.stderr) console.log(`[Docker] stderr: ${result.stderr.trim()}`);
    return result;
  } catch (error: any) {
    const errorMsg = `Docker command failed: ${error.message}`;
    console.error(`[Docker] Command failed: ${command}`);
    console.error(`[Docker] Error: ${errorMsg}`);
    if (error.stdout) console.error(`[Docker] Error stdout: ${error.stdout}`);
    if (error.stderr) console.error(`[Docker] Error stderr: ${error.stderr}`);
    const enhancedError = new Error(errorMsg);
    (enhancedError as any).stdout = error.stdout;
    (enhancedError as any).stderr = error.stderr;
    throw enhancedError;
  }
}

export async function createYugabyteCluster(
  name: string,
  nodes: number,
  version: string
): Promise<void> {
  // Clean up any existing containers with the same name pattern (from previous failed attempts)
  console.log(`[Docker] Cleaning up any existing containers for cluster ${name}...`);
  for (let i = 0; i < nodes; i++) {
    const nodeName = `yb-${name}-node${i + 1}`;
    try {
      await executeDockerCommand(`docker rm -f ${nodeName}-master ${nodeName}-tserver ${nodeName} 2>/dev/null || true`);
    } catch (error) {
      // Ignore errors if containers don't exist
    }
  }
  
  // Network will be created in createYugabytedClusterWithHostNetwork

  // Check if image exists locally, if not, try to pull it
  console.log(`[Docker] Checking for yugabytedb/yugabyte:${version} image...`);
  try {
    // First check if image exists locally
    try {
      await executeDockerCommand(`docker image inspect yugabytedb/yugabyte:${version} 2>/dev/null`);
      console.log(`[Docker] Image found locally`);
    } catch (inspectError) {
      // Image doesn't exist locally, try to pull it
      console.log(`[Docker] Image not found locally, pulling from registry...`);
      try {
        await executeDockerCommand(`docker pull yugabytedb/yugabyte:${version}`);
        console.log(`[Docker] Successfully pulled image`);
      } catch (pullError: any) {
        const errorMsg = pullError.stderr || pullError.message || "Unknown error";
        if (errorMsg.includes("docker-credential-desktop") || errorMsg.includes("credentials")) {
          console.log(`[Docker] Credential helper issue detected, trying workaround...`);
          // Try to pull without credential helper by using a temporary config
          try {
            const fs = await import("fs/promises");
            const path = await import("path");
            const os = await import("os");
            
            // Create a temporary Docker config without credential helper
            const tempConfigDir = path.join(os.tmpdir(), `yugabyte-docker-${Date.now()}`);
            await fs.mkdir(tempConfigDir, { recursive: true });
            const tempConfigFile = path.join(tempConfigDir, "config.json");
            await fs.writeFile(tempConfigFile, JSON.stringify({}), "utf-8");
            
            // Try pulling with the temp config
            const { exec } = await import("child_process");
            const { promisify } = await import("util");
            const execAsync = promisify(exec);
            
            const env = { ...process.env, DOCKER_CONFIG: tempConfigDir };
            await execAsync(`docker pull yugabytedb/yugabyte:${version}`, { env });
            
            // Clean up
            await fs.rm(tempConfigDir, { recursive: true, force: true });
            console.log(`[Docker] Successfully pulled image using workaround`);
          } catch (workaroundError: any) {
            console.error(`[Docker] Workaround failed: ${workaroundError.message}`);
            console.error(`[Docker] Docker credential helper issue detected.`);
            console.error(`[Docker] To fix this, you can either:`);
            console.error(`[Docker] 1. Remove the credential helper from ~/.docker/config.json`);
            console.error(`[Docker] 2. Or manually pull the image: docker pull yugabytedb/yugabyte:${version}`);
            throw new Error(`Docker credential helper error. Please fix Docker configuration or manually pull the image. Run: docker pull yugabytedb/yugabyte:${version}`);
          }
        } else {
          throw new Error(`Failed to pull Docker image: ${errorMsg}`);
        }
      }
    }
  } catch (error: any) {
    // Re-throw if it's our custom error, otherwise wrap it
    if (error.message && error.message.includes("Docker credential helper")) {
      throw error;
    }
    throw new Error(`Failed to check/pull Docker image: ${error.message || error}`);
  }

  // Use yugabyted for all clusters with host networking for better connectivity
  console.log(`[Docker] Using yugabyted with host networking for ${nodes}-node cluster`);
  
  const createdContainers: string[] = [];
  
  try {
    // Always use yugabyted with custom bridge network
    await createYugabytedClusterWithHostNetwork(name, nodes, version, createdContainers);
  } catch (error: any) {
    // Rollback: clean up any containers we created
    console.error(`[Docker] Error creating cluster, cleaning up created containers...`);
    for (const container of createdContainers) {
      try {
        await executeDockerCommand(`docker rm -f ${container} 2>/dev/null || true`);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    // Also try to remove the network
    const networkName = `yb-${name}-network`;
    try {
      await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
  
  // Wait a bit for containers to start and form cluster
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Save cluster info
  await saveCluster({
    name,
    nodes,
    version,
    status: "running",
  });
}

async function createYugabytedClusterWithHostNetwork(
  name: string,
  nodes: number,
  version: string,
  createdContainers: string[]
): Promise<void> {
  // Create a custom bridge network for better isolation and connectivity
  const networkName = `yb-${name}-network`;
  
  // Remove existing network if it exists
  try {
    await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
  } catch (error) {
    // Ignore
  }
  
  // Create custom bridge network
  console.log(`[Docker] Creating custom bridge network: ${networkName}`);
  await executeDockerCommand(`docker network create ${networkName} 2>&1`);
  
  const firstNodeName = `yb-${name}-node1`;
  const firstNodeHostname = firstNodeName;
  
  for (let i = 0; i < nodes; i++) {
    const nodeName = `yb-${name}-node${i + 1}`;
    const nodeHostname = nodeName;
    const masterPort = 7100 + i;
    const yqlPort = 9042 + i;
    const ysqlPort = 5433 + i;
    const webPort = 7000 + i;
    const yugabytedUIPort = 15433 + i; // YugabyteDB UI port (15433, 15434, 15435, etc.)
    const tserverPort = 9000 + i;
    
    // Use persistent data directory on host (like the working example)
    const os = await import("os");
    const path = await import("path");
    const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`, `node${i + 1}`);
    const containerDataDir = `/home/yugabyte/yb_data`;

    console.log(`[Docker] Creating yugabyted container for node ${i + 1}...`);
    
    // For multi-node, join subsequent nodes to the first node using hostname
    // Docker's DNS will resolve the hostname automatically
    let joinFlag = "";
    if (i > 0) {
      // Use hostname for --join (Docker DNS handles resolution)
      joinFlag = `--join=${firstNodeHostname}`;
      console.log(`[Docker] Node ${i + 1} will join cluster via hostname: ${joinFlag}`);
    } else {
      console.log(`[Docker] Node ${i + 1} is the first node (cluster leader)`);
    }
    
    // Build yugabyted command
    // Use hostname for advertise_address - yugabyted will use it automatically
    // No need for --advertise_address when using hostnames in Docker network
    let yugabytedArgs = `--base_dir=${containerDataDir} --background=false`;
    
    // For nodes after the first, add join flag
    if (joinFlag) {
      yugabytedArgs += ` ${joinFlag}`;
    }
    
    // Create data directory on host if it doesn't exist
    const fs = await import("fs/promises");
    try {
      await fs.mkdir(dataDir, { recursive: true });
      console.log(`[Docker] Created data directory: ${dataDir}`);
    } catch (mkdirError) {
      console.log(`[Docker] Note: Could not create data directory, continuing anyway`);
    }
    
    // Use custom bridge network with hostname-based communication
    // Mount volume for data persistence
    // Port mappings match the working manual setup:
    // - 15433:15433 (YugabyteDB UI)
    // - 7000+i:7000 (Master web UI)
    // - 9000+i:9000 (TServer)
    // - 5433+i:5433 (YSQL)
    const yugabytedCmd = `docker run -d --name ${nodeName} \
      --network ${networkName} \
      --hostname ${nodeHostname} \
      -p ${yugabytedUIPort}:15433 \
      -p ${webPort}:7000 \
      -p ${tserverPort}:9000 \
      -p ${ysqlPort}:5433 \
      -v ${dataDir}:${containerDataDir} \
      --restart unless-stopped \
      yugabytedb/yugabyte:${version} \
      bin/yugabyted start ${yugabytedArgs}`;

    console.log(`[Docker] Executing: ${yugabytedCmd}`);
    await executeDockerCommand(yugabytedCmd);
    createdContainers.push(nodeName);
    
    // Wait and verify it's running
    await new Promise((resolve) => setTimeout(resolve, 5000));
    
    let isRunning = false;
    let retries = 3;
    while (retries > 0 && !isRunning) {
      try {
        const statusCheck = await executeDockerCommand(`docker ps --filter "name=${nodeName}" --format "{{.Status}}"`);
        if (statusCheck.stdout && statusCheck.stdout.trim().includes("Up")) {
          console.log(`[Docker] ✓ Container ${nodeName} is running: ${statusCheck.stdout.trim()}`);
          isRunning = true;
        } else {
          retries--;
          if (retries > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      } catch (statusError) {
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (!isRunning) {
      const logs = await executeDockerCommand(`docker logs ${nodeName} 2>&1`);
      throw new Error(`Container ${nodeName} stopped: ${logs.stdout || logs.stderr}`);
    }
    
    // For first node, wait longer for initialization before other nodes join
    if (i === 0) {
      console.log(`[Docker] Waiting for first node to fully initialize (15 seconds)...`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
      
      // Verify first node is listening on port 7100
      try {
        const masterCheck = await executeDockerCommand(`docker exec ${nodeName} netstat -tuln 2>&1 | grep 7100 || docker exec ${nodeName} ss -tuln 2>&1 | grep 7100 || echo "not listening"`);
        if (masterCheck.stdout && !masterCheck.stdout.includes("not listening")) {
          console.log(`[Docker] ✓ First node master is listening on port 7100: ${masterCheck.stdout.trim()}`);
        }
      } catch (error) {
        console.log(`[Docker] Could not verify first node, but continuing...`);
      }
    } else {
      // For subsequent nodes, wait a bit before starting next node
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    
    // Add Warp integration
    await addWarpIntegration(nodeName);
  }
}

async function createMultiNodeCluster(
  name: string,
  nodes: number,
  version: string,
  networkName: string,
  createdContainers: string[]
): Promise<void> {
  // Build master addresses for cluster formation
  const masterAddresses: string[] = [];
  for (let i = 0; i < nodes; i++) {
    masterAddresses.push(`yb-${name}-node${i + 1}-master:7100`);
  }
  const masterAddressesStr = masterAddresses.join(",");

  for (let i = 0; i < nodes; i++) {
    const nodeName = `yb-${name}-node${i + 1}`;
    const masterPort = 7100 + i;
    const tserverPort = 9000 + i;
    const yqlPort = 9042 + i;
    const ysqlPort = 5433 + i;
    const webPort = 7000 + i;
    const dataDir = `/mnt/disk0`;

    console.log(`[Docker] Creating master container for node ${i + 1}...`);
    const masterCmd = `docker run -d --name ${nodeName}-master \
      --net ${networkName} \
      --hostname ${nodeName}-master \
      -p ${masterPort}:7100 \
      -p ${webPort}:7000 \
      yugabytedb/yugabyte:${version} \
      /home/yugabyte/bin/yb-master \
      --fs_data_dirs=${dataDir} \
      --master_addresses=${masterAddressesStr} \
      --rpc_bind_addresses=0.0.0.0:7100 \
      --webserver_interface=0.0.0.0 \
      --placement_cloud=local \
      --placement_region=datacenter1 \
      --placement_zone=rack${i + 1}`;

    await executeDockerCommand(masterCmd);
    createdContainers.push(`${nodeName}-master`);

    console.log(`[Docker] Creating tserver container for node ${i + 1}...`);
    const tserverCmd = `docker run -d --name ${nodeName}-tserver \
      --net ${networkName} \
      --hostname ${nodeName}-tserver \
      -p ${tserverPort}:9000 \
      -p ${yqlPort}:9042 \
      -p ${ysqlPort}:5433 \
      yugabytedb/yugabyte:${version} \
      /home/yugabyte/bin/yb-tserver \
      --fs_data_dirs=${dataDir} \
      --tserver_master_addrs=${masterAddressesStr} \
      --rpc_bind_addresses=0.0.0.0:9100 \
      --webserver_interface=0.0.0.0 \
      --pgsql_proxy_bind_address=0.0.0.0:5433 \
      --cql_proxy_bind_address=0.0.0.0:9042 \
      --placement_cloud=local \
      --placement_region=datacenter1 \
      --placement_zone=rack${i + 1}`;

    await executeDockerCommand(tserverCmd);
    createdContainers.push(`${nodeName}-tserver`);
    
    // Add Warp integration to both containers
    await addWarpIntegration(`${nodeName}-master`);
    await addWarpIntegration(`${nodeName}-tserver`);
    
    // Wait between nodes
    if (i === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function addWarpIntegration(containerName: string): Promise<void> {
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const warpScript = `bash -c "cat >> ~/.bashrc << 'WARPEOF'
# Auto-Warpify
[[ \"\\$-\" == *i* ]] && printf '\\eP\\$f{\"hook\": \"SourcedRcFileForWarp\", \"value\": { \"shell\": \"bash\", \"uname\": \"'\$(uname)'\", \"tmux\": false }}\\x9c' 
WARPEOF"`;
    
    await executeDockerCommand(`docker exec ${containerName} ${warpScript} 2>&1`);
    console.log(`[Docker] Added Warp integration to ${containerName}`);
  } catch (warpError) {
    console.log(`[Docker] Note: Could not add Warp integration to ${containerName} (optional)`);
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

export async function deleteClusterContainers(name: string): Promise<void> {
  const containers = await getClusterContainers(name);
  for (const container of containers) {
    await executeDockerCommand(`docker rm -f ${container} 2>/dev/null || true`);
  }
  const networkName = `yb-${name}-network`;
  await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
  await deleteCluster(name);
}

async function getClusterNodes(name: string): Promise<string[]> {
  try {
    // Get both yugabyted containers (single-node) and master/tserver containers (multi-node)
    const { stdout } = await executeDockerCommand(`docker ps -a --filter "name=yb-${name}-" --format "{{.Names}}"`);
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim());
  } catch (error) {
    return [];
  }
}

async function getClusterContainers(name: string): Promise<string[]> {
  // Get all containers (yugabyted for single-node, master/tserver for multi-node)
  const containers = await getClusterNodes(name);
  return containers;
}

export async function getClusterStatus(name: string): Promise<"running" | "stopped"> {
  const nodes = await getClusterNodes(name);
  if (nodes.length === 0) {
    return "stopped";
  }

  try {
    const { stdout } = await executeDockerCommand(`docker ps --filter "name=yb-${name}-" --format "{{.Names}}"`);
    const runningNodes = stdout
      .split("\n")
      .filter((line) => line.trim().length > 0);
    
    return runningNodes.length === nodes.length ? "running" : "stopped";
  } catch (error) {
    return "stopped";
  }
}

export interface ClusterService {
  containerName: string;
  nodeNumber: number;
  services: {
    ybMaster?: { running: boolean; port: number };
    ybTserver?: { running: boolean; port: number };
    yugabyted?: { running: boolean; port: number };
  };
  ports: {
    masterUI: number;
    tserverUI: number;
    yugabytedUI: number;
    ysql: number;
    ycql: number;
  };
}

export async function getClusterServices(name: string): Promise<ClusterService[]> {
  const containers = await getClusterContainers(name);
  const services: ClusterService[] = [];

  for (let i = 0; i < containers.length; i++) {
    const containerName = containers[i];
    const nodeNumber = i + 1;
    
    // Extract node number from container name (e.g., "yb-test-node1" -> 1)
    const nodeMatch = containerName.match(/node(\d+)/);
    const extractedNodeNumber = nodeMatch ? parseInt(nodeMatch[1], 10) : nodeNumber;
    
    // Calculate ports based on node number (0-indexed)
    const nodeIndex = extractedNodeNumber - 1;
    const ports = {
      masterUI: 7000 + nodeIndex,
      tserverUI: 9000 + nodeIndex,
      yugabytedUI: 15433 + nodeIndex,
      ysql: 5433 + nodeIndex,
      ycql: 9042 + nodeIndex,
    };

    // Check if container is running
    let isRunning = false;
    try {
      const { stdout } = await executeDockerCommand(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`);
      isRunning = stdout.trim() === containerName;
    } catch (error) {
      // Container not running
    }

    // Check for running processes in the container
    let hasYugabyted = false;
    let hasYbMaster = false;
    let hasYbTserver = false;

    if (isRunning) {
      try {
        // Check for yugabyted process
        const yugabytedCheck = await executeDockerCommand(`docker exec ${containerName} ps aux 2>&1 | grep -E "(yugabyted|yb-master|yb-tserver)" || echo ""`);
        const processes = yugabytedCheck.stdout || yugabytedCheck.stderr || "";
        hasYugabyted = processes.includes("yugabyted");
        hasYbMaster = processes.includes("yb-master");
        hasYbTserver = processes.includes("yb-tserver");
      } catch (error) {
        // If we can't check, assume yugabyted is running if container is running
        hasYugabyted = isRunning;
      }
    }

    services.push({
      containerName,
      nodeNumber: extractedNodeNumber,
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
