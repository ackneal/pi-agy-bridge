export interface ProbeIdentity { server: string; tool: string; conflict: boolean }

/** ACP updates are incremental. Missing fields do not revoke an established
 * identity; explicit conflicting or malformed identity fields cannot re-arm it. */
export function mergeProbeIdentity(prior: ProbeIdentity | undefined, meta: unknown): ProbeIdentity {
  const identity = prior ? { server: prior.server, tool: prior.tool, conflict: prior.conflict } : { server: "", tool: "", conflict: false };
  if (identity.conflict || meta == null) return identity;
  if (typeof meta !== "object" || Array.isArray(meta)) return { ...identity, conflict: true };
  if (!("mcp" in meta)) return identity;
  const mcp = meta.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return { ...identity, conflict: true };
  for (const key of ["server", "tool"] as const) {
    if (!(key in mcp)) continue;
    const value: unknown = Reflect.get(mcp, key);
    if (typeof value !== "string" || !value.trim() || identity[key] && identity[key] !== value) return { ...identity, conflict: true };
    identity[key] = value;
  }
  return identity;
}
