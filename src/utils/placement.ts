// Hardcoded dummy placement catalog used by the YBA-style cloud/region/zone
// selector. These values are cosmetic — they are passed to yugabyted via
// --cloud_location so cluster metadata reflects a multi-zone topology, but no
// real cloud provider is contacted.

export type Cloud = "aws" | "gcp" | "azure" | "onprem";

export interface ZoneOption {
  region: string;
  zone: string;
}

export type FaultTolerance = "none" | "zone" | "region" | "cloud";

export const CLOUDS: { value: Cloud; label: string }[] = [
  { value: "aws", label: "AWS" },
  { value: "gcp", label: "GCP" },
  { value: "azure", label: "Azure" },
  { value: "onprem", label: "On-Prem" },
];

export const FAULT_TOLERANCE_OPTIONS: { value: FaultTolerance; label: string }[] = [
  { value: "none", label: "None (single-node fault tolerance)" },
  { value: "zone", label: "Zone-level (requires 3+ zones)" },
  { value: "region", label: "Region-level (requires 3+ regions)" },
  { value: "cloud", label: "Cloud-level (requires 3+ clouds)" },
];

export const PLACEMENT_CATALOG: Record<Cloud, ZoneOption[]> = {
  aws: [
    { region: "us-west-1", zone: "us-west-1a" },
    { region: "us-west-1", zone: "us-west-1b" },
    { region: "us-west-1", zone: "us-west-1c" },
    { region: "us-east-1", zone: "us-east-1a" },
    { region: "us-east-1", zone: "us-east-1b" },
    { region: "us-east-1", zone: "us-east-1c" },
    { region: "eu-west-1", zone: "eu-west-1a" },
    { region: "eu-west-1", zone: "eu-west-1b" },
    { region: "eu-west-1", zone: "eu-west-1c" },
  ],
  gcp: [
    { region: "us-central1", zone: "us-central1-a" },
    { region: "us-central1", zone: "us-central1-b" },
    { region: "us-central1", zone: "us-central1-c" },
    { region: "us-east1", zone: "us-east1-b" },
    { region: "us-east1", zone: "us-east1-c" },
    { region: "us-east1", zone: "us-east1-d" },
    { region: "europe-west1", zone: "europe-west1-b" },
    { region: "europe-west1", zone: "europe-west1-c" },
    { region: "europe-west1", zone: "europe-west1-d" },
  ],
  azure: [
    { region: "eastus", zone: "eastus-1" },
    { region: "eastus", zone: "eastus-2" },
    { region: "eastus", zone: "eastus-3" },
    { region: "westus", zone: "westus-1" },
    { region: "westus", zone: "westus-2" },
    { region: "westus", zone: "westus-3" },
    { region: "westeurope", zone: "westeurope-1" },
    { region: "westeurope", zone: "westeurope-2" },
    { region: "westeurope", zone: "westeurope-3" },
  ],
  onprem: [
    { region: "dc1", zone: "dc1-rack1" },
    { region: "dc1", zone: "dc1-rack2" },
    { region: "dc1", zone: "dc1-rack3" },
    { region: "dc2", zone: "dc2-rack1" },
    { region: "dc2", zone: "dc2-rack2" },
    { region: "dc2", zone: "dc2-rack3" },
  ],
};

export interface NodePlacementValue {
  cloud: string;
  region: string;
  zone: string;
}

/**
 * Round-robin assign `nodes` node slots across the given zones. Node i is
 * placed in zones[i % zones.length]. Returns a flat list of
 * {cloud, region, zone} objects, one per node, in node order.
 */
export function distributeNodes(nodes: number, zones: ZoneOption[], cloud: string): NodePlacementValue[] {
  if (zones.length === 0) return [];
  const result: NodePlacementValue[] = [];
  for (let i = 0; i < nodes; i++) {
    const z = zones[i % zones.length];
    result.push({ cloud, region: z.region, zone: z.zone });
  }
  return result;
}

/**
 * Encodes a ZoneOption into the "region|zone" token used as TagPicker values
 * in the create-cluster form. Kept stable so decodes round-trip.
 */
export function encodeZone(option: ZoneOption): string {
  return `${option.region}|${option.zone}`;
}

export function decodeZone(token: string): ZoneOption | null {
  const sep = token.indexOf("|");
  if (sep <= 0) return null;
  return { region: token.substring(0, sep), zone: token.substring(sep + 1) };
}

/**
 * Minimum number of distinct zones/regions/clouds required for a given fault
 * tolerance level. Used by the create form to validate the selection.
 */
export function minimumZonesFor(ft: FaultTolerance): number {
  switch (ft) {
    case "zone":
    case "region":
    case "cloud":
      return 3;
    default:
      return 1;
  }
}
