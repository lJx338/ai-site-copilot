import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";

// The Vinext request runtime is restricted to the system temporary directory.
// Set one explicit path before importing Vinext so the API process and the
// preview child process always address the same workspace. Relying on
// os.tmpdir() in each process is unsafe here because the host and the Vinext
// runtime can report different temporary roots.
const defaultWorkspaceRoot = process.platform === "win32"
  ? `${process.env.TEMP || process.env.TMP || "C:\\Temp"}\\ai-site-copilot-workspaces`
  : "/tmp/ai-site-copilot-workspaces";
const runtimeEnv = {
  ...process.env,
  AI_WORKSPACE_ROOT: process.env.AI_WORKSPACE_ROOT || defaultWorkspaceRoot,
  AI_PREVIEW_WORKSPACE_ROOT: process.env.AI_PREVIEW_WORKSPACE_ROOT || `${process.cwd()}/.ai-site-copilot-workspaces`,
};
process.env.AI_WORKSPACE_ROOT = runtimeEnv.AI_WORKSPACE_ROOT;

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

let previewServer;
if (command === "dev") {
  previewServer = spawn(process.execPath, [
    fileURLToPath(new URL("./preview-server.mjs", import.meta.url)),
  ], { stdio: "inherit", env: runtimeEnv });
  const stopPreviewServer = () => previewServer?.kill("SIGTERM");
  process.once("SIGINT", stopPreviewServer);
  process.once("SIGTERM", stopPreviewServer);
  process.once("exit", stopPreviewServer);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
