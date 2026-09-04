#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { codexLogin } from "./adapters/codex.ts";
import { claudeAuthStatus, verifyClaudeToken } from "./adapters/claude.ts";
import { fetchOpenCodeUsage } from "./adapters/opencode.ts";
import { collectReport } from "./collect.ts";
import { DEFAULT_HOST, DEFAULT_PORT, PACKAGE_NAME, VERSION, ensureDir } from "./config.ts";
import { openInBrowser, runInteractive, which } from "./proc.ts";
import { deleteAccount, getAccount, listAccounts, newAccountId, profileDirFor, saveAccount, updateAccount } from "./registry.ts";
import { secretStore } from "./secrets.ts";
import { startServer } from "./server.ts";
import { renderReport } from "./terminal.ts";
import { PROVIDERS, providerName, type ProviderId, type UpdateInfo } from "./types.ts";
import { checkForUpdate, detectPackageManager, runUpgrade } from "./update.ts";

const HELP = `${PACKAGE_NAME} v${VERSION}
One local page for your coding-CLI subscription quotas.

Usage
  just-usage                     Start the server and open the page
  just-usage serve [options]     Start the server
      --port <n>                 Port (default ${DEFAULT_PORT})
      --host <addr>              Bind address (default ${DEFAULT_HOST}; use 127.0.0.1 for local only)
      --no-open                  Don't open a browser
  just-usage status [--json]     Print quotas in the terminal
  just-usage accounts            List accounts
  just-usage add <provider>      Add an account (codex | claude | opencode)
      --label <name>             Friendly name
      --token                    Claude only: paste a \`claude setup-token\` instead of a profile login
  just-usage login <account-id>  Re-authenticate a profile account
  just-usage remove <account-id> Remove an account and anything we stored for it
  just-usage upgrade [--check]   Update to the latest release
  just-usage --version

Providers: ${PROVIDERS.map((p) => p.name).join(", ")}
Cursor uses whatever \`cursor-agent\` is logged in as (single account).
`;

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function isProvider(v: string | undefined): v is ProviderId {
  return PROVIDERS.some((p) => p.id === v);
}

async function prompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const muted = opts.secret && process.stdin.isTTY;
  return new Promise((resolve) => {
    if (muted) {
      // Print the question ourselves, then swallow echo while the secret is typed.
      process.stdout.write(question);
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
      anyRl._writeToOutput = (s: string) => {
        if (s.includes("\n")) process.stdout.write("\n");
      };
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

// ---- commands ------------------------------------------------------------

async function cmdServe(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      "no-open": { type: "boolean" },
      open: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`invalid port: ${values.port}`);
  const host = typeof values.host === "string" && values.host ? values.host : DEFAULT_HOST;
  const shouldOpen = values["no-open"] !== true && values.open !== false;

  let update: UpdateInfo | null = null;
  void checkForUpdate().then((u) => {
    update = u;
    if (u?.available) console.log(`\nUpdate available: v${u.current} → v${u.latest}. Run: just-usage upgrade\n`);
  });

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ host, port, getUpdate: () => update });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") fail(`Port ${port} is already in use. Try: just-usage serve --port ${port + 1}`);
    throw e;
  }
  console.log(`${PACKAGE_NAME} v${VERSION}`);
  for (const [i, url] of server.urls.entries()) console.log(`  ${i === 0 ? "local   " : "network "} ${url}`);
  console.log(`\nPress Ctrl+C to stop.`);
  if (shouldOpen) openInBrowser(server.urls[0]!);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdStatus(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } }, allowPositionals: true, strict: false });
  const [report, update] = await Promise.all([collectReport(null), checkForUpdate().catch(() => null)]);
  report.update = update;
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderReport(report));
}

function cmdAccounts() {
  const rows = listAccounts();
  console.log("Default accounts come from each CLI's own login (codex login, claude /login, cursor-agent login, opencode auth login).");
  if (rows.length === 0) {
    console.log("\nNo extra accounts. Add one with: just-usage add codex | claude | opencode");
    return;
  }
  console.log("");
  const w = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    const extra = [r.email, r.kind, r.path].filter(Boolean).join("  ");
    console.log(`  ${r.id.padEnd(w)}  ${r.label}  ${extra}`);
  }
}

async function addCodex(label: string | undefined) {
  if (!(await which("codex"))) fail("codex is not installed (npm i -g @openai/codex).");
  const tmpId = newAccountId("codex", label ?? "pending");
  const dir = ensureDir(profileDirFor("codex", tmpId));
  console.log("Starting Codex login in an isolated profile…");
  const info = await codexLogin(dir, (url) => {
    console.log(`\nOpen this URL to sign in (opening your browser):\n${url}\n`);
    openInBrowser(url);
  });
  const finalLabel = label ?? info.email ?? tmpId.split(":")[1]!;
  const id = label ? tmpId : newAccountId("codex", finalLabel);
  const path = id === tmpId ? dir : ensureDir(profileDirFor("codex", id));
  if (path !== dir) {
    const { renameSync, rmSync } = await import("node:fs");
    rmSync(path, { recursive: true, force: true });
    renameSync(dir, path);
  }
  saveAccount({ id, provider: "codex", label: finalLabel, kind: "profile", path, email: info.email, createdAt: new Date().toISOString() });
  console.log(`Added ${id}${info.email ? ` (${info.email}${info.plan ? `, ${info.plan}` : ""})` : ""}.`);
}

async function addClaudeToken(label: string | undefined) {
  console.log("Run `claude setup-token` in the account you want to add, then paste the token here.");
  const token = await prompt("Token: ", { secret: true });
  if (!token) fail("No token given.");
  const check = await verifyClaudeToken(token);
  if (!check.ok) fail(`Token check failed: ${check.message}`);
  const finalLabel = label ?? check.email ?? "token";
  const id = newAccountId("claude", finalLabel);
  await secretStore().set(id, token);
  saveAccount({ id, provider: "claude", label: finalLabel, kind: "token", email: check.email, createdAt: new Date().toISOString() });
  console.log(`Added ${id}${check.email ? ` (${check.email})` : ""}. Token stored in ${secretStore().kind}.`);
}

async function addClaudeProfile(label: string | undefined) {
  if (!(await which("claude"))) fail("claude is not installed (npm i -g @anthropic-ai/claude-code).");
  const id = newAccountId("claude", label ?? "profile");
  const dir = ensureDir(profileDirFor("claude", id));
  console.log(`Starting Claude Code login in an isolated profile (CLAUDE_CONFIG_DIR=${dir})…\n`);
  await runInteractive("claude", ["auth", "login"], { CLAUDE_CONFIG_DIR: dir });
  const status = await claudeAuthStatus(dir);
  if (!status?.loggedIn) {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
    fail("Login did not complete; nothing was saved.");
  }
  saveAccount({ id, provider: "claude", label: label ?? id.split(":")[1]!, kind: "profile", path: dir, email: null, createdAt: new Date().toISOString() });
  console.log(`\nAdded ${id}. Note: on macOS the first read may trigger a Keychain prompt — choose "Always Allow".`);
}

async function addOpenCode(label: string | undefined) {
  console.log("Paste an OpenCode Go API key (from https://opencode.ai/ → Go → API keys).");
  const key = await prompt("Key: ", { secret: true });
  if (!key) fail("No key given.");
  const { status, windows } = await fetchOpenCodeUsage(key);
  if (status === 401) fail("Key rejected (401).");
  if (status === 403) console.log("Warning: key is valid but has no active OpenCode Go subscription (403). Saving anyway.");
  else if (status !== 200) fail(`Usage endpoint returned HTTP ${status}.`);
  const finalLabel = label ?? "go";
  const id = newAccountId("opencode", finalLabel);
  await secretStore().set(id, key);
  saveAccount({ id, provider: "opencode", label: finalLabel, kind: "token", createdAt: new Date().toISOString() });
  console.log(`Added ${id}${windows.length ? ` (${windows.map((w) => `${w.label} ${w.usedPercent}%`).join(", ")})` : ""}. Key stored in ${secretStore().kind}.`);
}

async function cmdAdd(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { label: { type: "string", short: "l" }, token: { type: "boolean" } },
    allowPositionals: true,
  });
  const provider = positionals[0];
  if (!isProvider(provider)) fail(`Usage: just-usage add <codex|claude|opencode> [--label name] [--token]`);
  switch (provider) {
    case "codex":
      return addCodex(values.label);
    case "claude":
      return values.token ? addClaudeToken(values.label) : addClaudeProfile(values.label);
    case "opencode":
      return addOpenCode(values.label);
    case "cursor":
      fail("Cursor is single-account: just-usage shows whatever `cursor-agent` is logged in as.");
  }
}

async function cmdLogin(argv: string[]) {
  const id = argv[0];
  if (!id) fail("Usage: just-usage login <account-id>");
  const rec = getAccount(id);
  if (!rec) fail(`Unknown account: ${id}`);
  if (rec.kind !== "profile" || !rec.path) fail(`${id} is a ${rec.kind} account; remove and re-add it instead.`);
  if (rec.provider === "codex") {
    const info = await codexLogin(rec.path, (url) => {
      console.log(`\nOpen this URL to sign in (opening your browser):\n${url}\n`);
      openInBrowser(url);
    });
    updateAccount(id, { email: info.email });
    console.log(`Re-authenticated ${id}${info.email ? ` (${info.email})` : ""}.`);
  } else if (rec.provider === "claude") {
    await runInteractive("claude", ["auth", "login"], { CLAUDE_CONFIG_DIR: rec.path });
    const status = await claudeAuthStatus(rec.path);
    console.log(status?.loggedIn ? `Re-authenticated ${id}.` : "Login did not complete.");
  } else {
    fail(`${providerName(rec.provider)} accounts cannot be re-authenticated this way.`);
  }
}

async function cmdRemove(argv: string[]) {
  const id = argv[0];
  if (!id) fail("Usage: just-usage remove <account-id>");
  if (id.endsWith(":default")) fail("Default accounts belong to the CLI itself; sign out there instead.");
  const rec = deleteAccount(id);
  if (!rec) fail(`Unknown account: ${id}`);
  if (rec.kind === "token") await secretStore().delete(id);
  console.log(`Removed ${id}.`);
}

async function cmdUpgrade(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { check: { type: "boolean" }, yes: { type: "boolean", short: "y" } }, allowPositionals: true, strict: false });
  const info = await checkForUpdate(true);
  if (!info) fail("Could not determine the latest release (GitHub/npm unreachable, or nothing published yet).");
  if (!info.available) {
    console.log(`just-usage v${VERSION} is up to date.`);
    return;
  }
  console.log(`Update available: v${info.current} → v${info.latest}`);
  if (values.check) return;
  const pm = detectPackageManager();
  if (!values.yes && process.stdin.isTTY) {
    const answer = await prompt(`Upgrade now with ${pm}? [Y/n] `);
    if (answer && !/^y(es)?$/i.test(answer)) return;
  }
  const code = await runUpgrade(pm, info.latest);
  if (code !== 0) fail(`Upgrade command exited with ${code}.`);
  console.log(`Upgraded to v${info.latest}.`);
}

// ---- main -----------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case undefined:
      return cmdServe([]);
    case "serve":
      return cmdServe(argv.slice(1));
    case "status":
      return cmdStatus(argv.slice(1));
    case "accounts":
      return cmdAccounts();
    case "add":
      return cmdAdd(argv.slice(1));
    case "login":
      return cmdLogin(argv.slice(1));
    case "remove":
    case "rm":
      return cmdRemove(argv.slice(1));
    case "upgrade":
    case "update":
      return cmdUpgrade(argv.slice(1));
    default:
      if (cmd.startsWith("-")) return cmdServe(argv);
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
