import { Action, ActionPanel, List, Icon, Color, showToast, Toast, open } from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { checkProxyRunning, launchProxy, killProxy, getProxyUrl, getProxyPort } from "./utils/proxy";

export default function Command() {
  const [running, setRunning] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    setRunning(null);
    checkProxyRunning().then(setRunning);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleStart = useCallback(async () => {
    await showToast({ style: Toast.Style.Animated, title: "Starting Proxy…" });
    try {
      const started = await launchProxy();
      if (started) {
        await showToast({ style: Toast.Style.Success, title: "Proxy Started", message: getProxyUrl() });
      } else {
        await showToast({
          style: Toast.Style.Failure,
          title: "Proxy Failed to Start",
          message: "Check that scripts/proxy-server.js exists and port 15080 is free",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await showToast({ style: Toast.Style.Failure, title: "Proxy Failed to Start", message: msg });
    }
    refresh();
  }, [refresh]);

  const handleStop = useCallback(async () => {
    await showToast({ style: Toast.Style.Animated, title: "Stopping Proxy…" });
    try {
      await killProxy();
      await showToast({ style: Toast.Style.Success, title: "Proxy Stopped" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await showToast({ style: Toast.Style.Failure, title: "Failed to Stop Proxy", message: msg });
    }
    refresh();
  }, [refresh]);

  const handleRestart = useCallback(async () => {
    await showToast({ style: Toast.Style.Animated, title: "Restarting Proxy…" });
    try {
      await killProxy();
      await new Promise((r) => setTimeout(r, 1000));
      const started = await launchProxy();
      if (started) {
        await showToast({ style: Toast.Style.Success, title: "Proxy Restarted", message: getProxyUrl() });
      } else {
        await showToast({ style: Toast.Style.Failure, title: "Proxy Failed to Restart" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await showToast({ style: Toast.Style.Failure, title: "Failed to Restart Proxy", message: msg });
    }
    refresh();
  }, [refresh]);

  const isLoading = running === null;
  const statusColor = running ? Color.Green : Color.SecondaryText;
  const statusText = isLoading ? "Checking…" : running ? "Running" : "Stopped";

  return (
    <List isLoading={isLoading} isShowingDetail>
      <List.Item
        title="Web UI Proxy"
        subtitle={`Port ${getProxyPort()}`}
        icon={{ source: Icon.Globe, tintColor: statusColor }}
        accessories={[{ tag: { value: statusText, color: statusColor } }]}
        detail={
          <List.Item.Detail
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label
                  title="Status"
                  text={statusText}
                  icon={{ source: running ? Icon.CircleFilled : Icon.Circle, tintColor: statusColor }}
                />
                <List.Item.Detail.Metadata.Label title="Port" text={String(getProxyPort())} />
                {running && (
                  <List.Item.Detail.Metadata.Link title="Landing Page" target={getProxyUrl()} text={getProxyUrl()} />
                )}
                <List.Item.Detail.Metadata.Separator />
                <List.Item.Detail.Metadata.Label
                  title="About"
                  text="Proxies requests to internal Docker container web UIs that aren't directly reachable from the host."
                />
                <List.Item.Detail.Metadata.Separator />
                <List.Item.Detail.Metadata.Label title="Terminal Commands" />
                <List.Item.Detail.Metadata.Label title="  Start" text="npm run proxy:start" />
                <List.Item.Detail.Metadata.Label title="  Stop" text="npm run proxy:stop" />
                <List.Item.Detail.Metadata.Label title="  Status" text="npm run proxy:status" />
                <List.Item.Detail.Metadata.Label title="  Foreground" text="npm run proxy" />
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          <ActionPanel>
            {running ? (
              <>
                <Action icon={{ source: Icon.Stop, tintColor: Color.Red }} title="Stop Proxy" onAction={handleStop} />
                <Action
                  icon={Icon.ArrowClockwise}
                  title="Restart Proxy"
                  onAction={handleRestart}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                />
                <Action
                  icon={Icon.Globe}
                  title="Open Landing Page"
                  onAction={() => open(getProxyUrl())}
                  shortcut={{ modifiers: ["cmd"], key: "o" }}
                />
              </>
            ) : (
              <Action icon={{ source: Icon.Play, tintColor: Color.Green }} title="Start Proxy" onAction={handleStart} />
            )}
            <Action
              icon={Icon.ArrowClockwise}
              title="Refresh Status"
              onAction={refresh}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
