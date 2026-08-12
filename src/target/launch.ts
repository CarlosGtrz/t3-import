import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export interface LaunchCommand {
  command: string;
  args: string[];
}

function windowsExecutable(environment: NodeJS.ProcessEnv): string | undefined {
  const roots = [
    environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, "Programs", "t3code"),
    environment.ProgramFiles && join(environment.ProgramFiles, "t3code"),
    environment["ProgramFiles(x86)"] && join(environment["ProgramFiles(x86)"]!, "t3code"),
  ].filter((value): value is string => Boolean(value));
  const preferred = ["T3 Code (Nightly).exe", "T3 Code.exe", "T3 Code (Alpha).exe"];
  for (const root of roots) {
    for (const name of preferred) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
    try {
      const discovered = readdirSync(root)
        .filter((name) => /^T3 Code.*\.exe$/iu.test(name) && !name.toLowerCase().startsWith("uninstall "))
        .sort()[0];
      if (discovered) return join(root, discovered);
    } catch {
      // Continue through the remaining installation roots.
    }
  }
  return undefined;
}

function macApplication(userHome: string): string | undefined {
  const names = ["T3 Code (Nightly).app", "T3 Code.app", "T3 Code (Alpha).app"];
  for (const root of ["/Applications", join(userHome, "Applications")]) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveT3Launch(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): LaunchCommand {
  const override = environment.T3_CODE_BIN?.trim();
  if (override) return { command: override, args: [] };
  if (platform === "win32") {
    const executable = windowsExecutable(environment);
    if (executable) return { command: executable, args: [] };
    throw new Error("T3 Code is not installed under the standard Windows Programs directory. Set T3_CODE_BIN to its executable path.");
  }
  if (platform === "darwin") {
    const application = macApplication(userHome);
    return application
      ? { command: "open", args: [application] }
      : { command: "open", args: ["-b", "com.t3tools.t3code"] };
  }
  return { command: "t3code", args: [] };
}

export function launchT3Code(): Promise<void> {
  const launch = resolveT3Launch();
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", (cause) => {
      reject(new Error(`Unable to start T3 Code with ${basename(launch.command)}: ${cause.message}`, { cause }));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
