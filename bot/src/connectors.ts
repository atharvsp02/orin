export const CONNECTOR_CAPABILITIES = ["ingest", "query", "record", "warn", "deliver"] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];
export type ConnectorStatus = "active" | "disabled" | "error";
export type ConnectorEventType = "decision" | "proposal" | "question" | "feedback" | "disconnect";

export interface Workspace {
  workspaceId: string;
  displayName: string;
  datasetName: string;
  cogneeApiKey: string;
  createdAt: string;
}

export interface ConnectorRef {
  provider: string;
  externalId: string;
}

export interface ConnectorAccount extends ConnectorRef {
  connectorId: string;
  workspaceId: string;
  displayName: string;
  status: ConnectorStatus;
  capabilities: ConnectorCapability[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorResource {
  resourceId: string;
  connectorId: string;
  externalId: string;
  kind: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedConnectorEvent {
  eventId: string;
  source: ConnectorRef;
  resource?: Pick<ConnectorResource, "externalId" | "kind" | "displayName">;
  type: ConnectorEventType;
  title?: string;
  body?: string;
  url?: string;
  occurredAt: string;
}

export interface ConnectorAdapter<TEvent = unknown> {
  provider: string;
  capabilities: readonly ConnectorCapability[];
  normalize(event: TEvent): Promise<NormalizedConnectorEvent | null>;
}

export function normalizeConnectorRef(ref: ConnectorRef): ConnectorRef {
  const provider = ref.provider.trim().toLowerCase();
  const externalId = ref.externalId.trim();
  if (!provider) throw new Error("connector provider is required");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error("connector provider is invalid");
  if (!externalId) throw new Error("connector external id is required");
  return { provider, externalId };
}

export function normalizeCapabilities(values: readonly string[]): ConnectorCapability[] {
  const selected = new Set<ConnectorCapability>();
  for (const value of values) {
    if (!CONNECTOR_CAPABILITIES.includes(value as ConnectorCapability)) {
      throw new Error(`unsupported connector capability: ${value}`);
    }
    selected.add(value as ConnectorCapability);
  }
  return CONNECTOR_CAPABILITIES.filter((capability) => selected.has(capability));
}

export function connectorSupports(connector: ConnectorAccount, capability: ConnectorCapability): boolean {
  return connector.status === "active" && connector.capabilities.includes(capability);
}
