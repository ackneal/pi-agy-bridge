import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AcpMcpPermissions } from "../../src/extension/drivers/acp/permissions.ts";
import { createLivePiSession } from "./pi-session.ts";
import { ScenarioFailure, ScenarioOutcome } from "./report.ts";
import { createVisualFixture, imageEvidence } from "./visual-fixture.ts";

type Options = {
  id: "IMG-prompt-small" | "IMG-prompt-large" | "IMG-mcp-small" | "IMG-mcp-offload";
  cwd: string;
  directory: string;
  model: Model<any>;
  launch: { executable: string; args: string[] };
  signal: AbortSignal;
  t: TestContext;
  evidence: unknown[];
  rpcs: { method: string; params: unknown; response?: unknown; error?: string }[];
  reads: { request: unknown; response?: unknown; error?: string }[];
  onToolCall: (call: { id: string; name: string; arguments: unknown }) => void;
};
type Visual = ReturnType<typeof createVisualFixture>;

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.type === "image" && typeof object.data === "string") {
      return { type: "image", mimeType: object.mimeType, ...imageEvidence(Buffer.from(object.data, "base64")) };
    }
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, compact(entry)]));
  }
  return value;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function artifactPaths(value: unknown, root: string): string[] {
  const paths = strings(value).flatMap(text => text.match(/(?:file:\/\/)?\/[^\s<>"'`\]\[()]+/g) ?? []).map(text => {
    const name = text.replace(/[.,;]+$/, "");
    try { return name.startsWith("file://") ? decodeURIComponent(new URL(name).pathname) : name; }
    catch { return ""; }
  });
  return [...new Set(paths.filter(name => name.startsWith(root + path.sep) && path.resolve(name) === name))];
}

function exactImagePrompt(rpc: Options["rpcs"][number], visual: Visual): boolean {
  const params = rpc.params as { prompt?: { type: string; data?: string; mimeType?: string }[] };
  return rpc.method === "session/prompt" && Array.isArray(params.prompt) && params.prompt.some(block =>
    block.type === "image" && block.mimeType === "image/png" && block.data === visual.data);
}

export async function runImageScenario(options: Options): Promise<void> {
  const sizes = options.id === "IMG-mcp-offload" ? [32768, 262144, 1048576, 4194304] : [undefined];
  const tested: unknown[] = [];
  for (const bytes of sizes) {
    options.signal.throwIfAborted();
    if (await runAttempt(options, bytes, tested)) return;
  }
  throw new ScenarioOutcome("INCONCLUSIVE", `Real Pi image tool executed at every bounded size without an observed image offload reference; no backend threshold inferred. Tested: ${JSON.stringify(tested)}`);
}

async function runAttempt(options: Options, bytes: number | undefined, tested: unknown[]): Promise<boolean> {
  const direct = options.id.startsWith("IMG-prompt-");
  const requireOffload = options.id === "IMG-mcp-offload";
  const toolName = "mcp__pi__live_image";
  const startRpc = options.rpcs.length;
  const startRead = options.reads.length;
  const notifications: Parameters<AcpMcpPermissions["observe"]>[0][] = [];
  const observe = AcpMcpPermissions.prototype.observe;
  const observation = options.t.mock.method(AcpMcpPermissions.prototype, "observe", function (this: AcpMcpPermissions, notification: Parameters<typeof observe>[0]) {
    notifications.push(structuredClone(notification));
    return observe.call(this, notification);
  });
  let visual: Visual | undefined = direct ? createVisualFixture(options.id === "IMG-prompt-large" ? { large: true, bytes: 4 * 1024 * 1024 } : {}) : undefined;
  const executions: { id: string; arguments: unknown }[] = [];
  const handlerErrors: unknown[] = [];
  let session: AgentSession | undefined;
  let fixture: Awaited<ReturnType<typeof createLivePiSession>> | undefined;
  let failure: unknown;
  const tool = defineTool({
    name: toolName,
    label: "Live image probe",
    description: "Returns one test image. Transcribe the six digits in the white panel at the top; ignore pixel noise below. No file or command access.",
    parameters: Type.Object({}),
    async execute(id, args) {
      try {
        executions.push({ id, arguments: structuredClone(args) });
        if (direct || executions.length !== 1) throw new ScenarioFailure("model", "Image tool must run exactly once, never as recovery");
        assert.match(id, /^pi_.+$/);
        assert.deepEqual(args, {});
        assert.ok(session);
        const calls = session.messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall" && part.id === id) : []);
        assert.equal(calls.length, 1, "Handler must correspond to an actual Pi assistant call");
        assert.ok(calls[0]!.type === "toolCall");
        assert.equal(calls[0]!.name, toolName);
        assert.deepEqual(calls[0]!.arguments, args);
        options.onToolCall({ id, name: toolName, arguments: structuredClone(args) });
        // The secret is generated only inside the handler, never in tool metadata or input.
        visual = createVisualFixture(bytes === undefined ? {} : { bytes });
        return { content: [{ type: "image", data: visual.data, mimeType: "image/png" }], details: {} };
      } catch (error) {
        handlerErrors.push(error);
        throw error;
      }
    },
  });

  try {
    fixture = await createLivePiSession({ ...options, tool });
    session = fixture.session;
    const objective = "Transcribe the six visible digits in the white panel at the top of the image; ignore any pixel noise below. Reply only with those exact six digits, preserving leading zeros, no punctuation. If an actual offload reference is returned, use the authorized ACP Client Read interface on that current-session reference to recover the image. Never rerun the original tool for recovery. Never invent a path or digits.";
    try {
      if (direct) {
        assert.ok(visual);
        await session.prompt(objective, { images: [{ type: "image", data: visual.data, mimeType: "image/png" }] });
      } else {
        await session.prompt(`Call ${toolName} exactly once with {}. ${objective}`);
      }
    } finally {
      if (handlerErrors.length) throw handlerErrors[0];
    }
    options.signal.throwIfAborted();
    if (!direct && executions.length !== 1) throw new ScenarioFailure("model", `Expected one real image tool invocation, observed ${executions.length}`);
    assert.ok(visual, "Actual image must exist");
    const image = visual;
    const file = session.sessionManager.getSessionFile();
    assert.ok(file, "Pi image history must be persisted");
    const messages = SessionManager.open(file).getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
    const results = messages.filter(message => message.role === "toolResult");
    if (!direct) {
      assert.equal(results.length, 1);
      assert.equal(results[0]!.toolCallId, executions[0]!.id);
      assert.equal(results[0]!.toolName, toolName);
      assert.equal(results[0]!.isError, false);
      assert.deepEqual(results[0]!.content, [{ type: "image", data: image.data, mimeType: "image/png" }], "Persisted Pi result must be the exact handler image");
    } else assert.equal(executions.length, 0);

    const rpcs = options.rpcs.slice(startRpc);
    const main = rpcs.find(rpc => rpc.method === "session/prompt");
    assert.ok(main, "Actual main session/prompt required");
    const sessionId = (main.params as { sessionId: string }).sessionId;
    assert.match(sessionId, /^[A-Za-z0-9_-]+$/);
    if (direct) assert.ok(exactImagePrompt(main, image), "Main session/prompt must carry exact PNG, not model claims");
    const home = process.env.GEMINI_HOME;
    assert.ok(home);
    const root = path.join(home, "antigravity-acp", "brain", sessionId, ".system_generated", "steps");
    const currentNotifications = notifications.filter(notification => notification.sessionId === sessionId);
    const references = artifactPaths(currentNotifications, root);
    const reads = options.reads.slice(startRead);
    const artifactReads = reads.filter(read => {
      const request = read.request as { path?: string; sessionId?: string };
      return request.sessionId === sessionId && typeof request.path === "string" && request.path.startsWith(root + path.sep) && path.resolve(request.path) === request.path;
    });
    // Only inspect exact paths already requested through the real authorized reader.
    // No directory enumeration or authentication-storage access is permitted.
    const identities: { path: string; sha256: string; bytes: number; exactFixture: boolean }[] = [];
    for (const read of artifactReads) {
      if (read.error) throw new ScenarioFailure("bridge", `Actual image offload recovery read failed: ${read.error}`);
      if (!read.response) throw new ScenarioFailure("transport", "Actual image offload read did not return a response");
      const target = (read.request as { path: string }).path;
      assert.equal(await realpath(target), target);
      const stat = await lstat(target);
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size < 8 * 1024 * 1024);
      const identity = imageEvidence(await readFile(target));
      identities.push({ path: target, ...identity, exactFixture: identity.sha256 === image.sha256 });
    }
    const observers = rpcs.filter(rpc => {
      const params = rpc.params as { sessionId?: string; prompt?: { type: string; data?: string; mimeType?: string }[] };
      return rpc.method === "session/prompt" && params.sessionId !== sessionId && params.prompt?.some(block =>
        block.type === "image" && typeof block.data === "string" && identities.some(identity =>
          identity.sha256 === imageEvidence(Buffer.from(block.data!, "base64")).sha256));
    });
    const derived = artifactReads.filter(read => typeof (read.response as { content?: unknown } | undefined)?.content === "string" &&
      (read.response as { content: string }).content.startsWith("Image observation (derived):\n"));
    const offloaded = references.length > 0 || artifactReads.length > 0;
    const final = messages.at(-1);
    assert.ok(final?.role === "assistant", "Full image turn must end with an assistant message");
    if (final.stopReason !== "stop") throw new ScenarioFailure("backend", `Image turn did not complete: ${final.errorMessage ?? final.stopReason}`);
    assert.equal(final.provider, options.model.provider);
    const text = final.content.filter(part => part.type === "text").map(part => part.text).join("");
    const facts = { id: options.id, requestedBytes: bytes, ...imageEvidence(image.png), width: image.width, height: image.height,
      marker: image.marker, route: offloaded ? "artifact-reference-or-read" : direct ? "direct-prompt" : "no-offload-observed",
      references, artifactReads: compact(artifactReads), artifactIdentities: identities, exactObserverRpcs: compact(observers), final: text };
    tested.push(facts);
    options.evidence.push({ imageAttempt: facts });
    if (offloaded) {
      assert.ok(references.length, "Read alone is not evidence of the backend offload reference/notification");
      assert.ok(artifactReads.some(read => references.includes((read.request as { path: string }).path)), "Recovery must read an actual notified offload reference");
      assert.ok(identities.length, "Actual requested offloaded artifact must exist");
      assert.ok(observers.length, "Real image observer must receive the exact bytes from an actual read artifact; backend re-encoding is recorded, not automatically rejected");
      for (const observer of observers) {
        assert.equal((observer.response as { stopReason?: string } | undefined)?.stopReason, "end_turn", "Image observer must complete");
        const observerId = (observer.params as { sessionId: string }).sessionId;
        const created = rpcs.find(rpc => rpc.method === "session/new" && (rpc.response as { sessionId?: string } | undefined)?.sessionId === observerId);
        assert.ok(created, "Observer must have its own actual native session");
        const params = created.params as { mcpServers: unknown[]; _meta: { antigravity: { enabledTools: unknown[] } } };
        assert.deepEqual(params.mcpServers, []);
        assert.deepEqual(params._meta.antigravity.enabledTools, []);
      }
      assert.ok(derived.some(read => identities.some(identity => identity.path === (read.request as { path: string }).path) &&
        (read.response as { content: string }).content.includes(image.marker)), "Actual Client Read must return derived OCR of the image-only marker");
    }
    if (text !== image.marker) throw new ScenarioFailure("model", "Final response did not exactly transcribe the image-only marker");
    if (requireOffload && !offloaded) return false;
    return true;
  } catch (error) {
    failure = error;
    options.evidence.push({ imageFailure: String(error), requestedBytes: bytes });
    throw error;
  } finally {
    observation.mock.restore();
    try {
      options.evidence.push({ imageAttemptTrace: { requestedBytes: bytes, executions, handlerErrors: handlerErrors.map(String),
        fixture: visual ? { ...imageEvidence(visual.png), width: visual.width, height: visual.height, marker: visual.marker } : undefined,
        piSessionId: session?.sessionId, piHistory: compact(session?.messages), notifications: compact(notifications),
        rpcs: compact(options.rpcs.slice(startRpc)), reads: compact(options.reads.slice(startRead)) } });
    } finally {
      try {
        await fixture?.close();
      } catch (error) {
        options.evidence.push({ imageCleanupFailure: String(error), requestedBytes: bytes });
        if (failure !== undefined) throw new AggregateError([failure, error], "Image scenario and cleanup both failed");
        throw error;
      }
    }
  }
}
