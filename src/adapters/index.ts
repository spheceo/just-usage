import type { QuotaSnapshot, ResolvedAccount } from "../types.ts";
import { fetchAntigravity } from "./antigravity.ts";
import { fetchClaude } from "./claude.ts";
import { fetchCodex } from "./codex.ts";
import { fetchCursor } from "./cursor.ts";
import { fetchOpenCode } from "./opencode.ts";

export function fetchSnapshot(account: ResolvedAccount): Promise<QuotaSnapshot> {
  switch (account.provider) {
    case "claude":
      return fetchClaude(account);
    case "codex":
      return fetchCodex(account);
    case "cursor":
      return fetchCursor(account);
    case "antigravity":
      return fetchAntigravity(account);
    case "opencode":
      return fetchOpenCode(account);
  }
}
