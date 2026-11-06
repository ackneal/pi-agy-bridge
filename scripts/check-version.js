import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { version } from "../src/version.js";

const root = new URL("../", import.meta.url);
const packageManifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const pluginManifest = JSON.parse(await readFile(new URL("plugin/plugin.json", root), "utf8"));

assert.match(packageManifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "release version must be stable SemVer");
assert.equal(pluginManifest.version, packageManifest.version, "plugin version must match package version");
assert.equal(version, packageManifest.version, "shared runtime version must match package version");

const tag = process.argv[2];
if (tag !== undefined) {
  assert.equal(tag, `v${packageManifest.version}`, "release tag must match package version");
}

console.log(`Release version verified: ${packageManifest.version}${tag ? ` (${tag})` : ""}`);
