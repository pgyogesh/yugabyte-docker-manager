// Shared TypeScript interfaces for YugabyteDB Docker Manager

export interface NodePorts {
  yugabytedUI: number;
  masterUI: number;
  tserverUI: number;
  ysql: number;
  ycql: number;
}

export interface ClusterInfo {
  name: string;
  nodes: number;
  version: string;
  status: "running" | "stopped";
  masterGFlags?: string;
  tserverGFlags?: string;
  nodePorts?: NodePorts[];
}

export interface ClusterCreationProgress {
  stage: string;
  message: string;
  nodeNumber?: number;
  totalNodes?: number;
}

export type ProgressCallback = (progress: ClusterCreationProgress) => void;

export interface ClusterService {
  containerName: string;
  nodeNumber: number;
  services: {
    ybMaster?: { running: boolean; port: number };
    ybTserver?: { running: boolean; port: number };
    yugabyted?: { running: boolean; port: number };
  };
  ports: NodePorts;
}
