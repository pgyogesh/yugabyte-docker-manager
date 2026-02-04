import { Action, ActionPanel, Form, showToast, Toast, Icon, open } from "@raycast/api";
import { useState, useEffect, useRef } from "react";
import { createYugabyteCluster, ProgressCallback } from "./utils/docker";

interface YugabyteRelease {
  name: string;
  tag: string;
}

export default function Command() {
  const [isLoading, setIsLoading] = useState(false);
  const [releases, setReleases] = useState<YugabyteRelease[]>([]);
  const [isLoadingReleases, setIsLoadingReleases] = useState(true);
  const toastRef = useRef<Toast | null>(null);

  async function fetchReleases() {
    try {
      setIsLoadingReleases(true);
      console.log("[Create Cluster] Fetching YugabyteDB releases...");
      
      // Fetch tags from Docker Hub API - get more pages to find valid versions
      let allTags: any[] = [];
      let nextUrl = "https://hub.docker.com/v2/repositories/yugabytedb/yugabyte/tags?page_size=100&ordering=-last_updated";
      let pageCount = 0;
      const maxPages = 5; // Fetch up to 5 pages (500 tags)
      
      while (nextUrl && pageCount < maxPages) {
        const response = await fetch(nextUrl);
        const data = await response.json();
        
        if (data.results && Array.isArray(data.results)) {
          allTags = allTags.concat(data.results);
          nextUrl = data.next; // Get next page URL
          pageCount++;
        } else {
          break;
        }
      }
      
      console.log(`[Create Cluster] Fetched ${allTags.length} tags from Docker Hub`);
      
      // Filter to only valid YugabyteDB version tags
      const validReleases: YugabyteRelease[] = allTags
        .filter((tag: any) => {
          const tagName = tag.name || "";
          
          // Exclude invalid patterns
          if (
            tagName.includes("rc") || // Release candidates
            tagName.includes("alpha") ||
            tagName.includes("beta") ||
            tagName.includes("dev") ||
            tagName.includes("test") ||
            tagName.includes("nightly") ||
            tagName.includes("snapshot") ||
            tagName.startsWith("v2.") || // Old version format
            tagName.match(/^\d+\.\d+$/) || // Incomplete versions like "2.20"
            tagName.match(/^[a-z]/) && tagName !== "latest" // Tags starting with letters (except latest)
          ) {
            return false;
          }
          
          // Include only valid version patterns:
          // - "latest"
          // - Full version: X.Y.Z.W (e.g., 2.20.0.0)
          // - Full version with build: X.Y.Z.W-bN (e.g., 2025.2.0.0-b131)
          // - Must have at least 3 version components
          return (
            tagName === "latest" ||
            /^\d+\.\d+\.\d+\.\d+(-b\d+)?$/.test(tagName) || // Full version with optional build
            /^\d{4}\.\d+\.\d+\.\d+(-b\d+)?$/.test(tagName) // Year-based version (2025.2.0.0-b131)
          );
        })
        .map((tag: any) => ({
          name: tag.name === "latest" ? "Latest" : tag.name,
          tag: tag.name,
        }));
      
      // Sort versions: latest first, then by version number (newest first)
      validReleases.sort((a, b) => {
        if (a.tag === "latest") return -1;
        if (b.tag === "latest") return 1;
        
        // Parse version numbers for proper sorting
        const parseVersion = (tag: string): number[] => {
          const match = tag.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(-b(\d+))?$/);
          if (match) {
            return [
              parseInt(match[1], 10),
              parseInt(match[2], 10),
              parseInt(match[3], 10),
              parseInt(match[4], 10),
              match[6] ? parseInt(match[6], 10) : 0,
            ];
          }
          return [0, 0, 0, 0, 0];
        };
        
        const aVersion = parseVersion(a.tag);
        const bVersion = parseVersion(b.tag);
        
        for (let i = 0; i < 5; i++) {
          if (aVersion[i] !== bVersion[i]) {
            return bVersion[i] - aVersion[i]; // Descending order (newest first)
          }
        }
        return 0;
      });
      
      // Limit to top 30 most recent valid releases
      const topReleases = validReleases.slice(0, 30);
      
      setReleases(topReleases);
      console.log(`[Create Cluster] Found ${topReleases.length} valid releases`);
      console.log(`[Create Cluster] Sample releases:`, topReleases.slice(0, 5).map(r => r.tag));
      
      // Show success feedback
      await showToast({
        style: Toast.Style.Success,
        title: "Releases Refreshed",
        message: `Found ${topReleases.length} available versions`,
      });
    } catch (error: any) {
      console.error("[Create Cluster] Error fetching releases:", error.message || error);
      // Fallback to known good versions
      setReleases([
        { name: "Latest", tag: "latest" },
        { name: "2025.2.0.0-b131", tag: "2025.2.0.0-b131" },
        { name: "2.20.0.0", tag: "2.20.0.0" },
        { name: "2.19.3.0", tag: "2.19.3.0" },
        { name: "2.19.2.0", tag: "2.19.2.0" },
        { name: "2.19.1.0", tag: "2.19.1.0" },
        { name: "2.18.4.0", tag: "2.18.4.0" },
      ]);
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not fetch releases",
        message: "Using default versions. Press Cmd+R to retry.",
      });
    } finally {
      setIsLoadingReleases(false);
    }
  }

  useEffect(() => {
    fetchReleases();
  }, []);

  async function handleSubmit(values: { 
    name: string; 
    nodes: string; 
    version: string;
    masterGFlags?: string;
    tserverGFlags?: string;
  }) {
    if (isLoading) return;

    const name = values.name.trim() || "my-cluster";
    const nodes = parseInt(values.nodes, 10);
    const version = values.version.trim() || "latest";
    const masterGFlags = values.masterGFlags?.trim() || undefined;
    const tserverGFlags = values.tserverGFlags?.trim() || undefined;

    if (isNaN(nodes) || nodes < 1 || nodes > 10) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid node count",
        message: "Please enter a number between 1 and 10",
      });
      return;
    }

    setIsLoading(true);
    console.log(`[Create Cluster] Starting creation: name=${name}, nodes=${nodes}, version=${version}`);
    if (masterGFlags) console.log(`[Create Cluster] Master GFlags: ${masterGFlags}`);
    if (tserverGFlags) console.log(`[Create Cluster] TServer GFlags: ${tserverGFlags}`);

    // Show initial progress toast
    const initialToast = await showToast({
      style: Toast.Style.Animated,
      title: "Creating Cluster",
      message: "Initializing...",
    });
    toastRef.current = initialToast;

    // Progress callback to update HUD
    const progressCallback: ProgressCallback = async (progress) => {
      let title = "Creating Cluster";
      let message = progress.message;
      
      if (progress.stage === "cleanup") {
        title = "Preparing";
        message = "Cleaning up existing containers...";
      } else if (progress.stage === "image") {
        title = "Checking Image";
        message = progress.message;
      } else if (progress.stage === "network") {
        title = "Setting Up Network";
        message = progress.message;
      } else if (progress.stage === "node") {
        title = `Creating Node ${progress.nodeNumber}/${progress.totalNodes}`;
        message = progress.message;
      } else if (progress.stage === "init") {
        title = "Initializing Cluster";
        message = progress.message;
      } else if (progress.stage === "finalize") {
        title = "Finalizing";
        message = progress.message;
      } else if (progress.stage === "complete") {
        title = "Cluster Created";
        message = progress.message;
      }

      if (toastRef.current) {
        toastRef.current.title = title;
        toastRef.current.message = message;
      } else {
        toastRef.current = await showToast({
          style: Toast.Style.Animated,
          title,
          message,
        });
      }
    };

    try {
      await createYugabyteCluster(name, nodes, version, masterGFlags, tserverGFlags, progressCallback);
      console.log(`[Create Cluster] Successfully created cluster: ${name}`);
      
      // Dismiss progress toast and show success
      if (toastRef.current) {
        toastRef.current.hide();
      }
      
      // Show success message and open List Clusters command
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Created",
        message: `YugabyteDB cluster "${name}" created successfully`,
      });
      
      // Open the List Clusters command to show the newly created cluster
      // Using the extension name and command name from package.json
      try {
        await open("raycast://extensions/pgyogesh/yugabyte-docker-manager/list-clusters");
      } catch (error) {
        // Fallback: if the URL doesn't work, just pop to root
        console.log("[Create Cluster] Could not open list-clusters command directly, user can navigate manually");
      }
    } catch (error: any) {
      // Extract detailed error information
      let errorMsg = error.message || "Unknown error occurred";
      
      // Include stderr if available (Docker errors are usually in stderr)
      if (error.stderr) {
        const stderrMsg = error.stderr.trim();
        if (stderrMsg && stderrMsg.length > 0) {
          // Extract the most relevant part of the error
          const lines = stderrMsg.split('\n');
          const relevantLine = lines.find((line: string) => 
            line.includes('Error') || 
            line.includes('error') || 
            line.includes('failed') ||
            line.includes('bind') ||
            line.includes('port') ||
            line.includes('already')
          ) || lines[0];
          
          if (relevantLine) {
            errorMsg = `${errorMsg}\n${relevantLine}`;
          } else {
            errorMsg = `${errorMsg}\n${stderrMsg.substring(0, 200)}`; // First 200 chars
          }
        }
      }
      
      // Include stdout if it contains error info
      if (error.stdout && error.stdout.trim()) {
        const stdoutMsg = error.stdout.trim();
        if (stdoutMsg.length < 200) {
          errorMsg = `${errorMsg}\n${stdoutMsg}`;
        }
      }
      
      console.error(`[Create Cluster] ========== ERROR CREATING CLUSTER ==========`);
      console.error(`[Create Cluster] Error message: ${error.message || "Unknown error"}`);
      console.error(`[Create Cluster] Exit code: ${error.code || "unknown"}`);
      if (error.stdout) {
        console.error(`[Create Cluster] Docker stdout: ${error.stdout}`);
      }
      if (error.stderr) {
        console.error(`[Create Cluster] Docker stderr: ${error.stderr}`);
      }
      console.error(`[Create Cluster] Full error object:`, error);
      console.error(`[Create Cluster] Stack trace:`, error.stack);
      console.error(`[Create Cluster] ===========================================`);
      
      // Dismiss progress toast and show error
      if (toastRef.current) {
        toastRef.current.hide();
      }
      
      // Show error message (truncate if too long for toast)
      const displayMsg = errorMsg.length > 150 ? errorMsg.substring(0, 150) + "..." : errorMsg;
      await showToast({
        style: Toast.Style.Failure,
        title: "Error Creating Cluster",
        message: displayMsg,
      });
    } finally {
      setIsLoading(false);
      toastRef.current = null;
    }
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            icon={Icon.Plus}
            title="Create Cluster"
            onSubmit={handleSubmit}
          />
          <Action
            icon={Icon.ArrowClockwise}
            title="Refresh Releases"
            onAction={fetchReleases}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Cluster Name"
        placeholder="my-cluster"
        defaultValue="my-cluster"
        info="Enter a unique name for your YugabyteDB cluster (default: my-cluster)"
      />
      <Form.TextField
        id="nodes"
        title="Number of Nodes"
        placeholder="3"
        defaultValue="3"
        info="Enter the number of nodes (1-10). Recommended: 1 for development, 3+ for production."
      />
      <Form.Dropdown
        id="version"
        title="YugabyteDB Version"
        defaultValue={releases.length > 0 ? releases[0].tag : "latest"}
        isLoading={isLoadingReleases}
        info="Select a YugabyteDB version from the list. Press Cmd+R to refresh releases."
      >
        {releases.map((release) => (
          <Form.Dropdown.Item
            key={release.tag}
            value={release.tag}
            title={release.name}
          />
        ))}
      </Form.Dropdown>
      <Form.Separator />
      <Form.TextArea
        id="masterGFlags"
        title="Master GFlags (Optional)"
        placeholder="max_log_size=256,log_min_seconds_to_retain=3600"
        defaultValue=""
        info="Custom GFlags for yb-master. Format: flag1=value1,flag2=value2 (comma-separated, no -- prefix)"
      />
      <Form.TextArea
        id="tserverGFlags"
        title="TServer GFlags (Optional)"
        placeholder="pg_yb_session_timeout_ms=1200000,ysql_max_connections=400"
        defaultValue=""
        info="Custom GFlags for yb-tserver. Format: flag1=value1,flag2=value2 (comma-separated, no -- prefix)"
      />
    </Form>
  );
}
