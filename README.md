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

## Managing GFlags

You can manage YB-Master and YB-TServer GFlags from the **Manage Clusters** command. Select a cluster and use the actions in the **Cluster Management** section of the action panel:

| Action | Shortcut | Description |
|---|---|---|
| **Set GFlags** | `⌘G` | Add a new flag or overwrite an existing one |
| **Update GFlags** | `⇧⌘U` | Edit the value of an existing flag (pre-fills current value) |
| **Remove GFlags** | `⇧⌘G` | Remove one or more flags |

### Create with GFlags

When creating a cluster, you can specify GFlags in the **Master GFlags** and **TServer GFlags** text areas. Enter **one flag per line** in `name=value` format:

```
ysql_max_connections=400
pg_yb_session_timeout_ms=1200000
ysql_pg_conf_csv="shared_preload_libraries=passwordcheck,auto_explain",pgaudit.log=ROLE
```

Because each flag is on its own line, commas in a value (like `ysql_pg_conf_csv` above) are never confused with flag separators. No special escaping or `{}` wrapping is needed.

### Set / Update GFlags

Both **Set** and **Update** accept a flag name and value, along with:

| Field | Description |
|---|---|
| **Server Type** | Both (Master & TServer), YB-Master, or YB-TServer |
| **Mode** | Runtime (no restart) or Cluster Restart |

**Runtime mode** applies the flag immediately on all nodes using `yb-ts-cli set_flag --force` without downtime. The flag is also saved to the cluster configuration so it persists on subsequent restarts.

**Cluster Restart mode** stops all nodes, writes the updated flag into each node's `yugabyted.conf`, then starts all nodes back. This is required for flags that don't support runtime changes (e.g. `ysql_pg_conf_csv`).

### Remove GFlags

Select one or more flags to remove. Choose **Cluster Restart** mode to stop the cluster, remove the flags from `yugabyted.conf`, and restart — guaranteeing the flags are fully cleared. **Remove from Metadata Only** removes the flags from stored configuration without restarting; they take effect on the next restart.

### Complex flags with commas

Flags like `ysql_pg_conf_csv` and `ysql_hba_conf_csv` take comma-separated PostgreSQL configuration values. The tool handles these automatically — just enter the raw value without any shell escaping.

#### In the creation form (text area)

Each flag is on its own line, so commas in the value are unambiguous:

```
ysql_pg_conf_csv="shared_preload_libraries=passwordcheck,auto_explain",pgaudit.log=ROLE
ysql_max_connections=400
```

No `{}` wrapping or `\"` escaping is needed.

#### In Set / Update GFlags forms

Enter the flag name and value in their separate fields:

- **Flag Name:** `ysql_pg_conf_csv`
- **Flag Value:** `"shared_preload_libraries=passwordcheck,auto_explain",pgaudit.log=ROLE`

> **Important:** Do **not** escape quotes with backslashes (`\"`). Enter the value exactly as you would pass it to `--ysql_pg_conf_csv` directly. The tool handles all shell escaping automatically.

#### What happens under the hood

The tool automatically wraps values containing commas in `{}` when passing them to yugabyted's `--tserver_flags` / `--master_flags`. For example, the above value produces:

```
--tserver_flags="ysql_pg_conf_csv={\"shared_preload_libraries=passwordcheck,auto_explain\",pgaudit.log=ROLE}"
```

This is the [documented yugabyted convention](https://docs.yugabyte.com/stable/reference/configuration/yugabyted/) for CSV-value flags.

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
