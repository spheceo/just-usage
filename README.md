# just-usage

One local page for your coding-CLI subscription quotas. Detects the CLIs installed on your machine, asks each one for its live rate-limit windows, and serves a small black dashboard on your network.

```sh
npm i -g just-usage
just-usage            # http://<your-host>:5757
```

## Providers

- Claude (Claude Code)
- Codex
- Cursor
- Antigravity (`agy`)
- Grok (`grok`)
- OpenCode Go

> Read-only. Credentials stay with the CLIs that own them and never reach the browser. Run `just-usage upgrade` to update.
