/**
 * Proxy URL helpers for the Raycast extension.
 *
 * The actual proxy server runs as a standalone Node process outside of
 * Raycast (see scripts/proxy-server.js). This module provides utility
 * functions for building proxy URLs and checking proxy status.
 */

import http from "http";
import fs from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import { environment } from "@raycast/api";

const execAsync = promisify(exec);
const DEFAULT_PROXY_PORT = 15080;

export function getProxyPort(): number {
  return DEFAULT_PROXY_PORT;
}

export function getProxyUrl(): string {
  return `http://localhost:${DEFAULT_PROXY_PORT}`;
}

/**
 * Build a proxied URL for an internal Docker container address.
 *
 * @example buildProxyUrl("yb-demo-node1", 7000) => "http://localhost:15080/proxy/yb-demo-node1:7000/"
 */
export function buildProxyUrl(containerName: string, port: number, p = "/"): string {
  return `http://localhost:${DEFAULT_PROXY_PORT}/proxy/${containerName}:${port}${p}`;
}

/**
 * Check if the standalone proxy server is currently reachable.
 */
export function checkProxyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${DEFAULT_PROXY_PORT}/`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Start the standalone proxy server as a detached background process.
 * Returns true if the proxy is running after the attempt.
 */
export async function launchProxy(): Promise<boolean> {
  if (await checkProxyRunning()) return true;

  const proxyScript = resolveProxyScript();
  if (!proxyScript) {
    throw new Error(
      `proxy-server.js not found. Searched:\n` +
        candidateProxyPaths()
          .map((p) => `  ${p} ${fs.existsSync(p) ? "✓" : "✗"}`)
          .join("\n"),
    );
  }

  const child = spawn(process.execPath, [proxyScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Give it a moment to start
  await new Promise((r) => setTimeout(r, 1500));
  return checkProxyRunning();
}

/** Return candidate paths where proxy-server.js might live. */
function candidateProxyPaths(): string[] {
  const inAssets = path.join(environment.assetsPath, "proxy-server.js");
  const inScripts = path.resolve(environment.assetsPath, "..", "scripts", "proxy-server.js");
  const fromDirname = path.resolve(__dirname, "..", "scripts", "proxy-server.js");
  return [inAssets, inScripts, fromDirname];
}

/** Find the proxy-server.js script by checking several candidate locations. */
function resolveProxyScript(): string | null {
  for (const p of candidateProxyPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Stop the standalone proxy server.
 * Tries the PID file first, then falls back to lsof (with full path for Raycast).
 */
import os from "os";

const PID_FILE = path.join(os.tmpdir(), "yb-docker-proxy.pid");

export async function killProxy(): Promise<void> {
  let killed = false;

  // 1. Try the PID file written by proxy-server.js
  if (fs.existsSync(PID_FILE)) {
    const pid = fs.readFileSync(PID_FILE, "utf-8").trim();
    if (pid) {
      try {
        process.kill(parseInt(pid, 10), "SIGTERM");
        killed = true;
      } catch {
        // process already gone
      }
      try {
        fs.unlinkSync(PID_FILE);
      } catch {
        // ok
      }
    }
  }

  // 2. Fallback: find process by port (use full path for Raycast's minimal PATH)
  if (!killed) {
    try {
      const { stdout } = await execAsync(`/usr/sbin/lsof -ti:${DEFAULT_PROXY_PORT}`);
      const pids = stdout.trim().split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
          killed = true;
        } catch {
          // already exited
        }
      }
    } catch {
      // lsof not found or no process on port
    }
  }

  if (!killed) {
    throw new Error("Could not find proxy process to stop");
  }

  // Wait briefly for the process to exit
  await new Promise((r) => setTimeout(r, 500));
}
