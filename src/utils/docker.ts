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
  const networkName = `yb-${name}-network`;
  
  // Clean up any existing containers with the same name pattern (from previous failed attempts)
  console.log(`[Docker] Cleaning up any existing containers for cluster ${name}...`);
  for (let i = 0; i < nodes; i++) {
    const nodeName = `yb-${name}-node${i + 1}`;
    try {
      await executeDockerCommand(`docker rm -f ${nodeName}-master ${nodeName}-tserver 2>/dev/null || true`);
    } catch (error) {
      // Ignore errors if containers don't exist
    }
  }
  
  // Create Docker network (remove existing if it exists)
  try {
    await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
  } catch (error) {
    // Ignore if network doesn't exist
  }
  await executeDockerCommand(`docker network create ${networkName} 2>/dev/null || true`);

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

  // Build master addresses for cluster formation - use correct hostnames
  const masterAddresses: string[] = [];
  for (let i = 0; i < nodes; i++) {
    masterAddresses.push(`yb-${name}-node${i + 1}-master:7100`);
  }
  const masterAddressesStr = masterAddresses.join(",");

  // Create nodes - each node runs both master and tserver in separate containers
  const createdContainers: string[] = [];
  
  try {
    for (let i = 0; i < nodes; i++) {
      const nodeName = `yb-${name}-node${i + 1}`;
      // Use a base port offset to avoid conflicts (starting from 17000 for masters, 19000 for tservers)
      const basePort = 10000 + (i * 100);
      const masterPort = 7100 + i;
      const tserverPort = 9000 + i;
      const yqlPort = 9042 + i;
      const ysqlPort = 5433 + i;
      const webPort = 7000 + i;

      // Data directory for this node
      const dataDir = `/mnt/disk0`;

      // Start yb-master process
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

      // Start yb-tserver process
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
      
      // Add Warp terminal integration to bashrc for both containers
      // Wait a moment for containers to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      // Warp terminal integration - using the exact command as provided
      // We'll use a heredoc to avoid escaping issues
      const warpScript = `bash -c "cat >> ~/.bashrc << 'WARPEOF'
# Auto-Warpify
[[ \"\\$-\" == *i* ]] && printf '\\eP\\$f{\"hook\": \"SourcedRcFileForWarp\", \"value\": { \"shell\": \"bash\", \"uname\": \"'\$(uname)'\", \"tmux\": false }}\\x9c' 
WARPEOF"`;
      
      try {
        // Add to master container
        await executeDockerCommand(
          `docker exec ${nodeName}-master ${warpScript} 2>&1`
        );
        // Add to tserver container
        await executeDockerCommand(
          `docker exec ${nodeName}-tserver ${warpScript} 2>&1`
        );
        
        // Verify it was added and show the last few lines of bashrc
        const verifyMaster = await executeDockerCommand(
          `docker exec ${nodeName}-master bash -c "tail -3 ~/.bashrc" 2>&1`
        );
        const verifyTserver = await executeDockerCommand(
          `docker exec ${nodeName}-tserver bash -c "tail -3 ~/.bashrc" 2>&1`
        );
        
        if (verifyMaster.stdout.includes('Auto-Warpify') && verifyTserver.stdout.includes('Auto-Warpify')) {
          console.log(`[Docker] Successfully added Warp terminal integration to ${nodeName} containers`);
          console.log(`[Docker] Note: Use 'docker exec -it ${nodeName}-master bash' (not sh) to get Warp integration`);
        } else {
          console.log(`[Docker] Warning: Warp integration may not have been added correctly`);
          console.log(`[Docker] Master bashrc tail: ${verifyMaster.stdout.trim()}`);
          console.log(`[Docker] Tserver bashrc tail: ${verifyTserver.stdout.trim()}`);
        }
      } catch (warpError: any) {
        console.error(`[Docker] Error adding Warp integration: ${warpError.message || warpError}`);
        if (warpError.stderr) console.error(`[Docker] Warp error stderr: ${warpError.stderr}`);
        console.log(`[Docker] Note: Warp integration is optional and can be added manually later`);
      }
    }
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
  // Get both master and tserver containers
  const nodes = await getClusterNodes(name);
  return nodes;
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
