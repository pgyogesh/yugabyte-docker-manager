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

function listRunningClusters() {
  return new Promise((resolve) => {
    exec(`docker ps --filter "name=^yb-" --format "{{.Names}}"`, (err, stdout) => {
      const names = (stdout || "").trim().split("\n").filter(Boolean);
      const clusters = new Set();
      for (const n of names) {
        const c = extractClusterName(n);
        if (c) clusters.add(c);
      }
      resolve(Array.from(clusters).sort());
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

function handleProxy(req, res, proxyOrigin) {
  const url = req.url || "/";
  const PREFIX = "/proxy/";

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
  listRunningClusters()
    .catch(() => [])
    .then((clusters) => {
      const links =
        clusters.length > 0
          ? clusters
              .map(
                (c) => `
      <div style="margin-bottom: 18px;">
        <h3 style="margin-bottom: 6px;">Cluster: <em>${escapeHtml(c)}</em></h3>
        <ul style="margin-top: 0;">
          <li><a href="/proxy/yb-${escapeHtml(c)}-node1:7000/">Master Web UI (:7000)</a></li>
          <li><a href="/proxy/yb-${escapeHtml(c)}-node1:9000/">TServer Web UI (:9000)</a></li>
          <li><a href="/proxy/yb-${escapeHtml(c)}-node1:15433/">YugabyteDB UI (:15433)</a></li>
          <li><a href="/proxy/yb-${escapeHtml(c)}-node1:7100/">Master RPC UI (:7100)</a></li>
          <li><a href="/proxy/yb-${escapeHtml(c)}-node1:9100/">TServer RPC UI (:9100)</a></li>
        </ul>
      </div>`,
              )
              .join("\n")
          : `<p><em>No running clusters found.</em></p>`;

      if (isResponseDone(res)) return;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>YugabyteDB Docker Proxy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 640px; margin: 60px auto; padding: 0 20px; color: #333; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    a    { color: #1a73e8; }
    h1   { font-size: 1.6em; }
    h3   { font-size: 1.1em; }
  </style>
</head>
<body>
  <h1>YugabyteDB Docker Proxy</h1>
  <p>This proxy forwards requests to internal Docker container addresses that
     are not directly reachable from the host.</p>
  <h3>Usage</h3>
  <p><code>/proxy/&lt;container-hostname&gt;:&lt;port&gt;/&lt;path&gt;</code></p>
  ${links}
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
