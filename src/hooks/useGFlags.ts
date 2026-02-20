import { showToast, Toast } from "@raycast/api";
import {
  setGFlagRuntime,
  restartClusterWithFlags,
  updateClusterGFlags,
} from "../utils/docker";

export function useGFlags() {
  async function setFlagsRuntime(
    clusterName: string,
    serverType: "master" | "tserver" | "both",
    flagName: string,
    flagValue: string,
  ) {
    try {
      const label = serverType === "both" ? "masters & tservers" : `${serverType}s`;
      await showToast({
        style: Toast.Style.Animated,
        title: "Setting GFlag",
        message: `Applying ${flagName} on ${label}...`,
      });

      const types: ("master" | "tserver")[] =
        serverType === "both" ? ["master", "tserver"] : [serverType];
      const allResults: { node: string; success: boolean; error?: string }[] = [];

      for (const type of types) {
        const results = await setGFlagRuntime(clusterName, type, flagName, flagValue);
        allResults.push(...results);
        await updateClusterGFlags(clusterName, type, { [flagName]: flagValue });
      }

      const failures = allResults.filter((r) => !r.success);
      if (failures.length > 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Some Nodes Failed",
          message: `${failures.length} of ${allResults.length} operations failed`,
        });
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: "GFlag Set",
          message: `${flagName} applied to all ${label}`,
        });
      }

      return allResults;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Failed to Set GFlag", message: msg });
      throw err;
    }
  }

  async function setFlagsWithRestart(
    clusterName: string,
    serverType: "master" | "tserver" | "both",
    flagName: string,
    flagValue: string,
  ) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Cluster Restart",
        message: "Stopping cluster, updating flags, restarting...",
      });

      await restartClusterWithFlags(clusterName, serverType, flagName, flagValue, (progress) => {
        showToast({
          style: Toast.Style.Animated,
          title: "Cluster Restart",
          message: progress.message,
        });
      });

      await showToast({
        style: Toast.Style.Success,
        title: "Cluster Restarted",
        message: `${flagName} applied and cluster restarted`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await showToast({ style: Toast.Style.Failure, title: "Cluster Restart Failed", message: msg });
      throw err;
    }
  }

  return { setFlagsRuntime, setFlagsWithRestart };
}
