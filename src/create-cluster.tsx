import { Action, ActionPanel, Form, showToast, Toast, Icon } from "@raycast/api";
import { useState, useEffect } from "react";
import { createYugabyteCluster } from "./utils/docker";

interface YugabyteRelease {
  name: string;
  tag: string;
}

export default function Command() {
  const [isLoading, setIsLoading] = useState(false);
  const [releases, setReleases] = useState<YugabyteRelease[]>([]);
  const [isLoadingReleases, setIsLoadingReleases] = useState(true);

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

    const name = values.name.trim();
    const nodes = parseInt(values.nodes, 10);
    const version = values.version.trim() || "latest";
    const masterGFlags = values.masterGFlags?.trim() || undefined;
    const tserverGFlags = values.tserverGFlags?.trim() || undefined;

    if (!name) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid cluster name",
        message: "Please enter a cluster name",
      });
      return;
    }

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

    try {
      await createYugabyteCluster(name, nodes, version, masterGFlags, tserverGFlags);
      console.log(`[Create Cluster] Successfully created cluster: ${name}`);
      await showToast({
        style: Toast.Style.Success,
        title: "Cluster created",
        message: `YugabyteDB cluster "${name}" with ${nodes} node(s) created successfully`,
      });
    } catch (error: any) {
      const errorMsg = error.message || "Unknown error occurred";
      console.error(`[Create Cluster] Error creating cluster: ${errorMsg}`);
      console.error(`[Create Cluster] Full error:`, error);
      console.error(`[Create Cluster] Stack trace:`, error.stack);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error creating cluster",
        message: errorMsg,
      });
    } finally {
      setIsLoading(false);
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
        defaultValue=""
        info="Enter a unique name for your YugabyteDB cluster"
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
        defaultValue="latest"
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
        placeholder="--max_log_size=256 --log_min_seconds_to_retain=3600"
        defaultValue=""
        info="Custom GFlags for yb-master. Format: --flag1=value1 --flag2=value2"
      />
      <Form.TextArea
        id="tserverGFlags"
        title="TServer GFlags (Optional)"
        placeholder="--max_log_size=256 --log_min_seconds_to_retain=3600"
        defaultValue=""
        info="Custom GFlags for yb-tserver. Format: --flag1=value1 --flag2=value2"
      />
    </Form>
  );
}
