// Agent hook entry point shared by Claude Code and Gemini CLI.
// Modes: `post-edit` formats the edited file, `stop` runs the fast gates.
// It calls make targets only; each repo defines `fmt` and `verify` in its Makefile.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SAFE_PATH = /^[\w@+./-]+$/;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function parsePayload(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function postEdit(payload) {
  const filePath =
    payload.tool_input?.file_path ||
    payload.tool_input?.filePath ||
    payload.tool_input?.path ||
    process.argv[3];
  if (filePath && SAFE_PATH.test(filePath) && fs.existsSync(filePath)) {
    // Formatting problems must not block the agent.
    spawnSync("make", ["--no-print-directory", "fmt", `FILE=${filePath}`], {
      stdio: "inherit",
      timeout: 8000,
    });
  }
  process.exit(0);
}

function hasChanges() {
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return status.status === 0 && status.stdout.trim() !== "";
}

function stop(payload) {
  if (payload.stop_hook_active === true || !hasChanges()) {
    process.exit(0);
  }

  const run = spawnSync("make", ["--no-print-directory", "verify"], {
    encoding: "utf8",
    timeout: 110000,
  });
  if (run.status === 0) {
    process.exit(0);
  }

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd().split("\n").slice(-40);
  console.error(`make verify failed. Fix these errors before finishing:\n${output.join("\n")}`);
  process.exit(2);
}

async function main() {
  const mode = process.argv[2] ?? "post-edit";
  const payload = parsePayload(await readStdin());
  if (mode === "post-edit") postEdit(payload);
  if (mode === "stop") stop(payload);
}

main().catch(() => process.exit(0));
