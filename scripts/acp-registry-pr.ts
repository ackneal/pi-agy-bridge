import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const AUTOMATION_BRANCH = "automation/update-acp-registry";
const AUTOMATION_BASE = "main";
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

export interface PullRequestClient {
  fetchOpenPullRequests(repository: string, branch: string): Promise<OpenPullRequestSummary[]>;
  createPullRequest(params: {
    repository: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<string>;
  updatePullRequest(params: {
    repository: string;
    prNumber: number;
    title: string;
    body: string;
  }): Promise<void>;
}

export interface PublishPrOptions extends GuardOptions {
  cwd?: string;
  remote?: string;
  repository: string;
  localVersion: string;
  upstreamVersion: string;
  upstreamUrl?: string;
  prClient?: PullRequestClient;
}

export type PublishPrResult =
  | { status: "created"; mode: "create" | "recreate"; prUrl: string }
  | { status: "updated"; mode: "update"; prNumber: number }
  | { status: "unchanged"; mode: "update"; prNumber: number };

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

async function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 2_000_000,
  });
  return stdout.trim();
}

async function hasStagedDiff(allowedPath: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["diff", "--cached", "--quiet", "--", allowedPath], { cwd });
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
      return true;
    }
    throw error;
  }
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

function buildPrTitle(upstreamVersion: string): string {
  return `chore: update ACP registry to ${upstreamVersion}`;
}

function buildPrBody(params: {
  localVersion: string;
  upstreamVersion: string;
  upstreamUrl?: string;
}): string {
  const lines = [
    `Update \`${AUTOMATION_REGISTRY_PATH}\` from \`${params.localVersion}\` to \`${params.upstreamVersion}\`.`,
    "",
  ];
  if (params.upstreamUrl) {
    lines.push(`- Source: \`${params.upstreamUrl}\``);
  }
  lines.push(
    "- Validated schema, platform coverage, official Google HTTPS archive URLs, and SHA-256 checksums without downloading binaries.",
    "",
    "> [!NOTE]",
    "> Because this pull request was created or updated with `GITHUB_TOKEN`, a maintainer with write access must approve workflow runs in the merge box before required CI checks execute.",
  );
  return lines.join("\n");
}

function createGhPullRequestClient(cwd: string): PullRequestClient {
  return {
    async fetchOpenPullRequests(repository: string, branch: string): Promise<OpenPullRequestSummary[]> {
      const [owner] = repository.split("/");
      if (!owner) {
        throw new Error(`Invalid GITHUB_REPOSITORY value '${repository}'.`);
      }
      const head = encodeURIComponent(`${owner}:${branch}`);
      const { stdout } = await execFileAsync(
        "gh",
        ["api", `repos/${repository}/pulls?head=${head}&state=open&per_page=10`],
        { cwd, maxBuffer: 2_000_000 },
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
    },

    async createPullRequest(params): Promise<string> {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          params.repository,
          "--base",
          params.base,
          "--head",
          params.head,
          "--title",
          params.title,
          "--body",
          params.body,
        ],
        { cwd, maxBuffer: 2_000_000 },
      );
      return stdout.trim();
    },

    async updatePullRequest(params): Promise<void> {
      await execFileAsync(
        "gh",
        [
          "pr",
          "edit",
          String(params.prNumber),
          "--repo",
          params.repository,
          "--title",
          params.title,
          "--body",
          params.body,
        ],
        { cwd, maxBuffer: 2_000_000 },
      );
    },
  };
}

export async function publishAutomationPullRequest(options: PublishPrOptions): Promise<PublishPrResult> {
  const cwd = options.cwd ?? process.cwd();
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? AUTOMATION_BRANCH;
  const base = options.base ?? AUTOMATION_BASE;
  const allowedPath = options.allowedPath ?? AUTOMATION_REGISTRY_PATH;
  const botLogin = options.botLogin ?? AUTOMATION_BOT_LOGIN;
  const botEmail = options.botEmail ?? AUTOMATION_BOT_EMAIL;
  const prClient = options.prClient ?? createGhPullRequestClient(cwd);

  const [gitState, openPullRequests] = await Promise.all([
    inspectGitBranchState({ cwd, remote, branch, base }),
    prClient.fetchOpenPullRequests(options.repository, branch),
  ]);

  const decision = validateAutomationBranchState(
    { ...gitState, openPullRequests },
    { branch, base, allowedPath, botLogin, botEmail },
  );

  const title = buildPrTitle(options.upstreamVersion);
  const body = buildPrBody({
    localVersion: options.localVersion,
    upstreamVersion: options.upstreamVersion,
    ...(options.upstreamUrl ? { upstreamUrl: options.upstreamUrl } : {}),
  });

  await runGit(["checkout", "-B", branch], cwd);
  await runGit(["add", "--", allowedPath], cwd);
  if (!(await hasStagedDiff(allowedPath, cwd))) {
    throw new Error(`No staged changes found in '${allowedPath}' to commit.`);
  }

  await runGit(["commit", "-m", title], cwd, {
    GIT_AUTHOR_NAME: botLogin,
    GIT_AUTHOR_EMAIL: botEmail,
    GIT_COMMITTER_NAME: botLogin,
    GIT_COMMITTER_EMAIL: botEmail,
  });

  const remoteBranchRef = `${remote}/${branch}`;
  if (decision.mode === "update" && gitState.commits.length === 1) {
    const shas = await runGit(
      ["rev-parse", `${remoteBranchRef}^{tree}`, `${branch}^{tree}`, `${remoteBranchRef}^`, `${branch}^`],
      cwd,
    );
    const [remoteTree, localTree, remoteParent, localParent] = shas.split("\n");
    if (remoteTree === localTree && remoteParent === localParent) {
      return { status: "unchanged", mode: "update", prNumber: decision.prNumber };
    }
  }

  if (gitState.branchExists) {
    const remoteSha = await runGit(["rev-parse", remoteBranchRef], cwd);
    await runGit(
      ["push", `--force-with-lease=refs/heads/${branch}:${remoteSha}`, remote, `${branch}:refs/heads/${branch}`],
      cwd,
    );
  } else {
    await runGit(["push", "-u", remote, `${branch}:refs/heads/${branch}`], cwd);
  }

  if (decision.mode === "update") {
    await prClient.updatePullRequest({
      repository: options.repository,
      prNumber: decision.prNumber,
      title,
      body,
    });
    return { status: "updated", mode: "update", prNumber: decision.prNumber };
  }

  const prUrl = await prClient.createPullRequest({
    repository: options.repository,
    base,
    head: branch,
    title,
    body,
  });
  return { status: "created", mode: decision.mode, prUrl };
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
    throw new Error("GITHUB_REPOSITORY must be set to manage the automation PR.");
  }
  const localVersion = process.env.LOCAL_VERSION?.trim();
  const upstreamVersion = process.env.UPSTREAM_VERSION?.trim();
  if (!localVersion || !upstreamVersion) {
    throw new Error("LOCAL_VERSION and UPSTREAM_VERSION must be set.");
  }
  const upstreamUrl = process.env.ACP_REGISTRY_UPSTREAM_URL?.trim();

  const result = await publishAutomationPullRequest({
    repository,
    localVersion,
    upstreamVersion,
    ...(upstreamUrl ? { upstreamUrl } : {}),
  });

  const detail =
    result.status === "created"
      ? `Created PR on '${AUTOMATION_BRANCH}' (${result.prUrl}).`
      : result.status === "updated"
        ? `Updated PR #${result.prNumber} on '${AUTOMATION_BRANCH}' to ${upstreamVersion}.`
        : `PR #${result.prNumber} on '${AUTOMATION_BRANCH}' already reflects ${upstreamVersion}; no push needed.`;

  console.log(detail);
  appendSummary(`- **PR lifecycle:** ${detail}`);
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`::error title=ACP registry PR automation failed::${escapeWorkflowCommand(reason)}`);
    appendSummary(`- **PR automation failed:** ${reason}`);
    process.exitCode = 1;
  }
}
