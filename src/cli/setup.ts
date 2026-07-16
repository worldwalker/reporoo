import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { commandWorks, runCommand } from "../process.js";

const root = resolve(import.meta.dirname, "../..");
const codex = resolve(root, "node_modules/.bin/codex");
const noLogin = process.argv.includes("--no-login");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runInteractive(executable: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runAsRoot(executable: string, args: readonly string[]): Promise<void> {
  const isRoot = process.getuid?.() === 0;
  await runInteractive(isRoot ? executable : "sudo", isRoot ? args : [executable, ...args]);
}

async function installCodexLinuxSandbox(): Promise<void> {
  if (platform() !== "linux" || !(await commandWorks("apt-get", ["--version"]))) return;

  console.log("Installing the Codex Linux sandbox…");
  await runAsRoot("apt-get", ["update"]);
  await runAsRoot("apt-get", [
    "install",
    "-y",
    "bubblewrap",
    "apparmor-profiles",
    "apparmor-utils",
  ]);

  const extraProfile = "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
  const activeProfile = "/etc/apparmor.d/bwrap-userns-restrict";
  if (await pathExists(extraProfile)) {
    await runAsRoot("install", ["-m", "0644", extraProfile, activeProfile]);
  }
  if (await pathExists(activeProfile)) {
    await runAsRoot("apparmor_parser", ["-r", activeProfile]);
  }

  if (!(await commandWorks("bwrap", ["--version"]))) {
    throw new Error("Bubblewrap was installed but is not available on PATH.");
  }
}

async function installGitHubCli(): Promise<void> {
  if (await commandWorks("gh", ["--version"])) return;

  if (platform() === "darwin" && (await commandWorks("brew", ["--version"]))) {
    console.log("Installing GitHub CLI with Homebrew…");
    await runInteractive("brew", ["install", "gh"]);
    return;
  }

  if (platform() === "linux" && (await commandWorks("apt-get", ["--version"]))) {
    const isRoot = process.getuid?.() === 0;
    const executable = isRoot ? "apt-get" : "sudo";
    const prefix = isRoot ? [] : ["apt-get"];
    console.log("Installing GitHub CLI with apt…");
    await runInteractive(executable, [...prefix, "update"]);
    await runInteractive(executable, [...prefix, "install", "-y", "gh"]);
    return;
  }

  throw new Error(
    "GitHub CLI is missing and no supported package manager was found (Homebrew on macOS or apt on Linux).",
  );
}

async function ensureAuthentication(): Promise<boolean> {
  const codexAuthenticated = await commandWorks(codex, ["login", "status"]);
  if (!codexAuthenticated) {
    if (noLogin || !process.stdin.isTTY) {
      console.warn("Codex needs authentication: npm exec codex login");
    } else {
      console.log("Opening Codex login…");
      await runInteractive(codex, ["login"]);
    }
  }

  const githubAuthenticated = await commandWorks("gh", ["auth", "status"]);
  if (!githubAuthenticated) {
    if (noLogin || !process.stdin.isTTY) {
      console.warn("GitHub CLI needs authentication: gh auth login");
    } else {
      console.log("Opening GitHub login…");
      await runInteractive("gh", ["auth", "login"]);
    }
  }

  if (await commandWorks("gh", ["auth", "status"])) {
    await runCommand("gh", ["auth", "setup-git"]);
  }

  return (
    (await commandWorks(codex, ["login", "status"])) &&
    (await commandWorks("gh", ["auth", "status"]))
  );
}

async function ensureEnvironmentFile(): Promise<void> {
  const destination = resolve(root, ".env");
  if (!(await pathExists(destination))) {
    await copyFile(resolve(root, ".env.example"), destination);
    console.log("Created .env from .env.example");
  }
}

async function main(): Promise<void> {
  if (!(await isExecutable(codex))) {
    throw new Error("Bundled Codex CLI is missing. Run npm install first.");
  }

  console.log(await runCommand(codex, ["--version"]));
  await installCodexLinuxSandbox();
  await installGitHubCli();
  console.log((await runCommand("gh", ["--version"])).split("\n")[0]);
  const authenticated = await ensureAuthentication();
  await ensureEnvironmentFile();

  console.log(
    authenticated
      ? "\nRepoRoo setup is complete. Add the Telegram token and chat IDs to .env."
      : "\nRepoRoo dependencies are installed. Complete the login commands above, then add Telegram settings to .env.",
  );
}

main().catch((error: unknown) => {
  console.error("RepoRoo setup failed", error);
  process.exitCode = 1;
});
