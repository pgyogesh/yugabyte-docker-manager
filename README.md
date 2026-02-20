# Yugabyte Docker Manager

A [Raycast](https://raycast.com) extension to create, manage, and connect to [YugabyteDB](https://www.yugabyte.com/) clusters running in Docker containers.

## Features

- **Create clusters** with configurable node count, version, and GFlags
- **Manage clusters** — start, stop, restart, scale, delete, and set GFlags
- **View services** — per-node process status, ports, and web UI links
- **Web UI proxy** — access internal Docker web UIs (Master, TServer, YugabyteDB UI) from your browser
- **Terminal integration** — open `ysqlsh` or `ycqlsh` shells in Ghostty, iTerm2, or Terminal.app
- **AI tools** — query clusters, run SQL, and execute admin commands via Raycast AI

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [Raycast](https://raycast.com) installed

## Commands

| Command | Description |
|---|---|
| **Create Cluster** | Create a new YugabyteDB cluster with specified nodes, version, and GFlags |
| **Manage Clusters** | List all clusters with actions to start, stop, restart, scale, or delete |
| **View Cluster Services** | Inspect per-node service status, ports, and connection strings |
| **Manage Web UI Proxy** | Start, stop, or check status of the local proxy server |

## Web UI Proxy

YugabyteDB's web UIs (Master UI on port 7000, TServer UI on port 9000, etc.) generate internal links that reference Docker container hostnames like `yb-my-cluster-node1:7000`. These hostnames aren't resolvable from the host machine.

The proxy server solves this by running a local HTTP server on `localhost:15080` that forwards requests into the Docker network:

```
http://localhost:15080/proxy/yb-my-cluster-node1:7000/
  → docker exec <container> curl http://yb-my-cluster-node1:7000/
```

All internal links in the HTML are automatically rewritten to route through the proxy.

### Starting the proxy

**From Raycast:** Search for "Manage Web UI Proxy" and use the Start action.

**From the terminal:**

```bash
# Background
npm run proxy:start

# Foreground (see logs)
npm run proxy

# Check status
npm run proxy:status

# Stop
npm run proxy:stop

# Restart
npm run proxy:restart
```

### Landing page

Once running, open [http://localhost:15080](http://localhost:15080) to see the proxy landing page. It auto-discovers all running clusters and displays:

- Cluster name, node count, and YugabyteDB version
- Per-node quick links to **Master UI**, **TServer UI**, **YBDB UI**, and **RPC endpoints**
- Live status indicators for each node

The page provides one-click access to every web UI across all your clusters.

## AI Tools

The extension exposes tools that Raycast AI can use to interact with your clusters:

| Tool | Description |
|---|---|
| **Get Clusters** | List all clusters with status, version, and node count |
| **Get Cluster Details** | Ports, GFlags, and connection strings for a specific cluster |
| **Get Cluster Services** | Live process status for each node |
| **Run Yb-Admin Command** | Execute `yb-admin` commands (master list, tablet info, load balancer, etc.) |
| **Run Ysqlsh Query** | Run SQL queries or `\d`-style meta-commands |
| **Run Yb-Ts-Cli Command** | Tablet server diagnostics (list tablets, server readiness, etc.) |

## Setting GFlags

You can modify YB-Master and YB-TServer GFlags on a running cluster from the **Manage Clusters** command. Select a cluster, then choose **Set GFlags** (`⌘G`) from the action panel.

### Options

| Field | Description |
|---|---|
| **Server Type** | Both (Master & TServer), YB-Master, or YB-TServer |
| **Flag Name** | The GFlag name (e.g. `emergency_repair_mode`) |
| **Flag Value** | The value to set (e.g. `true`) |
| **Mode** | Runtime (no restart) or Cluster Restart |

### Runtime mode

Applies the flag immediately on all nodes using `yb-ts-cli set_flag --force` without any downtime. The flag is also saved to the cluster configuration so it persists in subsequent restarts.

- Masters: `yb-ts-cli --server_address <node>:7100 set_flag --force <flag> <value>`
- TServers: `yb-ts-cli --server_address <node>:9100 set_flag --force <flag> <value>`

### Cluster Restart mode

Stops all nodes, writes the updated flag into each node's `yugabyted.conf` (located in the host-mounted data volume), then starts all nodes back. On startup `yugabyted` reads the conf file and applies the new flags automatically. After all nodes are started the extension waits for `list_all_tablet_servers` to confirm the cluster is healthy.

## Configuration

Open Raycast Settings → Extensions → Yugabyte Docker Manager to configure:

- **Terminal Application** — choose between auto-detect, Ghostty, iTerm2, or Terminal.app for shell connections

## Development

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Lint
npm run lint

# Build
npm run build
```
