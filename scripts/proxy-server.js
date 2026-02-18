#!/usr/bin/env node
/**
 * Standalone YugabyteDB Docker Proxy Server
 *
 * Runs independently of Raycast as a background process. Proxies HTTP requests
 * to internal Docker container addresses that aren't reachable from the host.
 *
 * Usage:
 *   node scripts/proxy-server.js              # foreground
 *   npm run proxy:start                       # background (writes PID file)
 *   npm run proxy:stop                        # stop background process
 *   npm run proxy:status                      # check if running
 *
 * How it works:
 *   GET http://localhost:15080/proxy/<container-host>:<port>/<path>
 *   → docker exec <container> curl <internal-url>
 *   → response is rewritten so internal links stay routed through the proxy
 */

const http = require("http");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.YB_PROXY_PORT || "15080", 10);
const os = require("os");
const PID_FILE = path.join(os.tmpdir(), "yb-docker-proxy.pid");

// ---------------------------------------------------------------------------
// Container lookup with caching + deduplication
// ---------------------------------------------------------------------------

const containerCache = new Map();
const CACHE_TTL_MS = 10_000;
const inflightLookups = new Map();

function lookupContainer(cacheKey, cmd) {
  const entry = containerCache.get(cacheKey);
  if (entry && Date.now() < entry.expiry) return Promise.resolve(entry.value);
  containerCache.delete(cacheKey);

  const inflight = inflightLookups.get(cacheKey);
  if (inflight) return inflight;

  const promise = new Promise((resolve) => {
    exec(cmd, (err, stdout) => {
      const result = (stdout || "").trim() || null;
      containerCache.set(cacheKey, { value: result, expiry: Date.now() + CACHE_TTL_MS });
      resolve(result);
    });
  }).finally(() => inflightLookups.delete(cacheKey));

  inflightLookups.set(cacheKey, promise);
  return promise;
}

function extractClusterName(hostname) {
  const m = hostname.match(/^yb-(.+)-node\d+$/);
  return m ? m[1] : null;
}

function findContainer(targetHost) {
  const cluster = extractClusterName(targetHost);
  if (cluster) {
    return lookupContainer(
      `cluster:${cluster}`,
      `docker ps --filter "name=^yb-${cluster}-node" --format "{{.Names}}" | head -1`,
    );
  }
  return lookupContainer(`any-yb`, `docker ps --filter "name=^yb-" --format "{{.Names}}" | head -1`);
}

/**
 * List running clusters with per-node details.
 * Returns: [{ name, nodes: [{ container, num }] }]
 */
function listRunningClustersDetailed() {
  return new Promise((resolve) => {
    exec(`docker ps --filter "name=^yb-" --format "{{.Names}}\t{{.Status}}\t{{.Image}}"`, (err, stdout) => {
      const lines = (stdout || "").trim().split("\n").filter(Boolean);
      const clusterMap = new Map();
      for (const line of lines) {
        const [container, status, image] = line.split("\t");
        const cluster = extractClusterName(container);
        if (!cluster) continue;
        const nodeMatch = container.match(/node(\d+)$/);
        const num = nodeMatch ? parseInt(nodeMatch[1], 10) : 0;
        if (!clusterMap.has(cluster)) {
          clusterMap.set(cluster, { name: cluster, image: image || "", status: status || "", nodes: [] });
        }
        clusterMap.get(cluster).nodes.push({ container, num, status: status || "" });
      }
      for (const c of clusterMap.values()) {
        c.nodes.sort((a, b) => a.num - b.num);
      }
      resolve(Array.from(clusterMap.values()).sort((a, b) => a.name.localeCompare(b.name)));
    });
  });
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function shellEscape(s) {
  return s.replace(/'/g, "'\\''");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// HTTP response parsing (curl -i output → status + headers + body)
// ---------------------------------------------------------------------------

function parseHttpResponse(data) {
  const raw = data.toString("binary");

  let headerEnd = -1;
  let boundaryLen = 0;
  const crlfIdx = raw.indexOf("\r\n\r\n");
  const lfIdx = raw.indexOf("\n\n");

  if (crlfIdx >= 0 && (lfIdx < 0 || crlfIdx <= lfIdx)) {
    headerEnd = crlfIdx;
    boundaryLen = 4;
  } else if (lfIdx >= 0) {
    headerEnd = lfIdx;
    boundaryLen = 2;
  }

  if (headerEnd < 0) return { statusCode: 200, headers: {}, body: data };

  let headersStr = raw.slice(0, headerEnd);
  let bodyStart = headerEnd + boundaryLen;

  // Skip intermediate responses (100 Continue, etc.)
  while (true) {
    const afterBody = raw.slice(bodyStart);
    if (afterBody.startsWith("HTTP/")) {
      const nc = afterBody.indexOf("\r\n\r\n");
      const nl = afterBody.indexOf("\n\n");
      let ne = -1,
        nb = 0;
      if (nc >= 0 && (nl < 0 || nc <= nl)) {
        ne = nc;
        nb = 4;
      } else if (nl >= 0) {
        ne = nl;
        nb = 2;
      }
      if (ne >= 0) {
        headersStr = afterBody.slice(0, ne);
        bodyStart = bodyStart + ne + nb;
        continue;
      }
    }
    break;
  }

  const body = data.slice(bodyStart);
  const sep = headersStr.includes("\r\n") ? "\r\n" : "\n";
  const lines = headersStr.split(sep);
  const statusMatch = lines[0] && lines[0].match(/HTTP\/[\d.]+ (\d+)/);
  const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const ci = lines[i].indexOf(":");
    if (ci > 0) {
      headers[lines[i].slice(0, ci).trim()] = lines[i].slice(ci + 1).trim();
    }
  }

  return { statusCode, headers, body };
}

// ---------------------------------------------------------------------------
// HTML / header rewriting
// ---------------------------------------------------------------------------

function rewriteHtml(html, proxyOrigin, currentTarget) {
  html = html.replace(
    /(https?:)?\/\/(yb-[a-zA-Z0-9_-]+-node\d+:\d+)/g,
    (_m, _s, hp) => `${proxyOrigin}/proxy/${hp}`,
  );
  html = html.replace(/((?:href|src|action)\s*=\s*["'])\/((?!proxy\/)[^"']*)/gi, `$1/proxy/${currentTarget}/$2`);
  return html;
}

function rewriteLocation(location, proxyOrigin, currentTarget) {
  const r = location.replace(/^(https?:)?\/\/(yb-[a-zA-Z0-9_-]+-node\d+:\d+)/, `${proxyOrigin}/proxy/$2`);
  if (r !== location) return r;
  if (location.startsWith("/")) return `/proxy/${currentTarget}${location}`;
  return location;
}

const SKIP_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
]);

// ---------------------------------------------------------------------------
// Safe response helpers
// ---------------------------------------------------------------------------

function safeEnd(res, statusCode, message) {
  try {
    if (!res.headersSent) res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!DOCTYPE html><html><head><title>Proxy Error</title></head><body>` +
        `<h2>${escapeHtml(message)}</h2>` +
        `<p><a href="javascript:history.back()">Go back</a> · <a href="/">Landing page</a></p>` +
        `</body></html>`,
    );
  } catch {
    try {
      res.destroy();
    } catch {
      /* nothing */
    }
  }
}

function isResponseDone(res) {
  return res.writableEnded || res.destroyed;
}

// ---------------------------------------------------------------------------
// Core proxy handler
// ---------------------------------------------------------------------------

const YB_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 233" fill="none"><path d="M14 0h57.3c4.1 0 6.4.2 8.3 1.1a10 10 0 0 1 4.6 4.6c1.1 2.2 1.1 5.1 1.1 11l0 76.6c0 6.6-.2 10.2-1.8 12.5a14 14 0 0 1-6.9 4.4c-2.8.5-6.1-.8-12.1-3.6L33.3 92c-9.9-4.7-15.6-7.8-20-12.1a44 44 0 0 1-10.8-16.8C.5 57.3.1 50.8 0 39.9V14c0-4.1.2-6.4 1.1-8.3A10 10 0 0 1 5.7 1.1C7.6.2 9.9 0 14 0zm170.7 0H242c4.1 0 6.4.2 8.3 1.1a10 10 0 0 1 4.6 4.6c1.1 2.2 1.1 5.1 1.1 11v23.1c-.1 11-.5 17.4-2.5 23.3a44 44 0 0 1-10.8 16.8c-5.4 5.3-12.9 8.8-27.7 15.8l-44.4 20.6V14c0-4.1.2-6.4 1.1-8.3a10 10 0 0 1 4.6-4.6C178.2.2 180.5 0 184.7 0zm-58.4 137l44.3-20.6v102.4c0 4.1-.2 6.4-1.1 8.3a10 10 0 0 1-4.6 4.6c-2.2 1.1-5.1 1.1-11 1.1H99.3c-4.1 0-6.4-.2-8.3-1.1a10 10 0 0 1-4.6-4.6c-1.1-2.2-1.1-5.1-1.1-11v-23.2c.1-11 .5-17.4 2.5-23.3a44 44 0 0 1 10.8-16.8c5.4-5.3 12.9-8.8 27.7-15.8z" fill="#FF5F3B"/></svg>`;

function handleProxy(req, res, proxyOrigin) {
  const url = req.url || "/";
  const PREFIX = "/proxy/";

  // Serve favicon
  if (url === "/favicon.ico" || url === "/favicon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    res.end(YB_FAVICON_SVG);
    return;
  }

  if (!url.startsWith(PREFIX)) {
    serveLandingPage(res, proxyOrigin);
    return;
  }

  const remainder = url.slice(PREFIX.length);
  const firstSlash = remainder.indexOf("/");
  const hostPort = firstSlash >= 0 ? remainder.slice(0, firstSlash) : remainder;
  const pathAndQuery = firstSlash >= 0 ? remainder.slice(firstSlash) : "/";

  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon < 1 || lastColon === hostPort.length - 1) {
    serveLandingPage(res, proxyOrigin);
    return;
  }

  const targetHost = hostPort.slice(0, lastColon);
  const targetPort = hostPort.slice(lastColon + 1);
  if (!/^\d+$/.test(targetPort)) {
    serveLandingPage(res, proxyOrigin);
    return;
  }

  const target = `${targetHost}:${targetPort}`;
  const targetUrl = `http://${target}${pathAndQuery}`;

  console.log(`[Proxy] ${req.method} ${target}${pathAndQuery}`);

  const timer = setTimeout(() => {
    if (!isResponseDone(res)) {
      console.warn(`[Proxy] Timeout: ${target}${pathAndQuery}`);
      safeEnd(res, 504, `Timeout fetching ${target}`);
    }
  }, 60_000);

  findContainer(targetHost)
    .then((container) => {
      if (isResponseDone(res)) {
        clearTimeout(timer);
        return;
      }
      if (!container) {
        clearTimeout(timer);
        const cluster = extractClusterName(targetHost);
        safeEnd(res, 502, `No running containers found${cluster ? ` for cluster "${cluster}"` : ""}`);
        return;
      }

      const escaped = shellEscape(targetUrl);
      const cmd = `docker exec ${container} curl -sS -i --connect-timeout 5 --max-time 30 '${escaped}'`;

      exec(cmd, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
        clearTimeout(timer);
        if (isResponseDone(res)) return;

        try {
          if (error) {
            const msg = (stderr && stderr.toString()) || error.message;
            console.error(`[Proxy] curl error for ${target}: ${msg}`);
            safeEnd(res, 502, `Could not reach ${target}: ${msg}`);
            return;
          }

          const { statusCode, headers, body } = parseHttpResponse(stdout);
          const outHeaders = {};
          for (const [name, value] of Object.entries(headers)) {
            if (SKIP_HEADERS.has(name.toLowerCase())) continue;
            outHeaders[name] = value;
          }

          if (statusCode >= 300 && statusCode < 400) {
            const loc = headers["Location"] || headers["location"];
            if (loc) outHeaders["Location"] = rewriteLocation(loc, proxyOrigin, target);
          }

          const ct = headers["Content-Type"] || headers["content-type"] || "application/octet-stream";

          // Cache static assets so the browser doesn't re-fetch via docker exec
          if (!ct.includes("text/html")) {
            outHeaders["Cache-Control"] = "public, max-age=3600";
          }

          if (isResponseDone(res)) return;

          if (ct.includes("text/html")) {
            const html = rewriteHtml(body.toString("utf-8"), proxyOrigin, target);
            outHeaders["Content-Type"] = ct;
            res.writeHead(statusCode, outHeaders);
            res.end(html);
          } else {
            res.writeHead(statusCode, outHeaders);
            res.end(body);
          }
        } catch (err) {
          console.error("[Proxy] Error processing response:", err);
          safeEnd(res, 500, "Error processing proxied response");
        }
      });
    })
    .catch((err) => {
      clearTimeout(timer);
      console.error("[Proxy] Container lookup error:", err);
      safeEnd(res, 502, "Error finding running container");
    });
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

function serveLandingPage(res, proxyOrigin) {
  listRunningClustersDetailed()
    .catch(() => [])
    .then((clusters) => {
      if (isResponseDone(res)) return;

      const clusterCards = clusters.length > 0
        ? clusters.map((c) => {
          const version = (c.image || "").split(":")[1] || "unknown";
          const nodeItems = c.nodes.map((n) => `
            <div class="node">
              <div class="node-head">
                <span class="dot"></span>
                <span class="node-name">${escapeHtml(n.container)}</span>
              </div>
              <div class="node-links">
                <a href="/proxy/${escapeHtml(n.container)}:7000/" class="pill master" title="Master Web UI">Master</a>
                <a href="/proxy/${escapeHtml(n.container)}:9000/" class="pill tserver" title="TServer Web UI">TServer</a>
                <a href="/proxy/${escapeHtml(n.container)}:15433/" class="pill ybui" title="YugabyteDB UI">YBDB UI</a>
                <a href="/proxy/${escapeHtml(n.container)}:7100/" class="pill rpc" title="Master RPC">M-RPC</a>
                <a href="/proxy/${escapeHtml(n.container)}:9100/" class="pill rpc" title="TServer RPC">T-RPC</a>
              </div>
            </div>`).join("");

          return `
          <div class="card">
            <div class="card-top">
              <div class="card-info">
                <span class="card-name">${escapeHtml(c.name)}</span>
                <span class="card-meta">${c.nodes.length}N &middot; v${escapeHtml(version)}</span>
              </div>
              <span class="badge">Running</span>
            </div>
            <div class="nodes">${nodeItems}</div>
          </div>`;
        }).join("")
        : `<div class="empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
            <p>No running clusters</p>
            <p class="hint">Start a cluster to see it here</p>
          </div>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YugabyteDB Docker Proxy</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    :root {
      --bg: #f5f6f8;
      --surface: #ffffff;
      --surface2: #f0f1f4;
      --border: #e2e4ea;
      --text: #1a1d2b;
      --muted: #6b7085;
      --orange: #FF5F3B;
      --orange-dim: rgba(255,95,59,.08);
      --orange-mid: rgba(255,95,59,.15);
      --blue: #2563eb;
      --blue-dim: rgba(37,99,235,.08);
      --teal: #0d9488;
      --teal-dim: rgba(13,148,136,.08);
      --green: #16a34a;
      --green-glow: rgba(22,163,74,.25);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    /* ---- HEADER ---- */
    .hdr {
      padding: 28px 20px 22px;
      text-align: center;
      background: #fff;
      border-bottom: 1px solid var(--border);
    }
    .hdr-inner { max-width: 720px; margin: 0 auto; }

    .brand {
      display: inline-flex; align-items: center; gap: 10px;
    }
    .brand svg { flex-shrink: 0; }
    .brand h1 {
      font-size: 17px; font-weight: 700; letter-spacing: -0.2px;
    }
    .brand h1 span { color: var(--orange); }

    .tagline {
      margin-top: 6px; font-size: 13px; color: var(--muted); line-height: 1.4;
    }

    .url-hint {
      margin-top: 12px; display: inline-block;
      background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
      padding: 5px 14px;
      font: 12px/1.4 "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--muted);
    }
    .url-hint b { color: var(--orange); font-weight: 600; }

    /* ---- MAIN ---- */
    .main { max-width: 720px; margin: 0 auto; padding: 20px 20px 48px; }

    .toolbar {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .toolbar-label {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.7px; color: var(--muted);
    }
    .btn-refresh {
      background: var(--surface); border: 1px solid var(--border);
      color: var(--muted); font: 500 11px/1 system-ui, sans-serif;
      padding: 4px 10px; border-radius: 5px; cursor: pointer;
      transition: .15s;
    }
    .btn-refresh:hover { color: var(--text); border-color: var(--orange); }

    /* ---- CARD ---- */
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,.04);
      transition: border-color .15s, box-shadow .15s;
    }
    .card:hover { border-color: #cdd0d9; box-shadow: 0 2px 8px rgba(0,0,0,.07); }

    .card-top {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    .card-info { display: flex; align-items: baseline; gap: 8px; }
    .card-name { font-size: 14px; font-weight: 600; }
    .card-meta { font-size: 11px; color: var(--muted); }

    .badge {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; padding: 2px 8px; border-radius: 10px;
      background: rgba(52,211,153,.12); color: var(--green);
    }

    /* ---- NODES ---- */
    .nodes { padding: 6px 14px 8px; }

    .node {
      display: flex; align-items: center; gap: 10px;
      padding: 5px 0;
    }
    .node + .node { border-top: 1px solid var(--border); }

    .node-head {
      display: flex; align-items: center; gap: 6px;
      min-width: 0; flex-shrink: 0;
    }
    .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 5px var(--green-glow);
      flex-shrink: 0;
    }
    .node-name {
      font: 500 11.5px/1 "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--text);
    }

    .node-links {
      display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto;
    }

    .pill {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 10.5px; font-weight: 600; text-decoration: none;
      transition: .12s; white-space: nowrap; letter-spacing: 0.1px;
    }
    .pill.master  { background: var(--orange-dim); color: var(--orange); }
    .pill.master:hover  { background: var(--orange-mid); }
    .pill.tserver { background: var(--blue-dim); color: var(--blue); }
    .pill.tserver:hover { background: rgba(59,125,221,.22); }
    .pill.ybui    { background: var(--teal-dim); color: var(--teal); }
    .pill.ybui:hover    { background: rgba(45,205,164,.22); }
    .pill.rpc     { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
    .pill.rpc:hover     { color: var(--text); background: var(--border); border-color: var(--border); }

    /* ---- EMPTY ---- */
    .empty {
      text-align: center; padding: 48px 20px; color: var(--muted);
    }
    .empty svg { margin-bottom: 12px; opacity: .4; }
    .empty p { font-size: 14px; margin-bottom: 4px; }
    .empty .hint { font-size: 12px; opacity: .6; }

    /* ---- FOOTER ---- */
    .footer {
      text-align: center; padding: 16px; font-size: 11px; color: var(--muted); opacity: .4;
    }

    @media (max-width: 520px) {
      .node { flex-direction: column; align-items: flex-start; gap: 4px; }
      .node-links { margin-left: 12px; }
    }
  </style>
</head>
<body>
  <div class="hdr"><div class="hdr-inner">
    <div class="brand">
      <svg class="yb-logo" width="26" height="24" viewBox="0 0 256 233" fill="none">
        <path d="M14 0h57.3c4.1 0 6.4.2 8.3 1.1a10 10 0 0 1 4.6 4.6c1.1 2.2 1.1 5.1 1.1 11l0 76.6c0 6.6-.2 10.2-1.8 12.5a14 14 0 0 1-6.9 4.4c-2.8.5-6.1-.8-12.1-3.6L33.3 92c-9.9-4.7-15.6-7.8-20-12.1a44 44 0 0 1-10.8-16.8C.5 57.3.1 50.8 0 39.9V14c0-4.1.2-6.4 1.1-8.3A10 10 0 0 1 5.7 1.1C7.6.2 9.9 0 14 0zm170.7 0H242c4.1 0 6.4.2 8.3 1.1a10 10 0 0 1 4.6 4.6c1.1 2.2 1.1 5.1 1.1 11v23.1c-.1 11-.5 17.4-2.5 23.3a44 44 0 0 1-10.8 16.8c-5.4 5.3-12.9 8.8-27.7 15.8l-44.4 20.6V14c0-4.1.2-6.4 1.1-8.3a10 10 0 0 1 4.6-4.6C178.2.2 180.5 0 184.7 0zm-58.4 137l44.3-20.6v102.4c0 4.1-.2 6.4-1.1 8.3a10 10 0 0 1-4.6 4.6c-2.2 1.1-5.1 1.1-11 1.1H99.3c-4.1 0-6.4-.2-8.3-1.1a10 10 0 0 1-4.6-4.6c-1.1-2.2-1.1-5.1-1.1-11v-23.2c.1-11 .5-17.4 2.5-23.3a44 44 0 0 1 10.8-16.8c5.4-5.3 12.9-8.8 27.7-15.8z" fill="#FF5F3B"/>
      </svg>
      <h1>Yugabyte<span>DB</span> Docker Proxy</h1>
    </div>
    <p class="tagline">Forwards requests to internal Docker container web UIs</p>
    <div class="url-hint"><b>/proxy/</b>&lt;host&gt;:&lt;port&gt;/path</div>
  </div></div>

  <div class="main">
    <div class="toolbar">
      <span class="toolbar-label">Clusters (${clusters.length})</span>
      <button class="btn-refresh" onclick="location.reload()">Refresh</button>
    </div>
    ${clusterCards}
  </div>

  <div class="footer">localhost:${PORT}</div>
</body>
</html>`);
    });
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function startServer() {
  const proxyOrigin = `http://localhost:${PORT}`;

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      handleProxy(req, res, proxyOrigin);
    } catch (err) {
      console.error("[Proxy] Unexpected error:", err);
      safeEnd(res, 500, "Internal proxy error");
    }
  });

  server.on("connection", (socket) => {
    socket.on("error", (err) => {
      console.warn("[Proxy] Socket error (ignored):", err.message);
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  Port ${PORT} is already in use.`);
      console.error(`  Another proxy instance may be running. Use: npm run proxy:stop\n`);
      process.exit(1);
    }
    console.error("[Proxy] Server error:", err);
    process.exit(1);
  });

  server.listen(PORT, "127.0.0.1", () => {
    // Write PID file for easy stop
    fs.writeFileSync(PID_FILE, String(process.pid));

    console.log(`\n  YugabyteDB Docker Proxy running on ${proxyOrigin}`);
    console.log(`  PID: ${process.pid}`);
    console.log(`\n  Landing page: ${proxyOrigin}/`);
    console.log(`  Example:      ${proxyOrigin}/proxy/yb-<cluster>-node1:7000/\n`);
  });

  // Clean up PID file on exit
  function cleanup() {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ok */
    }
    process.exit(0);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

startServer();
