import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * graceful-429 — make provider rate-limiting (HTTP 429) visible instead of scary.
 *
 * pi already retries transient errors automatically (settings.json `retry.*`:
 * retry.enabled, retry.maxRetries, retry.baseDelayMs). This extension does NOT
 * change that — it surfaces it in the footer statusline as a live
 * "retrying… · attempt N" indicator that increments on every retry, plus a
 * one-time notification and a brief "✓ cleared after N retries" on recovery.
 *
 * COUNTING RETRIES — use `agent_end`, not `message_end`:
 * pi's retry is at the AGENT-SESSION level (retry.maxRetries). Each retry is a
 * fresh agent run, so `agent_end` fires once per attempt and its `messages`
 * carry the failed assistant message (with the 429 `errorMessage`). `message_end`
 * does NOT reliably re-fire for each internal retry, so counting it leaves the
 * indicator stuck at "attempt 1". Counting `agent_end` runs that end in a 429
 * increments correctly on every retry.
 *
 * For OpenAI-SDK providers (dashscope, openai, openrouter, …) there's no
 * Retry-After to read (the SDK throws an APIError on the non-2xx response before
 * pi's onResponse runs), so we show the attempt count; where a transport DOES
 * surface Retry-After (raw-fetch providers, via after_provider_response) we show
 * a real countdown instead.
 *
 * QUOTA vs THROTTLE — the distinction that matters (fixed 2026-07-29):
 * pi only retries TRANSIENT errors. Its classifier (pi-ai `retry.js`
 * `isRetryableAssistantError`) checks a NON-RETRYABLE quota/billing pattern FIRST
 * (`insufficient_quota`, `quota exceeded`, `out of budget`, `billing`, usage-limit
 * wording) and fails fast on those — no backoff, no retry. Only if that misses does
 * it treat `429`/`rate limit`/`overloaded`/5xx as retryable. The first version of
 * this extension lumped `quota` in with the retryable pattern, so for a dashscope
 * `insufficient_quota` 429 it showed "pi retrying… attempt N" while pi had actually
 * given up — a misleading "retrying" state that read as a stall. We now mirror pi's
 * precedence: quota/billing exhaustion → "⛔ quota exhausted — pi will NOT retry";
 * transient throttle → "⏳ retrying… attempt N". (`auto_retry_start`/`_end` would be
 * the authoritative signal but are NOT exposed to extensions, and `agent_end` carries
 * no `willRetry`, so we replicate the classifier.)
 */
export default function (pi: ExtensionAPI) {
  const STATUS_KEY = "graceful-429";
  // Transient throttles pi WILL retry. NOTE: no `quota` here — quota/billing
  // exhaustion is non-retryable and lives in NON_RETRYABLE_RE below.
  const RATE_LIMIT_RE = /429|rate.?limit|too many requests|overloaded|503|529/i;
  // Mirror of pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN — checked FIRST,
  // exactly like pi does. These fail fast (pi does NOT retry), so we must never
  // label them "retrying".
  const NON_RETRYABLE_RE =
    /insufficient_quota|quota exceeded|out of budget|billing|usage limit|available balance|GoUsageLimitError|FreeUsageLimitError/i;

  let ctxRef: ExtensionContext | undefined; // latest ctx, for timer callbacks
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  let burstCount = 0; // 429 attempts in the current rate-limit burst
  let active = false; // currently showing a rate-limit indicator
  let pendingRetryAfter: number | undefined; // accurate Retry-After when a transport surfaced it

  function clearTimers() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  }

  function clearIndicator() {
    clearTimers();
    if (active) {
      active = false;
      ctxRef?.ui.setStatus(STATUS_KEY, "");
    }
  }

  // pi got through: brief positive feedback, then clear.
  function showRecovered(retries: number) {
    if (!active) return;
    clearTimers();
    ctxRef?.ui.setStatus(
      STATUS_KEY,
      `✓ rate limit cleared${retries > 1 ? ` after ${retries} retries` : ""}`,
    );
    clearTimer = setTimeout(() => {
      active = false;
      ctxRef?.ui.setStatus(STATUS_KEY, "");
    }, 4000);
  }

  function showRateLimited(waitSec: number | undefined, attempt: number) {
    active = true;
    clearTimers();

    if (waitSec !== undefined && Number.isFinite(waitSec) && waitSec > 0) {
      // Real Retry-After from the server: a live countdown to the next window is
      // meaningful here (each 429 carries a fresh Retry-After, so resetting is ok).
      let remaining = Math.max(1, Math.ceil(waitSec));
      const render = () =>
        ctxRef?.ui.setStatus(
          STATUS_KEY,
          `⏳ rate-limited (429) — retry in ~${remaining}s · attempt ${attempt}`,
        );
      render();
      countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearTimers();
          ctxRef?.ui.setStatus(STATUS_KEY, `⏳ rate-limited (429) — retrying… · attempt ${attempt}`);
        } else {
          render();
        }
      }, 1000);
    } else {
      // No reliable Retry-After (e.g. dashscope / OpenAI-SDK). Don't fake a timer —
      // show the attempt count, which increments on every retry.
      ctxRef?.ui.setStatus(STATUS_KEY, `⏳ rate-limited (429) — pi retrying… · attempt ${attempt}`);
    }
  }

  // Classify how an agent run ended: a non-retryable quota/billing exhaustion,
  // a transient throttle pi will retry, or neither. Quota is checked FIRST to
  // match pi's own precedence (a message can contain both "429" and
  // "insufficient_quota" — dashscope's does — and quota must win).
  function classifyEnd(messages: unknown[]): "quota" | "transient" | null {
    for (const m of messages) {
      const msg = m as { role?: string; errorMessage?: string };
      if (msg.role !== "assistant" || !msg.errorMessage) continue;
      if (NON_RETRYABLE_RE.test(msg.errorMessage)) return "quota";
      if (RATE_LIMIT_RE.test(msg.errorMessage)) return "transient";
    }
    return null;
  }

  // Quota/billing exhaustion: pi has given up (fail-fast). Say so plainly instead
  // of faking a retry countdown. Left up until agent_settled clears it.
  function showQuotaExhausted() {
    clearTimers();
    active = true;
    ctxRef?.ui.setStatus(
      STATUS_KEY,
      "⛔ quota exhausted (429) — pi will NOT retry · increase provider quota",
    );
    ctxRef?.ui.notify(
      "Quota exhausted (429) — pi will not retry this. Increase your provider quota or wait for the limit to reset.",
      "warning",
    );
  }

  // Opportunistic: capture an accurate Retry-After on providers that surface the
  // 429 as an HTTP response. (The OpenAI-SDK path never reaches here on a 429 — it
  // throws first — so for those this stays undefined and we show attempt count.)
  pi.on("after_provider_response", (event, ctx) => {
    ctxRef = ctx;
    if (event.status === 429) {
      const raw = event.headers["retry-after"];
      const raSec = raw ? parseFloat(raw) : NaN;
      if (Number.isFinite(raSec) && raSec > 0) pendingRetryAfter = raSec;
    }
  });

  // Primary: count retries via agent_end (fires once per agent run / retry attempt).
  pi.on("agent_end", (event, ctx) => {
    ctxRef = ctx;
    const kind = classifyEnd(event.messages);
    if (kind === "quota") {
      // Non-retryable: pi fails fast. Never show "retrying" here.
      burstCount = 0;
      showQuotaExhausted();
    } else if (kind === "transient") {
      const waitSec = pendingRetryAfter;
      pendingRetryAfter = undefined;
      if (!active) {
        burstCount = 0; // start of a new burst
        ctx.ui.notify("Rate limited (429) — pi is retrying…", "info");
      }
      burstCount += 1;
      showRateLimited(waitSec, burstCount);
    } else if (active) {
      // A clean agent run ended → pi got through the throttle.
      showRecovered(burstCount);
    }
  });

  // Safety net: when the run fully settles (success or retries exhausted), never
  // leave a stale indicator in the footer.
  pi.on("agent_settled", (_event, ctx) => {
    ctxRef = ctx;
    clearIndicator();
  });

  pi.on("session_shutdown", () => {
    clearTimers();
  });
}
