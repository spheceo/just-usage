# just-usage

Local CLI that detects installed coding CLIs on this machine, fetches their subscription quotas, and serves a localhost page to view them.

Not a proxy. Not a website. Not CLIProxyAPI.

```
npx just-usage
  → detect claude / codex / gemini / grok
  → fetch live quota for each logged-in CLI
  → serve http://127.0.0.1:8787
  → one page of cards
```

## Why this exists

CLIProxyAPI already has a quota page, but it sits behind a running proxy, a management key, and OAuth accounts the proxy holds. We mainly want:

**multiple installed CLIs → one quota page**

`CLIProxyAPI-Quota-Inspector/` in this folder is the existing CLI Proxy quota tool, cloned as-is for reference. Do not treat it as our codebase. Our product talks to the CLIs directly, not through CPA.

## Product shape

- Run via `npx just-usage` (or a local bin)
- Bind only to `127.0.0.1` (default port `8787`)
- Auto-open the browser; `--no-open` to skip
- Close the process, the page is gone
- v1 is read-only: no token writes, no account pools, no failover, no cost estimates

## v1 scope

Ship adapters in this order:

1. **Codex** — spawn `codex app-server`, JSON-RPC `account/rateLimits/read`. Official-ish. Best path.
2. **Claude Code** — undocumented `GET /api/oauth/usage` with a `claude-code/...` User-Agent. Useful, fragile, rate-limited if polled.
3. **Gemini** — detect and show “installed / signed in / quota unsupported” until the adapter is solid.
4. **Grok** — later.

A gray card that says “couldn’t read quota” is better than a wrong bar.

## Discovery

On launch, keep it dumb:

- `which claude` / `codex` / `gemini` / `grok`
- known homes: `~/.claude`, `~/.codex`, `~/.gemini`
- cheap signed-in checks (`claude auth status`, Codex auth present, etc.)

Show only what exists. No config file in v1.

## Normalized quota shape

Every adapter returns the same type so the page stays dumb:

```ts
{
  id: "codex" | "claude" | "gemini",
  name: "Codex",
  installed: true,
  signedIn: true,
  plan?: "plus",
  windows: [
    { label: "5h", usedPercent: 22, resetsAt: "..." },
    { label: "7d", usedPercent: 41, resetsAt: "..." }
  ],
  error?: "not signed in" | "unsupported" | "rate limited"
}
```

New CLI = new adapter file. Same UI.

## Tech stack (minimal)

- TypeScript + Node 20+
- One package, `bin` → `just-usage`
- `tsup` to emit one JS file
- Hono (or `node:http`) on `127.0.0.1`
- One JSON route: `GET /api/quotas`
- One HTML file, vanilla JS + a little CSS — no React in v1
- `open` to launch the browser
- Adapters use `child_process` (Codex) and `fetch` (Claude)

No database. No Tailwind build. No dashboard framework.

## Rules

- Do not go through CLIProxyAPI.
- Do not scrape tokens if the CLI can do it (Codex already can).
- Treat any local credential we must read (likely Claude) as radioactive: never log it, never write it.
- Cache Claude ~60–180s. Refresh on button click only. Do not poll in a loop.
- Isolate adapters (`src/adapters/codex.ts`, …). A broken adapter degrades; it does not crash the server.

## Page

- One card per detected CLI
- Bars + “resets in 3h”
- Gray card if installed but not signed in
- Manual **Refresh** button
- `--json` can come later for scripting

## Reference in this folder

`CLIProxyAPI-Quota-Inspector/` is a full clone of https://github.com/AllenReder/CLIProxyAPI-Quota-Inspector. Left exactly as cloned. Use it to study how they normalize 5h/7d windows and render status — not as something we fork or run as our app.
