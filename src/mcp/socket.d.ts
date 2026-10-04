export interface BridgeConnectionOptions {
  endpoint: string;
  sessionId: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function formatBridgeUri(options: BridgeConnectionOptions): string;
export function parseBridgeUri(value: string): BridgeConnectionOptions;

export class BridgeSocketClient {
  constructor(options: BridgeConnectionOptions);
  waitUntilConnected(): Promise<void>;
  listTools(): readonly McpTool[];
  onDisconnect(listener: (error: Error) => void): () => void;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export function connectBridge(options: BridgeConnectionOptions): Promise<BridgeSocketClient>;
