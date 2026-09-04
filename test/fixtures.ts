/** Anonymized provider payloads captured/derived during research. */

export const codexRateLimits = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1788537713 },
    secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1788806119 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1788537713 },
      secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1788806119 },
      planType: "plus",
    },
    spark: {
      limitId: "spark",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1788537713 },
      planType: "plus",
    },
  },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      {
        id: "RateLimitResetCredit_abc",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1788484113,
        expiresAt: 1791076113,
        title: "Full reset (Weekly + 5 hr)",
        description: "Thanks for using Codex!",
      },
    ],
  },
};

export const claudeUsage = {
  five_hour: { utilization: 6.0, resets_at: "2026-04-08T18:59:59Z" },
  seven_day: { utilization: 35.0, resets_at: "2026-04-14T16:59:59Z" },
  seven_day_opus: { utilization: 12.0, resets_at: "2026-04-14T17:59:59Z" },
  seven_day_sonnet: null,
  seven_day_oauth_apps: null,
  extra_usage: { is_enabled: true, monthly_limit: 100.0, used_credits: 12.5, utilization: 12.5 },
};

export const claudeUsageLimitsOnly = {
  limits: [
    { type: "session", utilization: 40, resets_at: "2026-04-08T18:59:59Z" },
    { type: "weekly_all", utilization: 88, resets_at: "2026-04-14T16:59:59Z" },
  ],
};

export const cursorUsage = {
  billingCycleStart: "1768399334000",
  billingCycleEnd: "1771077734000",
  planUsage: {
    totalSpend: 23222,
    includedSpend: 23222,
    bonusSpend: 0,
    remaining: 16778,
    limit: 40000,
    totalPercentUsed: 58.055,
    autoPercentUsed: 0,
    apiPercentUsed: 46.444,
  },
  spendLimitUsage: {
    totalSpend: 0,
    individualLimit: 10000,
    individualUsed: 2500,
    individualRemaining: 7500,
    limitType: "user",
  },
};

export const openCodeUsage = {
  usage: {
    rolling: { status: "ok", percent: 4, resetsAt: "2026-08-13T16:27:38.287Z" },
    weekly: { status: "rate-limited", percent: 97, resetsAt: "2026-08-17T00:00:00.287Z" },
    monthly: { status: "ok", percent: 1, resetsAt: "2026-09-13T06:06:01.287Z" },
  },
};
