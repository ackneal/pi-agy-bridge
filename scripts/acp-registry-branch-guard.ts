import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const AUTOMATION_BRANCH = "automation/update-acp-registry";
export const AUTOMATION_BASE = "main";
export const AUTOMATION_REGISTRY_PATH = "src/extension/drivers/acp/registry.json";
export const AUTOMATION_BOT_LOGIN = "github-actions[bot]";
export const AUTOMATION_BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export interface OpenPullRequestSummary {
  number: number;
  authorLogin: string;
  baseRef: string;
}

export interface BranchCommitSummary {
  sha: string;
  authorEmail: string;
  committerEmail: string;
}

export interface AutomationBranchState {
  branchExists: boolean;
  openPullRequests: readonly OpenPullRequestSummary[];
  commits: readonly BranchCommitSummary[];
  changedFiles: readonly string[];
}

export interface GuardOptions {
  branch?: string;
  base?: string;
  allowedPath?: string;
  botLogin?: string;
  botEmail?: string;
}

export type BranchGuardDecision =
  | { mode: "create" }
  | { mode: "recreate" }
  | { mode: "update"; prNumber: number };

export function validateAutomationBranchState(
  state: AutomationBranchState,
  options: GuardOptions = {},
): BranchGuardDecision {
  const branch = options.branch ?? AUTOMATION_BRANCH;
  const base = options.base ?? AUTOMATION_BASE;
  const allowedPath = options.allowedPath ?? AUTOMATION_REGISTRY_PATH;
  const botLogin = options.botLogin ?? AUTOMATION_BOT_LOGIN;
  const botEmail = options.botEmail ?? AUTOMATION_BOT_EMAIL;

  for (const pr of state.openPullRequests) {
    if (pr.authorLogin !== botLogin) {
      throw new Error(
        `Refusing to update open PR #${pr.number} on '${branch}': owned by '${pr.authorLogin}', not '${botLogin}'.`,
      );
    }
    if (pr.baseRef !== base) {
      throw new Error(
        `Refusing to update open PR #${pr.number} on '${branch}': targets '${pr.baseRef}' instead of '${base}'.`,
      );
    }
  }
  if (state.openPullRequests.length > 1) {
    throw new Error(`Refusing to update '${branch}': multiple open PRs exist.`);
  }

  if (!state.branchExists) {
    return { mode: "create" };
  }

  for (const commit of state.commits) {
    if (commit.authorEmail !== botEmail || commit.committerEmail !== botEmail) {
      throw new Error(
        `Refusing to update existing branch '${branch}': commit ${commit.sha.slice(0, 7)} was not authored and committed by '${botEmail}'.`,
      );
    }
  }

  const unrelatedFiles = state.changedFiles.filter((file) => file !== allowedPath);
  if (unrelatedFiles.length > 0) {
    throw new Error(
      `Refusing to update existing branch '${branch}': modifies unrelated file(s): ${unrelatedFiles.join(", ")}.`,
    );
  }

  const [openPr] = state.openPullRequests;
  return openPr ? { mode: "update", prNumber: openPr.number } : { mode: "recreate" };
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 2_000_000 });
  return stdout.trim();
}

export async function inspectGitBranchState(options: {
  cwd?: string;
  remote?: string;
  branch?: string;
  base?: string;
} = {}): Promise<Omit<AutomationBranchState, "openPullRequests">> {
  const cwd = options.cwd ?? process.cwd();
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? AUTOMATION_BRANCH;
  const base = options.base ?? AUTOMATION_BASE;

  await runGit(["fetch", remote, base], cwd);
  const lsRemote = await runGit(["ls-remote", "--heads", remote, branch], cwd);
  if (!lsRemote) {
    return { branchExists: false, commits: [], changedFiles: [] };
  }

  await runGit(["fetch", remote, branch], cwd);
  const baseRef = `${remote}/${base}`;
  const branchRef = `${remote}/${branch}`;

  const logOutput = await runGit(["log", "--format=%H%x09%ae%x09%ce", `${baseRef}..${branchRef}`], cwd);
  const commits = logOutput
    ? logOutput.split("\n").map((line) => {
        const [sha = "", authorEmail = "", committerEmail = ""] = line.split("\t");
        return { sha, authorEmail, committerEmail };
      })
    : [];

  const mergeBase = await runGit(["merge-base", baseRef, branchRef], cwd);
  const diffOutput = await runGit(["diff", "--name-only", mergeBase, branchRef], cwd);
  const changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];

  return { branchExists: true, commits, changedFiles };
}

async function fetchOpenPullRequests(repository: string, branch: string): Promise<OpenPullRequestSummary[]> {
  const [owner] = repository.split("/");
  if (!owner) {
    throw new Error(`Invalid GITHUB_REPOSITORY value '${repository}'.`);
  }
  const head = encodeURIComponent(`${owner}:${branch}`);
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `repos/${repository}/pulls?head=${head}&state=open&per_page=10`],
    { maxBuffer: 2_000_000 },
  );
  const parsed = JSON.parse(stdout) as Array<{
    number: number;
    user?: { login?: string } | null;
    base?: { ref?: string } | null;
  }>;
  return parsed.map((pr) => ({
    number: pr.number,
    authorLogin: pr.user?.login ?? "",
    baseRef: pr.base?.ref ?? "",
  }));
}

function escapeWorkflowCommand(message: string): string {
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function appendSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`);
  }
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY must be set to verify PR ownership.");
  }

  const [gitState, openPullRequests] = await Promise.all([
    inspectGitBranchState(),
    fetchOpenPullRequests(repository, AUTOMATION_BRANCH),
  ]);

  const decision = validateAutomationBranchState({
    ...gitState,
    openPullRequests,
  });

  const detail =
    decision.mode === "update"
      ? `Verified ownership of existing PR #${decision.prNumber} on '${AUTOMATION_BRANCH}'.`
      : decision.mode === "recreate"
        ? `Verified ownership of existing branch '${AUTOMATION_BRANCH}' (no open PR).`
        : `Branch '${AUTOMATION_BRANCH}' does not exist yet; safe to create.`;

  console.log(detail);
  appendSummary(`- **PR branch check:** ${detail}`);
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`::error title=ACP registry PR branch guard failed::${escapeWorkflowCommand(reason)}`);
    appendSummary(`- **PR branch check failed:** ${reason}`);
    process.exitCode = 1;
  }
}
