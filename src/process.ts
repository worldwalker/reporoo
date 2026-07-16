import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  return result.stdout.trim();
}

export async function commandWorks(
  executable: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await runCommand(executable, args);
    return true;
  } catch {
    return false;
  }
}
