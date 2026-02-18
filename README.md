# Yugabyte Docker Manager

A [Raycast](https://raycast.com) extension to create, manage, and connect to [YugabyteDB](https://www.yugabyte.com/) clusters running in Docker containers.

## Features

- **Create clusters** with configurable node count, version, and GFlags
- **Manage clusters** — start, stop, restart, scale, and delete
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

Once running, the proxy's landing page at [http://localhost:15080](http://localhost:15080) lists all running clusters with quick links to their web UIs.

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
