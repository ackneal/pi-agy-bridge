import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readAcpVersion(executable: string, args: readonly string[] = process.platform === "linux" ? ["--uid="] : []): Promise<string | undefined> {
  const { stdout, stderr } = await execFileAsync(executable, [...args, "--version"], {
    encoding: "utf-8",
    timeout: 5000,
  });

  return /^Build label:[ \t]*([^\r\n]+)$/m.exec(stdout || stderr)?.[1]?.trim() || undefined;
}
