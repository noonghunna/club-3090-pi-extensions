import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ModelScope retired the per-model monthly request quotas (the
// `modelscope-ratelimit-model-month-requests-*` response headers) in favor of
// account-level "magicube" credits. Every api_inference request spends
// magicubes, but ModelScope publishes no model->tier mapping (models list,
// response headers, and the rates API are all tier-only), so the rate for the
// selected model is derived from observed deductions: the transactions ledger
// aggregates SPEND_CONFIRM rows per (day, tier) as (total_amount, count), and
// diffing a before/after snapshot around the selected model's first response
// yields the exact per-request rate. Derived ONCE per model selection, then
// cached until the model changes. The status entry is visible only while a
// ModelScope model is active and is cleared as soon as another provider's
// model is selected.
const BALANCE_URL = "https://www.modelscope.ai/openapi/v1/magicubes/balance";
// Rows are (day, tier) aggregates — a handful per day — so one page is plenty;
// the diff only ever looks at the most recent rows.
const TRANSACTIONS_URL =
  "https://www.modelscope.ai/openapi/v1/magicubes/transactions?type=SPEND_CONFIRM&page=1&page_size=100";
const STATUS_KEY = "modelscope-magicubes";
// Balance only moves when requests are spent; throttle polling to one refresh
// per 15s even during tight agent loops.
const REFRESH_MS = 15_000;
// Derivation gives up after this many post-response diffs if the ledger never
// yields a clean single-tier delta.
const MAX_LEARN_ATTEMPTS = 2;

type TxRow = { gmt_created: string; model_tier: string; total_amount: number; count: number };
/** Accumulated SPEND_CONFIRM rows keyed by "<day>|<tier>". */
type TxTotals = Record<string, { amount: number; count: number }>;
/** Outcome of diffing two ledger snapshots. */
type Derivation =
  | { kind: "none" } // no tier moved: spend likely not confirmed yet — keep baseline, retry
  | { kind: "ambiguous" } // multiple tiers moved: foreign spend poisoned the window — re-baseline
  | { kind: "rate"; rate: number }; // exactly one tier moved — rate learned

/** Composite ledger key: spends aggregate per calendar day and tier. */
const txKey = (r: Pick<TxRow, "gmt_created" | "model_tier">) => `${r.gmt_created}|${r.model_tier}`;

export default function (pi: ExtensionAPI) {
  // Balance cache/state.
  let cachedBalanceText: string | undefined;
  let fetchedAt = 0;
  let inFlight: Promise<void> | undefined;
  let txInFlight: Promise<TxTotals> | undefined;

  // Rate derivation state (once per model selection).
  const learnedRates: Record<string, number> = {};
  let baseline: { modelId: string; tx: TxTotals } | undefined;
  let learnAttempts = 0;

  const fetchTx = (apiKey: string): Promise<TxTotals> => {
    txInFlight ??= (async () => {
      try {
        const res = await fetch(TRANSACTIONS_URL, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const body = res.ok
          ? ((await res.json()) as { success: boolean; data?: { records?: TxRow[] } })
          : undefined;
        const totals: TxTotals = {};
        for (const r of body?.success ? (body.data?.records ?? []) : []) {
          const k = txKey(r);
          const prev = totals[k];
          totals[k] = {
            amount: (prev?.amount ?? 0) + (r.total_amount ?? 0),
            count: (prev?.count ?? 0) + (r.count ?? 0),
          };
        }
        return totals;
      } finally {
        txInFlight = undefined;
      }
    })();
    return txInFlight;
  };

  /** Diff two ledger snapshots: single-tier movement -> per-request rate. */
  const deriveRate = (base: TxTotals, now: TxTotals): Derivation => {
    let movedTiers = 0;
    let rate = 0;
    for (const k of Object.keys(now)) {
      const deltaCount = now[k].count - (base[k]?.count ?? 0);
      if (deltaCount <= 0) continue;
      movedTiers += 1;
      if (movedTiers > 1) return { kind: "ambiguous" };
      // Ledger amounts are sums of per-request prices (multiples of 0.1);
      // round away float noise from the division.
      rate = Math.round(((now[k].amount - (base[k]?.amount ?? 0)) / deltaCount) * 100) / 100;
    }
    if (movedTiers === 0) return { kind: "none" };
    return { kind: "rate", rate };
  };

  const render = (ctx: { model?: { id: string } | undefined }, setStatus: (t: string | undefined) => void) => {
    if (!cachedBalanceText) return;
    const rate = ctx.model ? learnedRates[ctx.model.id] : undefined;
    setStatus(rate !== undefined ? `${cachedBalanceText} · ${rate}/req` : cachedBalanceText);
  };

  const refresh = async (apiKey: string): Promise<void> => {
    // Propagate an in-flight fetch so callers render its (fresher) result
    // instead of the stale cache. A failed in-flight fetch leaves fetchedAt
    // untouched, so falling through retries on the next call.
    if (inFlight) await inFlight;
    if (Date.now() - fetchedAt < REFRESH_MS) return;
    inFlight = (async () => {
      try {
        const res = await fetch(BALANCE_URL, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          success: boolean;
          data?: { total_balance: number; available_balance: number; frozen_amount: number };
        };
        if (!body.success || !body.data) return;
        const { total_balance: total, available_balance: avail, frozen_amount: frozen } = body.data;
        cachedBalanceText =
          frozen > 0
            ? `Magicubes: ${avail.toLocaleString("en-US")} available / ${total.toLocaleString("en-US")} total (${frozen.toLocaleString("en-US")} frozen)`
            : `Magicubes: ${avail.toLocaleString("en-US")} available`;
        fetchedAt = Date.now();
      } catch {
        // Network/API failure: keep showing the last known balance.
      } finally {
        inFlight = undefined;
      }
    })();
    await inFlight;
  };

  /** A ModelScope model became active: show the balance and prep derivation. */
  const activate = async (
    ctx: {
      model?: { id: string; provider: string } | undefined;
      modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
      ui: { setStatus(key: string, text: string | undefined): void };
    },
    modelId: string,
  ): Promise<void> => {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("modelscope");
    if (!apiKey) return;
    const setStatus = (text: string | undefined) => ctx.ui.setStatus(STATUS_KEY, text);

    await refresh(apiKey);
    // Snapshot the ledger before this model's next spend so the post-response
    // diff attributes only its own deductions.
    if (!(modelId in learnedRates) && baseline?.modelId !== modelId) {
      baseline = { modelId, tx: await fetchTx(apiKey) };
      learnAttempts = 0;
    }
    render(ctx, setStatus);
  };

  /** After a response, diff the ledger once (bounded attempts) to learn the rate. */
  const onResponse = async (
    ctx: {
      model?: { id: string; provider: string } | undefined;
      modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
      ui: { setStatus(key: string, text: string | undefined): void };
    },
    modelId: string,
  ): Promise<void> => {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("modelscope");
    if (!apiKey) return;
    const setStatus = (text: string | undefined) => ctx.ui.setStatus(STATUS_KEY, text);

    await refresh(apiKey);
    if (!(modelId in learnedRates) && baseline?.modelId === modelId && learnAttempts < MAX_LEARN_ATTEMPTS) {
      learnAttempts += 1;
      const now = await fetchTx(apiKey);
      const result = deriveRate(baseline.tx, now);
      if (result.kind === "rate") {
        learnedRates[modelId] = result.rate;
        baseline = undefined;
      } else if (result.kind === "ambiguous") {
        // A foreign spend on another tier poisons any cumulative diff against
        // this baseline; re-baseline so the next window can be clean.
        baseline = learnAttempts >= MAX_LEARN_ATTEMPTS ? undefined : { modelId, tx: now };
      }
      // "none": keep the baseline — the spend is probably unconfirmed yet and
      // the next diff is cumulative, so lag resolves itself.
    }
    render(ctx, setStatus);
  };

  // Handlers return their promises so the runtime can await them where it
  // matters (e.g. baseline before first spend).

  // Show only when a ModelScope model is already active at session open; clear
  // otherwise (in-process session switches can carry a stale status over).
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model?.provider !== "modelscope") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    return activate(ctx, ctx.model.id);
  });

  // Visibility follows the selected model: clear for non-ModelScope models.
  pi.on("model_select", (event, ctx) => {
    if (event.model.provider !== "modelscope") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    return activate(ctx, event.model.id);
  });

  // Model switches detected before the request: snapshot before the selected
  // model's first spend (covers paths that skip model_select).
  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.model?.provider !== "modelscope") return;
    return activate(ctx, ctx.model.id);
  });

  // Refresh after each ModelScope response — that's when magicubes were spent,
  // and where a still-unknown rate gets derived (once, bounded).
  pi.on("after_provider_response", (_event, ctx) => {
    if (ctx.model?.provider !== "modelscope") return;
    return onResponse(ctx, ctx.model.id);
  });
}
