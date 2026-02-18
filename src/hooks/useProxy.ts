import { useState, useEffect, useRef } from "react";
import { checkProxyRunning, getProxyUrl } from "../utils/proxy";

const CHECK_INTERVAL_MS = 10_000; // re-check every 10 s

/**
 * React hook that detects whether the standalone proxy server is running.
 *
 * The proxy lives outside of Raycast as an independent Node process
 * (started via the "Start Web UI Proxy" command or `npm run proxy:start`).
 * This hook simply pings it periodically to see if it's reachable.
 */
export function useProxy() {
  const [proxyRunning, setProxyRunning] = useState(false);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    function check() {
      checkProxyRunning().then((running) => {
        setProxyRunning(running);
        setProxyUrl(running ? getProxyUrl() : null);
      });
    }

    check();
    intervalRef.current = setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { proxyRunning, proxyUrl };
}
