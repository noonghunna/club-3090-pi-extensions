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
 */
export default function (pi: ExtensionAPI) {
  const STATUS_KEY = "graceful-429";
  const RATE_LIMIT_RE = /429|rate.?limit|too many requests|quota/i;

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

  // Does this agent run end in a 429? (assistant message carrying a rate-limit error)
  function runEndedIn429(messages: unknown[]): boolean {
    return messages.some((m) => {
      const msg = m as { role?: string; errorMessage?: string };
      return msg.role === "assistant" && !!msg.errorMessage && RATE_LIMIT_RE.test(msg.errorMessage);
    });
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
    if (runEndedIn429(event.messages)) {
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
