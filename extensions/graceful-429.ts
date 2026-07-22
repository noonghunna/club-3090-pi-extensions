import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * graceful-429 — make provider rate-limiting (HTTP 429) visible instead of scary.
 *
 * pi already retries transient errors automatically (settings.json `retry.*`:
 * retry.enabled, retry.maxRetries, retry.baseDelayMs, retry.provider.maxRetryDelayMs).
 * This extension does NOT change that — it surfaces it: when a 429 lands it shows a
 * live countdown in the footer statusline plus a one-time notification, and clears
 * it when the retry succeeds. A throttled turn reads as "waiting on the rate limit"
 * rather than "hung."
 *
 * DETECTION (important): we hook `message_end` and match an assistant message whose
 * `errorMessage` carries a 429 / rate-limit signature. This is the reliable hook.
 * `after_provider_response` does NOT fire on 429 for OpenAI-SDK-based providers
 * (dashscope, openai, openrouter, …): the OpenAI SDK throws an APIError on a non-2xx
 * response *before* pi's onResponse callback runs (see pi-ai api/openai-completions.js
 * — onResponse is awaited only after `.withResponse()` resolves), so the 429 surfaces
 * solely as the assistant message's errorMessage. We still listen to
 * after_provider_response opportunistically to capture an accurate Retry-After on the
 * raw-fetch providers whose transport DOES surface it (pi-messages / anthropic).
 *
 * Countdown delay = captured Retry-After when available, else an estimate of pi's
 * exponential backoff (retry.baseDelayMs, default → 2/4/8/16/32s).
 *
 * Generic — fires on any provider's 429.
 */
export default function (pi: ExtensionAPI) {
  const STATUS_KEY = "graceful-429";
  const RATE_LIMIT_RE = /429|rate.?limit|too many requests|quota/i;

  let ctxRef: ExtensionContext | undefined; // latest ctx, for the timer callback
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let rateLimitCount = 0; // total 429s this session (for the counter)
  let active = false; // currently showing a rate-limit indicator
  let pendingRetryAfter: number | undefined; // accurate Retry-After when a transport surfaced it

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
  }

  function clearIndicator() {
    clearCountdown();
    if (active) {
      active = false;
      ctxRef?.ui.setStatus(STATUS_KEY, "");
    }
  }

  function showRateLimited(waitSec: number) {
    rateLimitCount += 1;
    active = true;
    let remaining = Math.max(1, Math.ceil(waitSec));

    const render = () =>
      ctxRef?.ui.setStatus(
        STATUS_KEY,
        `⏳ rate-limited (429) — retrying in ~${remaining}s · #${rateLimitCount} this session`,
      );

    render();
    clearCountdown();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        // pi should be retrying about now; hold a "retrying…" note until the next
        // message (success or final failure) clears it.
        clearCountdown();
        ctxRef?.ui.setStatus(
          STATUS_KEY,
          `⏳ rate-limited (429) — retrying… · #${rateLimitCount} this session`,
        );
      } else {
        render();
      }
    }, 1000);
  }

  // Opportunistic: capture an accurate Retry-After on providers that surface the 429
  // as an HTTP response. (The OpenAI-SDK path never reaches here on a 429 — it throws
  // first — so for those this simply stays undefined and we estimate instead.)
  pi.on("after_provider_response", (event, ctx) => {
    ctxRef = ctx;
    if (event.status === 429) {
      const raw = event.headers["retry-after"];
      const raSec = raw ? parseFloat(raw) : NaN;
      if (Number.isFinite(raSec) && raSec > 0) pendingRetryAfter = raSec;
    }
  });

  // Primary detection: the 429 surfaces as the assistant message's errorMessage.
  pi.on("message_end", (event, ctx) => {
    ctxRef = ctx;
    const msg = event.message as { role?: string; errorMessage?: string };
    if (msg.role !== "assistant") return;

    if (msg.errorMessage && RATE_LIMIT_RE.test(msg.errorMessage)) {
      const waitSec = pendingRetryAfter ?? 2 ** Math.min(rateLimitCount + 1, 5);
      pendingRetryAfter = undefined;
      // Alert once per rate-limit burst (not on every retry within it).
      if (!active) {
        ctx.ui.notify(
          `Rate limited (429) — pi will retry automatically in ~${Math.ceil(waitSec)}s`,
          "info",
        );
      }
      showRateLimited(waitSec);
    } else if (!msg.errorMessage) {
      // A clean assistant message means the rate-limit wait resolved → clear.
      clearIndicator();
    }
  });

  // Safety net: when the run fully settles (success or retries exhausted), never
  // leave a stale countdown in the footer.
  pi.on("agent_settled", (_event, ctx) => {
    ctxRef = ctx;
    clearIndicator();
  });

  pi.on("session_shutdown", () => {
    clearCountdown();
  });
}
