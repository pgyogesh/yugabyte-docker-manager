import { useCachedPromise } from "@raycast/utils";
import { fetchDockerHubReleases } from "../utils/docker";

const FALLBACK_RELEASES = [
  { name: "Latest", tag: "latest" },
  { name: "2025.2.0.0-b131", tag: "2025.2.0.0-b131" },
  { name: "2.20.0.0", tag: "2.20.0.0" },
  { name: "2.19.3.0", tag: "2.19.3.0" },
  { name: "2.19.2.0", tag: "2.19.2.0" },
  { name: "2.19.1.0", tag: "2.19.1.0" },
  { name: "2.18.4.0", tag: "2.18.4.0" },
];

/**
 * Hook that fetches available YugabyteDB releases from Docker Hub.
 * Falls back to a hardcoded list on network failure.
 */
export function useDockerHubReleases() {
  const { data, isLoading, revalidate, error } = useCachedPromise(
    async () => {
      try {
        const releases = await fetchDockerHubReleases();
        return releases.length > 0 ? releases : FALLBACK_RELEASES;
      } catch {
        return FALLBACK_RELEASES;
      }
    },
    [],
    { keepPreviousData: true },
  );

  return {
    releases: data ?? FALLBACK_RELEASES,
    isLoading,
    revalidate,
    error,
  };
}
