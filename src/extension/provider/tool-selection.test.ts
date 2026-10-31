import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

type RegistryTool = ReturnType<ExtensionAPI["getAllTools"]>[number];

function toolDef(name: string): Tool {
  return { name, description: `Declared ${name}`, parameters: Type.Object({}) };
}

const directTool = toolDef("read");
const codemodeTool = toolDef("codemode");
const sampleRegistry: RegistryTool[] = ([
  [directTool, "direct"],
  [codemodeTool, "model-only"],
  [toolDef("inactive_direct"), "direct"],
  [toolDef("hidden"), "hidden"],
  [toolDef("deferred"), "deferred"],
  [toolDef("codemode_underlying"), "codemode"],
] satisfies [Tool, RegistryTool["exposure"]][]).map(([definition, exposure]) => ({
  ...definition,
  description: `Registry ${definition.name}`,
  exposure,
  sourceInfo: { path: "builtin:test", source: "builtin", scope: "temporary", origin: "top-level" },
}));

const userMessage: Context["messages"][number] = { role: "user", content: "Hello", timestamp: 1 };
const activeToolNames = [directTool.name, codemodeTool.name];

const toolSelectionCases: {
  name: string;
  context: Context;
  activeNames: string[];
  expected: Tool[];
  registryReads: number;
}[] = [
  {
    name: "trusts legacy direct and codemode declarations even when registry tools are inactive",
    context: { tools: [directTool, codemodeTool], messages: [userMessage] },
    activeNames: [], expected: [directTool, codemodeTool], registryReads: 0,
  },
  {
    name: "does not fall back for an explicit empty tool list",
    context: { tools: [], messages: [userMessage] },
    activeNames: activeToolNames, expected: [], registryReads: 0,
  },
  {
    name: "uses only system toolsAdded declarations without expanding underlying registry tools",
    context: { messages: [
      { role: "system", content: "Tools", toolsAdded: [codemodeTool, directTool], timestamp: 0 },
      userMessage,
    ] },
    activeNames: sampleRegistry.map((entry) => entry.name), expected: [codemodeTool, directTool], registryReads: 0,
  },
  {
    name: "replays toolsRemoved after toolsAdded",
    context: { messages: [
      { role: "system", content: "Tools", toolsAdded: [codemodeTool, directTool], timestamp: 0 },
      userMessage,
      { role: "system", content: "Remove read", toolsRemoved: [{ name: directTool.name }], timestamp: 2 },
    ] },
    activeNames: activeToolNames, expected: [codemodeTool], registryReads: 0,
  },
  {
    name: "does not fall back when a system message declares no tools",
    context: { messages: [userMessage, { role: "system", content: "Instructions only", timestamp: 2 }] },
    activeNames: activeToolNames, expected: [], registryReads: 0,
  },
  {
    name: "falls back to active direct and model-only codemode entry points only",
    context: { messages: [userMessage] },
    activeNames: activeToolNames, expected: sampleRegistry.slice(0, 2), registryReads: 1,
  },
  {
    name: "excludes hidden registry tools even when active",
    context: { messages: [userMessage] },
    activeNames: [...activeToolNames, "hidden"], expected: sampleRegistry.slice(0, 2), registryReads: 1,
  },
];

for (const testCase of toolSelectionCases) {
  test(`Bridge.getTools: ${testCase.name}`, (t) => {
    const getAllTools = t.mock.fn(() => sampleRegistry);
    const getActiveTools = t.mock.fn(() => testCase.activeNames);
    const pi = { getAllTools, getActiveTools } satisfies Pick<ExtensionAPI, "getAllTools" | "getActiveTools">;
    const bridge = new Bridge(pi as unknown as ExtensionAPI, new CliDriver());

    assert.deepEqual(bridge.getTools(testCase.context), testCase.expected);
    assert.equal(getAllTools.mock.callCount(), testCase.registryReads);
    assert.equal(getActiveTools.mock.callCount(), testCase.registryReads);
  });
}
