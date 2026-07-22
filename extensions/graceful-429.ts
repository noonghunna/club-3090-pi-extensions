import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * graceful-429 — make provider rate-limiting (HTTP 429) visible instead of scary.
 *
 * pi already retries transient errors automatically (settings.json `retry.*`).
 * This extension does NOT change that — it surfaces it in the footer statusline:
 * a live "retrying · attempt N" indicator while pi is throttled, plus a one-time
 * notification, and a brief "✓ cleared after N retries" when pi gets through.
 *
 * WHY NO FAKE COUNTDOWN: an earlier version estimated pi's backoff and ticked a
 * countdown, but every 429 re-fires `message_end` and reset it — so it sat at a
 * static "~4s" the whole time pi was retrying. For OpenAI-SDK providers
 * (dashscope, openai, openrouter, …) there's also no Retry-After to read, because
 * the SDK throws an APIError on the non-2xx response *before* pi's onResponse
 * runs. So we only show a real countdown when a transport actually surfaces
 * Retry-After (raw-fetch providers); otherwise we show the live attempt count,
 * which genuinely progresses instead of pretending to a timer we don't have.
 *
 * Detection hooks `message_end` and matches an assistant message whose
 * `errorMessage` carries a 429 / rate-limit signature (the reliable hook for all
 * providers). `after_provider_response` is used only to opportunistically capture
 * an accurate Retry-After where the transport surfaces it.
 */
export default function (pi: ExtensionAPI) {
  const STATUS_KEY = "graceful-429";
  const RATE_LIMIT_RE = /429|rate.?limit|too many requests|quota/i;

  let ctxRef: ExtensionContext | undefined; // latest ctx, for timer callbacks
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  let burstCount = 0; // 429s in the current rate-limit burst
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
      // No reliable Retry-After (e.g. dashscope / OpenAI-SDK). Don't fake a timer
      // that just resets on every 429 — show the attempt count, which actually
      // progresses as pi retries.
      ctxRef?.ui.setStatus(STATUS_KEY, `⏳ rate-limited (429) — pi retrying… · attempt ${attempt}`);
    }
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

  // Primary detection: the 429 surfaces as the assistant message's errorMessage.
  pi.on("message_end", (event, ctx) => {
    ctxRef = ctx;
    const msg = event.message as { role?: string; errorMessage?: string };
    if (msg.role !== "assistant") return;

    if (msg.errorMessage && RATE_LIMIT_RE.test(msg.errorMessage)) {
      const waitSec = pendingRetryAfter;
      pendingRetryAfter = undefined;
      if (!active) {
        burstCount = 0; // start of a new burst
        ctx.ui.notify("Rate limited (429) — pi will retry automatically", "info");
      }
      burstCount += 1;
      showRateLimited(waitSec, burstCount);
    } else if (!msg.errorMessage && active) {
      // A clean assistant message means pi got through the throttle.
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
