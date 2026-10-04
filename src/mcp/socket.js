import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
export function formatBridgeUri(options) {
  validateNonblank(options.endpoint, "endpoint");
  validateNonblank(options.sessionId, "sessionId");
  if (!options.endpoint.startsWith("/"))
    throw new Error("Bridge endpoint must be an absolute Unix socket path");
  const uri = new URL("unix://localhost");
  uri.hostname = "";
  uri.pathname = options.endpoint;
  uri.searchParams.set("session", options.sessionId);
  return uri.toString();
}
export function parseBridgeUri(value) {
  validateNonblank(value, "bridge URI");
  let uri;
  try {
    uri = new URL(value);
  } catch {
    throw new Error("Bridge URI must be a valid unix: URI");
  }
  const sessionId = uri.searchParams.get("session");
  if (uri.protocol !== "unix:" || uri.host || !uri.pathname.startsWith("/") || uri.hash || !sessionId) {
    throw new Error("Bridge URI must use unix:///absolute/socket/path?session=<session-id>");
  }
  if ([...uri.searchParams.keys()].some((key) => key !== "session")) {
    throw new Error("Bridge URI contains unsupported query parameters");
  }
  return {
    endpoint: decodeURIComponent(uri.pathname),
    sessionId
  };
}

export class BridgeSocketClient {
  socket;
  sessionId;
  pending = new Map;
  disconnectListeners = new Set;
  tools;
  buffer = "";
  state = "connecting";
  connectResolve = null;
  connectReject = null;
  connected;
  constructor(options) {
    validateNonblank(options.endpoint, "endpoint");
    validateNonblank(options.sessionId, "sessionId");
    this.sessionId = options.sessionId;
    this.connected = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.connected.catch(() => {
      return;
    });
    this.socket = createConnection(options.endpoint);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.receive(String(chunk)));
    this.socket.once("connect", () => this.sendHello());
    this.socket.once("error", (error) => this.fail(toError(error)));
    this.socket.once("close", () => this.fail(new Error("Bridge socket disconnected")));
  }
  async waitUntilConnected() {
    await this.connected;
  }
  listTools() {
    this.assertOpen();
    return [...this.tools ?? []];
  }
  onDisconnect(listener) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  callTool(name, args = {}) {
    this.assertOpen();
    validateNonblank(name, "tool name");
    if (!isRecord(args))
      throw new Error("Tool arguments must be an object");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ type: "call", id, name, arguments: args });
      } catch (error) {
        this.pending.delete(id);
        this.fail(toError(error));
        reject(toError(error));
      }
    });
  }
  close() {
    if (this.state === "closed")
      return;
    this.fail(new Error("Bridge socket client closed"), false);
  }
  sendHello() {
    try {
      this.write({ type: "hello", sessionId: this.sessionId });
    } catch (error) {
      this.fail(toError(error));
    }
  }
  receive(chunk) {
    if (this.state === "closed")
      return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf(`
`);
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") {
        try {
          this.receiveMessage(JSON.parse(line));
        } catch (error) {
          this.fail(toError(error));
          return;
        }
      }
      newline = this.buffer.indexOf(`
`);
    }
  }
  receiveMessage(value) {
    if (!isRecord(value) || Array.isArray(value)) {
      throw new Error("Bridge returned a non-object message");
    }
    const message = value;
    if (message.type === "error") {
      const detail = typeof message.message === "string" ? message.message : "Bridge rejected the session";
      throw new Error(detail);
    }
    if (message.type === "tools") {
      if (this.state !== "connecting" || !Array.isArray(message.tools)) {
        throw new Error("Bridge returned an invalid tools message");
      }
      this.tools = message.tools;
      this.state = "open";
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
      return;
    }
    if (message.type !== "result" || typeof message.id !== "string" || message.id === "" || !("result" in message)) {
      throw new Error("Bridge returned an invalid protocol message");
    }
    if (this.state !== "open")
      throw new Error("Bridge returned a result before tools");
    const request = this.pending.get(message.id);
    if (!request)
      throw new Error(`Bridge returned an unknown result ID: ${message.id}`);
    this.pending.delete(message.id);
    request.resolve(message.result);
  }
  write(message) {
    if (this.state === "closed" || this.socket.destroyed) {
      throw new Error("Bridge socket is disconnected");
    }
    this.socket.write(`${JSON.stringify(message)}
`);
  }
  assertOpen() {
    if (this.state !== "open")
      throw new Error("Bridge socket is disconnected or closed");
  }
  fail(error, notify = true) {
    if (this.state === "closed")
      return;
    this.state = "closed";
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    for (const request of this.pending.values())
      request.reject(error);
    this.pending.clear();
    if (!this.socket.destroyed)
      this.socket.destroy();
    if (notify) {
      for (const listener of this.disconnectListeners)
        listener(error);
    }
    this.disconnectListeners.clear();
  }
}
export async function connectBridge(options) {
  validateNonblank(options.endpoint, "endpoint");
  validateNonblank(options.sessionId, "sessionId");
  const client = new BridgeSocketClient(options);
  try {
    await client.waitUntilConnected();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
function validateNonblank(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must not be blank`);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
