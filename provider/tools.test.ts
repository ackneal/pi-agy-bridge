import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgyBridge } from "./provider.ts";

type RegistryTool = ReturnType<ExtensionAPI["getAllTools"]>[number];

function tool(name: string): Tool {
  return { name, description: `Declared ${name}`, parameters: Type.Object({}) };
}

const direct = tool("read");
const codemode = tool("codemode");
const registry: RegistryTool[] = ([
  [direct, "direct"],
  [codemode, "model-only"],
  [tool("inactive_direct"), "direct"],
  [tool("hidden"), "hidden"],
  [tool("deferred"), "deferred"],
  [tool("codemode_underlying"), "codemode"],
] satisfies [Tool, RegistryTool["exposure"]][]).map(([definition, exposure]) => ({
  ...definition,
  description: `Registry ${definition.name}`,
  exposure,
  sourceInfo: { path: "builtin:test", source: "builtin", scope: "temporary", origin: "top-level" },
}));

const user: Context["messages"][number] = { role: "user", content: "Hello", timestamp: 1 };
const active = [direct.name, codemode.name];

const cases: {
  name: string;
  context: Context;
  activeNames: string[];
  expected: Tool[];
  registryReads: number;
}[] = [
  {
    name: "trusts legacy direct and codemode declarations even when registry tools are inactive",
    context: { tools: [direct, codemode], messages: [user] },
    activeNames: [], expected: [direct, codemode], registryReads: 0,
  },
  {
    name: "does not fall back for an explicit empty tool list",
    context: { tools: [], messages: [user] },
    activeNames: active, expected: [], registryReads: 0,
  },
  {
    name: "uses only system toolsAdded declarations without expanding underlying registry tools",
    context: { messages: [
      { role: "system", content: "Tools", toolsAdded: [codemode, direct], timestamp: 0 },
      user,
    ] },
    activeNames: registry.map((entry) => entry.name), expected: [codemode, direct], registryReads: 0,
  },
  {
    name: "replays toolsRemoved after toolsAdded",
    context: { messages: [
      { role: "system", content: "Tools", toolsAdded: [codemode, direct], timestamp: 0 },
      user,
      { role: "system", content: "Remove read", toolsRemoved: [{ name: direct.name }], timestamp: 2 },
    ] },
    activeNames: active, expected: [codemode], registryReads: 0,
  },
  {
    name: "does not fall back when a system message declares no tools",
    context: { messages: [user, { role: "system", content: "Instructions only", timestamp: 2 }] },
    activeNames: active, expected: [], registryReads: 0,
  },
  {
    name: "falls back to active direct and model-only codemode entry points only",
    context: { messages: [user] },
    activeNames: active, expected: registry.slice(0, 2), registryReads: 1,
  },
  {
    name: "excludes hidden registry tools even when active",
    context: { messages: [user] },
    activeNames: [...active, "hidden"], expected: registry.slice(0, 2), registryReads: 1,
  },
];

describe("AgyBridge.getTools", () => {
  for (const testCase of cases) {
    it(testCase.name, (t) => {
      const getAllTools = t.mock.fn(() => registry);
      const getActiveTools = t.mock.fn(() => testCase.activeNames);
      // Do not start the bridge: tool selection needs no doctor registration or runtime.
      const pi = { getAllTools, getActiveTools } satisfies Pick<ExtensionAPI, "getAllTools" | "getActiveTools">;
      const bridge = new AgyBridge(pi as unknown as ExtensionAPI);

      assert.deepEqual(bridge.getTools(testCase.context), testCase.expected);
      assert.equal(getAllTools.mock.callCount(), testCase.registryReads);
      assert.equal(getActiveTools.mock.callCount(), testCase.registryReads);
    });
  }
});
