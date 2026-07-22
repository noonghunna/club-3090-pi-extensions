# Never Lose Track of Your Qwen Ambassador Quota Again — a Live Usage Meter Inside Your Coding Agent

*If you're a [Qwen Ambassador](https://modelscope.cn) with complimentary ModelScope access to Qwen's flagship models, you've probably hit this: you're deep in a coding session, the model is flying, and suddenly — silence. You've burned through your monthly request quota and didn't see it coming.*

This guide shows you how to put a **live quota meter** right in the footer of [pi](https://pi.dev) — a fast, extensible AI coding agent — so you always know exactly how much of your Qwen Ambassador allowance is left, without ever leaving your terminal.

```
⏳ Qwen quota: 1,847/2,000 remaining (7.7% used)
```

That single line, always visible as you work. Let's build it.

---

## What you'll need

1. **pi**, the coding agent (`npm i -g @earendil-works/pi-coding-agent` — see [pi.dev](https://pi.dev) for the latest).
2. **Your Qwen Ambassador ModelScope API key** — the one from your Ambassador dashboard that grants access to the `Qwen-Ambassador/*` models.
3. About **five minutes**.

Everything else is two small extension files. pi extensions are just TypeScript modules dropped into `~/.pi/agent/extensions/` — no build step, pi loads them on startup (or `/reload`).

---

## Meet your two models

Your Ambassador access currently includes **two Qwen 3.7 models** on ModelScope, and this guide sets up both:

| Model | Best for | Character |
|---|---|---|
| **Qwen3.7-Max** | Hard reasoning, complex agentic work, gnarly bugs | The flagship — deepest thinking, highest quality |
| **Qwen3.7-Plus** | Everyday coding, refactors, quick questions | The balanced tier — fast and highly capable |

Both share a 262K-token context window and full reasoning support. The provider extension in Step 1 registers them together, so you can flip between them anytime with `Ctrl+P`. A good rhythm: cruise on **Plus** for routine work, and shift up to **Max** when a task needs the heavy reasoning.

---

## Step 1 — Register the Qwen Ambassador models in pi

pi doesn't ship the ModelScope endpoint out of the box, so we tell it about the `Qwen-Ambassador` models with a tiny provider extension. Create `~/.pi/agent/extensions/qwen-ambassador.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("modelscope", {
    name: "ModelScope (Qwen Ambassador)",
    baseUrl: "https://api-inference.modelscope.ai/v1",
    apiKey: "$MODELSCOPE_API_KEY",          // resolved from your environment
    api: "openai-completions",              // ModelScope speaks OpenAI-compatible
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: "qwen",              // parse Qwen reasoning into the right channel
    },
    models: [
      {
        id: "Qwen-Ambassador/Qwen3.7-Max",
        name: "Qwen3.7-Max (Qwen Ambassador)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "Qwen-Ambassador/Qwen3.7-Plus",
        name: "Qwen3.7-Plus (Qwen Ambassador)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
    ],
  });
}
```

Then export your key (add it to your shell profile so it persists):

```bash
export MODELSCOPE_API_KEY="ms-…your-ambassador-key…"
```

> **Where do I get the key?** Your Qwen Ambassador benefits include ModelScope inference access — grab the API key from your ModelScope / Ambassador dashboard. The `Qwen-Ambassador/Qwen3.7-Max` and `-Plus` IDs are the complimentary Ambassador models; the meter works with any model served under that `Qwen-Ambassador/` prefix.

Restart pi (or `/reload`) and **both** models appear in your model picker (`Ctrl+P`): *Qwen3.7-Max (Qwen Ambassador)* and *Qwen3.7-Plus (Qwen Ambassador)*. Pick either one and you're chatting with Qwen through pi.

---

## Step 2 — Install the quota meter

Now the fun part. Create `~/.pi/agent/extensions/qwen-quota.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("after_provider_response", (event, ctx) => {
    // Only act on Qwen Ambassador models
    const modelId = ctx.model?.id;
    if (!modelId || !modelId.startsWith("Qwen-Ambassador/")) return;

    // ModelScope returns your monthly quota in response headers
    // (pi normalizes header names to lowercase)
    const remaining = event.headers["modelscope-ratelimit-model-month-requests-remaining"];
    const limit = event.headers["modelscope-ratelimit-model-month-requests-limit"];

    if (remaining && limit) {
      const remainingNum = parseInt(remaining, 10);
      const limitNum = parseInt(limit, 10);
      const usedPercent = ((limitNum - remainingNum) / limitNum) * 100;

      ctx.ui.setStatus(
        "qwen-quota",
        `Qwen quota: ${remainingNum.toLocaleString()}/${limitNum.toLocaleString()} remaining (${usedPercent.toFixed(1)}% used)`,
      );
    }
  });
}
```

`/reload`, send any message, and look at the bottom of your terminal:

```
Qwen quota: 1,847/2,000 remaining (7.7% used)
```

It updates on **every response**, so the number ticks down in real time as you work. No dashboards, no context-switching — just glance down.

---

## How it works

Every response from ModelScope's inference API carries two headers describing your monthly budget:

| Header | Meaning |
|---|---|
| `modelscope-ratelimit-model-month-requests-limit` | Your total monthly request allowance |
| `modelscope-ratelimit-model-month-requests-remaining` | How many requests you have left |

The extension simply reads them after each response and renders the ratio in pi's footer statusline. It's a no-op for any non-Ambassador model, so it's safe to leave installed alongside everything else.

> **One meter, both models.** The meter reads these headers from *each response*, so it always reflects the budget of the model you're actively using — chat with **Max** and you see Max's remaining allowance; switch to **Plus** and it shows Plus's. No extra configuration; it follows your selected model automatically.

---

## Bonus — handle rate limits gracefully

Quota isn't the only limit — ModelScope also enforces *per-minute* rate limits, and a busy session can trip a `429`. pi already retries those automatically, but the wait can look like a hang. A companion extension, `graceful-429`, turns it into a visible countdown:

```
⏳ rate-limited (429) — retrying in ~8s · #2 this session
```

Both extensions live in the [`club-3090-pi-extensions`](https://github.com/noonghunna/club-3090-pi-extensions) repo, so you can install them in one shot:

```bash
pi install git:github.com/noonghunna/club-3090-pi-extensions
```

That gives you `qwen-quota`, `graceful-429`, and a couple of other tools (`zellij_job` for observable long-running commands, `mux-transcript` for a live shell mirror). If you only want the quota meter, the single file above is all you need.

---

## Wrapping up

Three small files — a provider, a quota meter, and (optionally) a rate-limit handler — and your Qwen Ambassador usage is always one glance away. No more surprise quota exhaustion mid-flow; just a quiet number in the corner that tells you when to ease off (or when you've got plenty of runway to keep building).

Happy coding — and may your remaining quota always stay comfortably above zero. 🚀

---

*Built with [pi](https://pi.dev) and the [club-3090-pi-extensions](https://github.com/noonghunna/club-3090-pi-extensions) collection. Qwen and ModelScope are products of Alibaba Cloud; the Qwen Ambassador program provides complimentary model access — thanks to the [@Qwen](https://huggingface.co/Qwen) team for the models.*
