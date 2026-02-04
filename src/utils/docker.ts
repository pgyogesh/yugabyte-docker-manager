import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface NodePorts {
  yugabytedUI: number;
  masterUI: number;
  tserverUI: number;
  ysql: number;
  ycql: number;
}

export interface ClusterInfo {
  name: string;
  nodes: number;
  version: string;
  status: "running" | "stopped";
  masterGFlags?: string;
  tserverGFlags?: string;
  nodePorts?: NodePorts[]; // Store actual ports used for each node
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
    // Capture full error details
    const stdout = error.stdout || "";
    const stderr = error.stderr || "";
    const errorCode = error.code || "unknown";
    
    // Build comprehensive error message
    let errorMsg = `Docker command failed: ${error.message || "Unknown error"}`;
    if (stderr) {
      errorMsg += `\nDocker stderr: ${stderr}`;
    }
    if (stdout) {
      errorMsg += `\nDocker stdout: ${stdout}`;
    }
    errorMsg += `\nExit code: ${errorCode}`;
    
    console.error(`[Docker] ========== COMMAND FAILED ==========`);
    console.error(`[Docker] Command: ${command}`);
    console.error(`[Docker] Error message: ${error.message || "Unknown error"}`);
    console.error(`[Docker] Exit code: ${errorCode}`);
    if (stdout) {
      console.error(`[Docker] stdout: ${stdout}`);
    }
    if (stderr) {
      console.error(`[Docker] stderr: ${stderr}`);
    }
    console.error(`[Docker] ====================================`);
    
    const enhancedError = new Error(errorMsg);
    (enhancedError as any).stdout = stdout;
    (enhancedError as any).stderr = stderr;
    (enhancedError as any).code = errorCode;
    throw enhancedError;
  }
}

export interface ClusterCreationProgress {
  stage: string;
  message: string;
  nodeNumber?: number;
  totalNodes?: number;
}

export type ProgressCallback = (progress: ClusterCreationProgress) => void;

async function isPortAvailable(port: number): Promise<boolean> {
  // Check Docker containers first (both running and stopped)
  try {
    // Method 1: Check running containers - Docker port format: "0.0.0.0:5433->5433/tcp" or "[::]:5433->5433/tcp"
    try {
      const dockerPsResult = await executeDockerCommand(`docker ps --format "{{.Ports}}" 2>/dev/null || echo ""`);
      const dockerPorts = dockerPsResult.stdout || "";
      
      // Check multiple port patterns to catch different Docker output formats
      // Format examples: "0.0.0.0:5433->5433/tcp", ":5433->5433/tcp", "5433->5433/tcp"
      if (dockerPorts.includes(`:${port}->`) || dockerPorts.includes(`:${port}/tcp`) || dockerPorts.match(new RegExp(`[^0-9]${port}->`))) {
        console.log(`[Docker] Port ${port} is in use by running Docker container`);
        console.log(`[Docker] Docker ports output: ${dockerPorts.substring(0, 200)}`);
        return false;
      }
    } catch (error: any) {
      // If docker ps fails, continue to next check
      console.log(`[Docker] Could not check running containers for port ${port}: ${error.message || error}`);
    }
    
    // Method 2: Check all containers (including stopped) for port bindings
    try {
      const dockerPsAllResult = await executeDockerCommand(`docker ps -a --format "{{.Ports}}" 2>/dev/null || echo ""`);
      const allPorts = dockerPsAllResult.stdout || "";
      if (allPorts.includes(`:${port}->`) || allPorts.includes(`:${port}/tcp`) || allPorts.match(new RegExp(`[^0-9]${port}->`))) {
        console.log(`[Docker] Port ${port} is bound by Docker container (stopped or running)`);
        console.log(`[Docker] All containers ports output: ${allPorts.substring(0, 200)}`);
        return false;
      }
    } catch (error: any) {
      console.log(`[Docker] Could not check all containers for port ${port}: ${error.message || error}`);
    }
    
    // Method 3: Use docker inspect to check port bindings more reliably
    try {
      const dockerInspectResult = await executeDockerCommand(`docker ps -a -q | xargs -I {} sh -c 'docker port {} 2>/dev/null | grep -E ":${port}(->|/)" || true' || echo ""`);
      if (dockerInspectResult.stdout && dockerInspectResult.stdout.trim()) {
        console.log(`[Docker] Port ${port} is bound (found via docker port): ${dockerInspectResult.stdout.trim()}`);
        return false;
      }
    } catch (error: any) {
      // docker port might fail, that's okay - continue to lsof check
      console.log(`[Docker] Could not check port ${port} via docker port: ${error.message || error}`);
    }
  } catch (error: any) {
    // Docker command failed, continue to next check
    console.log(`[Docker] Could not check Docker for port ${port}, trying lsof...`);
  }
  
  // Check with lsof (lsof returns error code 1 when port is not in use, which is normal)
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    
    // Use execAsync directly to handle exit codes properly
    // lsof -ti:PORT returns PID if in use, or exits with code 1 if not in use
    try {
      const lsofResult = await execAsync(`lsof -ti:${port} 2>&1`);
      const output = (lsofResult.stdout || "").trim();
      
      // If lsof returns a process ID (numeric), port is in use
      if (output && /^\d+$/.test(output)) {
        console.log(`[Docker] Port ${port} is in use by PID ${output}`);
        return false;
      }
    } catch (lsofError: any) {
      // lsof exits with code 1 when port is not in use (this is normal, not an error)
      if (lsofError.code === 1) {
        // Port is not in use - this is the expected case
        return true;
      }
      
      // If we got output with a PID in stderr or stdout, port might be in use
      const errorOutput = (lsofError.stdout || lsofError.stderr || "").trim();
      if (errorOutput && /^\d+$/.test(errorOutput)) {
        console.log(`[Docker] Port ${port} is in use by PID ${errorOutput}`);
        return false;
      }
      
      // Other errors - assume port is available to be safe
      console.log(`[Docker] Could not check port ${port} with lsof, assuming available`);
      return true;
    }
  } catch (error: any) {
    // Unexpected error - assume port is available to be safe
    console.log(`[Docker] Error checking port ${port}, assuming available: ${error.message || error}`);
    return true;
  }
  
  return true;
}

async function findAvailablePortSet(startOffset: number): Promise<NodePorts> {
  let offset = startOffset;
  const maxOffset = 1000; // Safety limit
  
  console.log(`[Docker] Finding available port set starting from offset ${offset}...`);
  
  while (offset < maxOffset) {
    const ports: NodePorts = {
      yugabytedUI: 15433 + offset,
      masterUI: 7000 + offset,
      tserverUI: 9000 + offset,
      ysql: 5433 + offset,
      ycql: 9042 + offset,
    };
    
    console.log(`[Docker] Checking port set at offset ${offset}: YSQL=${ports.ysql}, YCQL=${ports.ycql}, UI=${ports.yugabytedUI}, Master=${ports.masterUI}, TServer=${ports.tserverUI}`);
    
    // Check if all ports in this set are available
    const checks = await Promise.all([
      isPortAvailable(ports.yugabytedUI),
      isPortAvailable(ports.masterUI),
      isPortAvailable(ports.tserverUI),
      isPortAvailable(ports.ysql),
      isPortAvailable(ports.ycql),
    ]);
    
    const allAvailable = checks.every(available => available);
    if (allAvailable) {
      console.log(`[Docker] Found available port set at offset ${offset}`);
      return ports;
    } else {
      // Log which ports are unavailable
      const unavailablePorts = [];
      if (!checks[0]) unavailablePorts.push(`YugabyteDB UI (${ports.yugabytedUI})`);
      if (!checks[1]) unavailablePorts.push(`Master UI (${ports.masterUI})`);
      if (!checks[2]) unavailablePorts.push(`TServer UI (${ports.tserverUI})`);
      if (!checks[3]) unavailablePorts.push(`YSQL (${ports.ysql})`);
      if (!checks[4]) unavailablePorts.push(`YCQL (${ports.ycql})`);
      console.log(`[Docker] Port set at offset ${offset} unavailable: ${unavailablePorts.join(", ")}`);
    }
    
    offset++;
  }
  
  throw new Error(`Could not find available port set after checking ${maxOffset} offsets`);
}

export async function findAvailablePortsForNodes(nodes: number): Promise<NodePorts[]> {
  console.log(`[Docker] ========== STARTING PORT ASSIGNMENT ==========`);
  console.log(`[Docker] Finding available ports for ${nodes} node(s)...`);
  const nodePorts: NodePorts[] = [];
  
  for (let i = 0; i < nodes; i++) {
    const defaultOffset = i;
    console.log(`[Docker] Assigning ports for node ${i + 1} (starting from offset ${defaultOffset})...`);
    const ports = await findAvailablePortSet(defaultOffset);
    nodePorts.push(ports);
    console.log(`[Docker] ✓ Assigned ports for node ${i + 1}: YSQL=${ports.ysql}, YCQL=${ports.ycql}, UI=${ports.yugabytedUI}, Master=${ports.masterUI}, TServer=${ports.tserverUI}`);
  }
  
  console.log(`[Docker] ========== PORT ASSIGNMENT COMPLETE ==========`);
  return nodePorts;
}

export async function createYugabyteCluster(
  name: string,
  nodes: number,
  version: string,
  masterGFlags?: string,
  tserverGFlags?: string,
  onProgress?: ProgressCallback
): Promise<void> {
  // Find available ports for all nodes (automatically assigns next available if conflicts)
  if (onProgress) {
    onProgress({ stage: "checking", message: "Finding available ports..." });
  }
  console.log(`[Docker] Finding available ports for ${nodes}-node cluster...`);
  const nodePorts = await findAvailablePortsForNodes(nodes);
  
  // Clean up any existing containers with the same name pattern (from previous failed attempts)
  if (onProgress) {
    onProgress({ stage: "cleanup", message: "Cleaning up existing containers..." });
  }
  console.log(`[Docker] Cleaning up any existing containers for cluster ${name}...`);
  
  // Get all containers that might conflict
  try {
    const existingContainers = await executeDockerCommand(`docker ps -a --filter "name=yb-${name}-" --format "{{.Names}}" 2>/dev/null || echo ""`);
    if (existingContainers.stdout && existingContainers.stdout.trim()) {
      const containerNames = existingContainers.stdout.trim().split('\n').filter(n => n.trim());
      console.log(`[Docker] Found ${containerNames.length} existing container(s) to clean up: ${containerNames.join(', ')}`);
      for (const containerName of containerNames) {
        try {
          await executeDockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          console.log(`[Docker] Removed container: ${containerName}`);
        } catch (error: any) {
          console.log(`[Docker] Could not remove container ${containerName}: ${error.message || error}`);
        }
      }
    }
  } catch (error: any) {
    console.log(`[Docker] Could not check for existing containers, continuing...`);
  }
  
  // Also try to remove network if it exists
  const networkName = `yb-${name}-network`;
  try {
    await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
    console.log(`[Docker] Removed network: ${networkName}`);
  } catch (error) {
    // Network doesn't exist, that's fine
  }
  
  // Network will be created in createYugabytedClusterWithHostNetwork

  // Check if image exists locally, if not, try to pull it
  if (onProgress) {
    onProgress({ stage: "image", message: `Checking for YugabyteDB image (${version})...` });
  }
  console.log(`[Docker] Checking for yugabytedb/yugabyte:${version} image...`);
  try {
    // First check if image exists locally
    try {
      await executeDockerCommand(`docker image inspect yugabytedb/yugabyte:${version} 2>/dev/null`);
      console.log(`[Docker] Image found locally`);
      if (onProgress) {
        onProgress({ stage: "image", message: `Image found locally` });
      }
    } catch (inspectError) {
      // Image doesn't exist locally, try to pull it
      if (onProgress) {
        onProgress({ stage: "image", message: `Pulling YugabyteDB image (${version})...` });
      }
      console.log(`[Docker] Image not found locally, pulling from registry...`);
      try {
        await executeDockerCommand(`docker pull yugabytedb/yugabyte:${version}`);
        if (onProgress) {
          onProgress({ stage: "image", message: `Image pulled successfully` });
        }
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
  if (onProgress) {
    onProgress({ stage: "network", message: "Creating Docker network..." });
  }
  console.log(`[Docker] Using yugabyted with host networking for ${nodes}-node cluster`);
  
  const createdContainers: string[] = [];
  
  try {
    // Always use yugabyted with custom bridge network
    await createYugabytedClusterWithHostNetwork(name, nodes, version, createdContainers, masterGFlags, tserverGFlags, onProgress, nodePorts);
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
  if (onProgress) {
    onProgress({ stage: "finalize", message: "Finalizing cluster formation..." });
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Save cluster info
  if (onProgress) {
    onProgress({ stage: "complete", message: "Cluster created successfully!" });
  }
  await saveCluster({
    name,
    nodes,
    version,
    status: "running",
    masterGFlags,
    tserverGFlags,
    nodePorts, // Store the actual ports used
  });
}

async function createYugabytedClusterWithHostNetwork(
  name: string,
  nodes: number,
  version: string,
  createdContainers: string[],
  masterGFlags?: string,
  tserverGFlags?: string,
  onProgress?: ProgressCallback,
  nodePorts?: NodePorts[]
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
  if (onProgress) {
    onProgress({ stage: "network", message: `Creating network: ${networkName}...` });
  }
  console.log(`[Docker] Creating custom bridge network: ${networkName}`);
  await executeDockerCommand(`docker network create ${networkName} 2>&1`);
  if (onProgress) {
    onProgress({ stage: "network", message: `Network created successfully` });
  }
  
  const firstNodeName = `yb-${name}-node1`;
  const firstNodeHostname = firstNodeName;
  
  for (let i = 0; i < nodes; i++) {
    const nodeName = `yb-${name}-node${i + 1}`;
    const nodeHostname = nodeName;
    
    // Use assigned ports from nodePorts if provided, otherwise fall back to default offsets
    const ports = nodePorts && nodePorts[i] ? nodePorts[i] : {
      yugabytedUI: 15433 + i,
      masterUI: 7000 + i,
      tserverUI: 9000 + i,
      ysql: 5433 + i,
      ycql: 9042 + i,
    };
    
    const masterPort = 7100 + i; // Internal port, not mapped
    const yqlPort = ports.ycql;
    const ysqlPort = ports.ysql;
    const webPort = ports.masterUI;
    const yugabytedUIPort = ports.yugabytedUI;
    const tserverPort = ports.tserverUI;
    
    console.log(`[Docker] Using ports for node ${i + 1}: YSQL=${ysqlPort}, YCQL=${yqlPort}, UI=${yugabytedUIPort}, Master=${webPort}, TServer=${tserverPort}`);
    
    // Use persistent data directory on host (like the working example)
    const os = await import("os");
    const path = await import("path");
    const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`, `node${i + 1}`);
    const containerDataDir = `/home/yugabyte/yb_data`;

    if (onProgress) {
      onProgress({ 
        stage: "node", 
        message: `Creating node ${i + 1} of ${nodes}...`,
        nodeNumber: i + 1,
        totalNodes: nodes
      });
    }
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
    
    // Add GFlags if provided
    // yugabyted accepts GFlags via --master_flags and --tserver_flags
    // Format: --master_flags="flag1=value1,flag2=value2" (comma-separated, no -- prefix)
    if (masterGFlags && masterGFlags.trim()) {
      // Process GFlags: convert spaces/newlines to commas, remove -- prefixes
      let processedMasterFlags = masterGFlags.trim()
        .split(/[\s,\n]+/)
        .map(flag => flag.trim())
        .filter(flag => flag.length > 0)
        .map(flag => flag.replace(/^--+/, '')) // Remove leading -- or -
        .join(',');
      
      // Escape quotes in GFlags and wrap in quotes
      const escapedMasterFlags = processedMasterFlags.replace(/"/g, '\\"');
      yugabytedArgs += ` --master_flags="${escapedMasterFlags}"`;
      console.log(`[Docker] Adding master GFlags to node ${i + 1}: ${processedMasterFlags}`);
    }
    if (tserverGFlags && tserverGFlags.trim()) {
      // Process GFlags: convert spaces/newlines to commas, remove -- prefixes
      let processedTserverFlags = tserverGFlags.trim()
        .split(/[\s,\n]+/)
        .map(flag => flag.trim())
        .filter(flag => flag.length > 0)
        .map(flag => flag.replace(/^--+/, '')) // Remove leading -- or -
        .join(',');
      
      // Escape quotes in GFlags and wrap in quotes
      const escapedTserverFlags = processedTserverFlags.replace(/"/g, '\\"');
      yugabytedArgs += ` --tserver_flags="${escapedTserverFlags}"`;
      console.log(`[Docker] Adding tserver GFlags to node ${i + 1}: ${processedTserverFlags}`);
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
    
    if (onProgress) {
      onProgress({ 
        stage: "node", 
        message: `Node ${i + 1} container created, starting...`,
        nodeNumber: i + 1,
        totalNodes: nodes
      });
    }
    
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
      if (onProgress) {
        onProgress({ 
          stage: "init", 
          message: `Waiting for first node to initialize...`,
          nodeNumber: 1,
          totalNodes: nodes
        });
      }
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

export async function scaleCluster(
  name: string,
  targetNodes: number,
  onProgress?: ProgressCallback
): Promise<void> {
  const cluster = await getCluster(name);
  if (!cluster) {
    throw new Error(`Cluster "${name}" not found`);
  }

  const currentNodes = cluster.nodes;
  
  if (targetNodes === currentNodes) {
    throw new Error(`Cluster already has ${targetNodes} nodes`);
  }

  if (targetNodes < 1 || targetNodes > 10) {
    throw new Error("Number of nodes must be between 1 and 10");
  }

  if (cluster.status !== "running") {
    throw new Error(`Cluster "${name}" must be running to scale. Please start it first.`);
  }

  console.log(`[Docker] Scaling cluster ${name} from ${currentNodes} to ${targetNodes} nodes`);

  if (targetNodes > currentNodes) {
    // Add nodes
    const nodesToAdd = targetNodes - currentNodes;
    if (onProgress) {
      onProgress({ stage: "scaling", message: `Adding ${nodesToAdd} node(s) to cluster...` });
    }

    const networkName = `yb-${name}-network`;
    const firstNodeName = `yb-${name}-node1`;
    const firstNodeHostname = firstNodeName;
    const createdContainers: string[] = [];

    // Get existing containers to find the last node number
    const existingContainers = await getClusterContainers(name);
    const lastNodeNumber = existingContainers.length;

    // Find available ports for new nodes
    const newNodePorts: NodePorts[] = [];
    for (let i = 0; i < nodesToAdd; i++) {
      const defaultOffset = lastNodeNumber + i;
      const ports = await findAvailablePortSet(defaultOffset);
      newNodePorts.push(ports);
      console.log(`[Docker] Assigned ports for new node ${lastNodeNumber + i + 1}: YSQL=${ports.ysql}, YCQL=${ports.ycql}, UI=${ports.yugabytedUI}`);
    }

    for (let i = 0; i < nodesToAdd; i++) {
      const nodeNumber = lastNodeNumber + i + 1;
      const nodeName = `yb-${name}-node${nodeNumber}`;
      const nodeHostname = nodeName;
      const ports = newNodePorts[i];
      
      const yugabytedUIPort = ports.yugabytedUI;
      const webPort = ports.masterUI;
      const tserverPort = ports.tserverUI;
      const ysqlPort = ports.ysql;
      const yqlPort = ports.ycql;

      const os = await import("os");
      const path = await import("path");
      const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`, `node${nodeNumber}`);
      const containerDataDir = `/home/yugabyte/yb_data`;

      if (onProgress) {
        onProgress({ 
          stage: "scaling", 
          message: `Creating node ${nodeNumber} of ${targetNodes}...`,
          nodeNumber,
          totalNodes: targetNodes
        });
      }

      // Join flag - always join to first node
      const joinFlag = `--join=${firstNodeHostname}`;

      // Build yugabyted command
      let yugabytedArgs = `--base_dir=${containerDataDir} --background=false ${joinFlag}`;

      // Add GFlags if provided
      if (cluster.masterGFlags && cluster.masterGFlags.trim()) {
        let processedMasterFlags = cluster.masterGFlags.trim()
          .split(/[\s,\n]+/)
          .map(flag => flag.trim())
          .filter(flag => flag.length > 0)
          .map(flag => flag.replace(/^--+/, ''))
          .join(',');
        const escapedMasterFlags = processedMasterFlags.replace(/"/g, '\\"');
        yugabytedArgs += ` --master_flags="${escapedMasterFlags}"`;
      }
      if (cluster.tserverGFlags && cluster.tserverGFlags.trim()) {
        let processedTserverFlags = cluster.tserverGFlags.trim()
          .split(/[\s,\n]+/)
          .map(flag => flag.trim())
          .filter(flag => flag.length > 0)
          .map(flag => flag.replace(/^--+/, ''))
          .join(',');
        const escapedTserverFlags = processedTserverFlags.replace(/"/g, '\\"');
        yugabytedArgs += ` --tserver_flags="${escapedTserverFlags}"`;
      }

      // Create data directory
      const fs = await import("fs/promises");
      try {
        await fs.mkdir(dataDir, { recursive: true });
        console.log(`[Docker] Created data directory: ${dataDir}`);
      } catch (mkdirError) {
        console.log(`[Docker] Note: Could not create data directory, continuing anyway`);
      }

      // Create container
      const yugabytedCmd = `docker run -d --name ${nodeName} \
        --network ${networkName} \
        --hostname ${nodeHostname} \
        -p ${yugabytedUIPort}:15433 \
        -p ${webPort}:7000 \
        -p ${tserverPort}:9000 \
        -p ${ysqlPort}:5433 \
        -v ${dataDir}:${containerDataDir} \
        --restart unless-stopped \
        yugabytedb/yugabyte:${cluster.version} \
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

      // Wait a bit before adding next node
      if (i < nodesToAdd - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      // Add Warp integration
      await addWarpIntegration(nodeName);
    }

    // Update cluster info with new node count and ports
    const updatedNodePorts = cluster.nodePorts ? [...cluster.nodePorts, ...newNodePorts] : newNodePorts;
    await saveCluster({
      ...cluster,
      nodes: targetNodes,
      nodePorts: updatedNodePorts,
    });

    if (onProgress) {
      onProgress({ stage: "complete", message: `Successfully scaled cluster to ${targetNodes} nodes` });
    }
  } else {
    // Remove nodes
    const nodesToRemove = currentNodes - targetNodes;
    if (onProgress) {
      onProgress({ stage: "scaling", message: `Removing ${nodesToRemove} node(s) from cluster...` });
    }

    // Get containers sorted by node number (remove from highest to lowest)
    const containers = await getClusterContainers(name);
    const containersToRemove = containers
      .sort((a, b) => {
        const aMatch = a.match(/node(\d+)/);
        const bMatch = b.match(/node(\d+)/);
        const aNum = aMatch ? parseInt(aMatch[1], 10) : 0;
        const bNum = bMatch ? parseInt(bMatch[1], 10) : 0;
        return bNum - aNum; // Sort descending
      })
      .slice(0, nodesToRemove);

    for (const containerName of containersToRemove) {
      if (onProgress) {
        const nodeMatch = containerName.match(/node(\d+)/);
        const nodeNum = nodeMatch ? parseInt(nodeMatch[1], 10) : 0;
        onProgress({ 
          stage: "scaling", 
          message: `Removing node ${nodeNum}...`,
        });
      }

      // Stop and remove container
      await executeDockerCommand(`docker stop ${containerName} 2>/dev/null || true`);
      await executeDockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);

      // Remove data directory for this node
      try {
        const nodeMatch = containerName.match(/node(\d+)/);
        if (nodeMatch) {
          const nodeNum = nodeMatch[1];
          const os = await import("os");
          const path = await import("path");
          const fs = await import("fs/promises");
          const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`, `node${nodeNum}`);
          try {
            await fs.rm(dataDir, { recursive: true, force: true });
            console.log(`[Docker] Removed data directory: ${dataDir}`);
          } catch (rmError) {
            console.log(`[Docker] Note: Could not remove data directory: ${dataDir}`);
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }

    // Update cluster info with new node count (remove ports for removed nodes)
    const updatedNodePorts = cluster.nodePorts ? cluster.nodePorts.slice(0, targetNodes) : undefined;
    await saveCluster({
      ...cluster,
      nodes: targetNodes,
      nodePorts: updatedNodePorts,
    });

    if (onProgress) {
      onProgress({ stage: "complete", message: `Successfully scaled cluster to ${targetNodes} nodes` });
    }
  }

  console.log(`[Docker] Successfully scaled cluster ${name} to ${targetNodes} nodes`);
}

export async function deleteClusterContainers(name: string): Promise<void> {
  const containers = await getClusterContainers(name);
  for (const container of containers) {
    await executeDockerCommand(`docker rm -f ${container} 2>/dev/null || true`);
  }
  const networkName = `yb-${name}-network`;
  await executeDockerCommand(`docker network rm ${networkName} 2>/dev/null || true`);
  
  // Delete the data directory
  try {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs/promises");
    const dataDir = path.join(os.homedir(), `yb_docker_data_${name}`);
    
    console.log(`[Docker] Deleting data directory: ${dataDir}`);
    try {
      await fs.access(dataDir);
      // Directory exists, delete it recursively
      await fs.rm(dataDir, { recursive: true, force: true });
      console.log(`[Docker] Successfully deleted data directory: ${dataDir}`);
    } catch (accessError) {
      // Directory doesn't exist, that's fine
      console.log(`[Docker] Data directory does not exist: ${dataDir}`);
    }
  } catch (error: any) {
    // Log error but don't fail the deletion if directory cleanup fails
    console.error(`[Docker] Error deleting data directory for cluster ${name}:`, error.message || error);
    console.log(`[Docker] Continuing with cluster deletion despite directory cleanup error`);
  }
  
  await deleteCluster(name);
}

export async function updateClusterGFlags(
  name: string,
  masterGFlags?: string,
  tserverGFlags?: string
): Promise<void> {
  const cluster = await getCluster(name);
  if (!cluster) {
    throw new Error(`Cluster "${name}" not found`);
  }

  if (cluster.status !== "running") {
    throw new Error(`Cluster "${name}" must be running to update GFlags`);
  }

  console.log(`[Docker] Updating GFlags for cluster: ${name}`);
  
  const containers = await getClusterContainers(name);
  if (containers.length === 0) {
    throw new Error(`No containers found for cluster "${name}"`);
  }

  // Update GFlags for each container
  for (const containerName of containers) {
    try {
      // Check if container is running yugabyted
      const processCheck = await executeDockerCommand(`docker exec ${containerName} ps aux 2>&1 | grep yugabyted || echo ""`);
      
      if (processCheck.stdout && processCheck.stdout.includes("yugabyted")) {
        console.log(`[Docker] Container ${containerName} uses yugabyted - GFlags update requires restart`);
        console.log(`[Docker] Note: To apply GFlags changes, you need to recreate the cluster with new GFlags`);
        throw new Error("GFlags update for yugabyted requires cluster recreation. Please recreate the cluster with new GFlags.");
      } else {
        // For separate master/tserver processes, we can update GFlags via yb-admin or config file
        console.log(`[Docker] Container ${containerName} uses separate processes - GFlags can be updated`);
        // Note: Updating GFlags for running processes requires restart or using yb-admin
        // For now, we'll save the GFlags and inform the user
      }
    } catch (error: any) {
      if (error.message && error.message.includes("requires cluster recreation")) {
        throw error;
      }
      console.log(`[Docker] Could not check process type for ${containerName}, continuing...`);
    }
  }

  // Save updated GFlags to cluster info
  await updateClusterStatus(name, cluster.status);
  const updatedCluster = { ...cluster, masterGFlags, tserverGFlags };
  await saveCluster(updatedCluster);

  console.log(`[Docker] GFlags updated for cluster: ${name}`);
  console.log(`[Docker] Note: GFlags changes require container restart to take effect`);
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
    
    // Get cluster info to check for stored ports
    const clusterName = containerName.match(/yb-(.+)-node/)?.[1];
    let ports: NodePorts;
    
    if (clusterName) {
      try {
        const cluster = await getCluster(clusterName);
        if (cluster && cluster.nodePorts && cluster.nodePorts[extractedNodeNumber - 1]) {
          // Use stored ports
          ports = cluster.nodePorts[extractedNodeNumber - 1];
        } else {
          // Fallback to calculated ports
          const nodeIndex = extractedNodeNumber - 1;
          ports = {
            masterUI: 7000 + nodeIndex,
            tserverUI: 9000 + nodeIndex,
            yugabytedUI: 15433 + nodeIndex,
            ysql: 5433 + nodeIndex,
            ycql: 9042 + nodeIndex,
          };
        }
      } catch (error) {
        // Fallback to calculated ports
        const nodeIndex = extractedNodeNumber - 1;
        ports = {
          masterUI: 7000 + nodeIndex,
          tserverUI: 9000 + nodeIndex,
          yugabytedUI: 15433 + nodeIndex,
          ysql: 5433 + nodeIndex,
          ycql: 9042 + nodeIndex,
        };
      }
    } else {
      // Fallback to calculated ports
      const nodeIndex = extractedNodeNumber - 1;
      ports = {
        masterUI: 7000 + nodeIndex,
        tserverUI: 9000 + nodeIndex,
        yugabytedUI: 15433 + nodeIndex,
        ysql: 5433 + nodeIndex,
        ycql: 9042 + nodeIndex,
      };
    }

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
