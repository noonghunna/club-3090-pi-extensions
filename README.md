# pi-omp-extensions

A **standalone statusline extension** for [pi](https://pi.dev) and
[oh-my-pi (omp)](https://github.com/earendil-works/pi-mono) coding agents that
shows your **ModelScope magicube balance** — the account-level credit that
ModelScope's api-inference now bills per request (the old per-model monthly
request quotas and their `modelscope-ratelimit-*` headers are deprecated) —
plus the **per-request rate of the model you're using**, derived from your own
observed deductions:

```
Magicubes: 6,242 available · 0.2/req
```

Works with **Qwen Ambassador** models (`Qwen-Ambassador/*`) and any other
ModelScope api-inference model (e.g. `deepseek-ai/DeepSeek-V4-Pro-0813`).

---

## Install

The package installs **only the `qwen-quota` extension** — nothing else is
bundled. (A few optional extras live in [`extras/`](#extras-opt-in) and are
never installed automatically.)

### pi

```bash
pi install git:github.com/noonghunna/pi-omp-extensions
```

or manually:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/qwen-quota/pi/qwen-quota.ts ~/.pi/agent/extensions/
```

### omp

```bash
mkdir -p ~/.omp/agent/extensions
cp extensions/qwen-quota/omp/qwen-quota.ts ~/.omp/agent/extensions/
```

### Both at once

```bash
./install.sh          # adds --extras to also install the optional pi extensions
```

Then restart the agent (or `/reload`).

---

## Setup: the ModelScope (Qwen Ambassador) provider

The extension reads your ModelScope API token from the configured
`modelscope` provider — it never asks for or hardcodes the key itself.

1. **Get a token**: [modelscope.cn](https://modelscope.cn) → account →
   *Access Tokens* → create/copy an `ms-…` token. Qwen Ambassador access to
   the `Qwen-Ambassador/*` models rides on this same token.
2. **Export it** (recommended): `export MODELSCOPE_API_KEY=ms-…`

### omp — `~/.omp/agent/models.yml`

```yaml
providers:
  modelscope:
    baseUrl: https://api-inference.modelscope.ai/v1
    api: openai-completions
    apiKey: $MODELSCOPE_API_KEY        # or paste the ms-… literal
    compat:
      supportsDeveloperRole: false
      supportsReasoningEffort: true
      thinkingFormat: qwen
      qwenTemplateReasoningEffort: false
    models:
      - id: Qwen-Ambassador/Qwen3.7-Max
        name: Qwen3.7-Max (ModelScope)
        contextWindow: 262144
        maxTokens: 65536
        reasoning: true
        supportsTools: true
        thinkingLevelMap:
          off: null
          minimal: low
          low: low
          medium: medium
          high: high
          xhigh: high
      # …repeat per model. Any id from https://api-inference.modelscope.ai/v1/models works, e.g.:
      - id: deepseek-ai/DeepSeek-V4-Pro-0813
        name: DeepSeek-V4-Pro-0813 (ModelScope)
        contextWindow: 1048576
        maxTokens: 393216
        reasoning: true
        supportsTools: true
        thinkingLevelMap:
          off: null
          minimal: low
          low: low
          medium: medium
          high: high
          xhigh: high
```

### pi — `~/.pi/agent/models.json`

```json
{
  "providers": {
    "modelscope": {
      "baseUrl": "https://api-inference.modelscope.ai/v1",
      "api": "openai-completions",
      "apiKey": "$MODELSCOPE_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "thinkingFormat": "qwen"
      },
      "models": [
        {
          "id": "Qwen-Ambassador/Qwen3.7-Max",
          "name": "Qwen3.7-Max (ModelScope)",
          "contextWindow": 262144,
          "maxTokens": 65536,
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "low",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "high"
          }
        }
      ]
    }
  }
}
```

> **Tip (pi):** if another configured provider (huggingface, nvidia, …) also
> carries the same model id, a bare `--model <id>` is ambiguous — use the
> qualified form: `--model modelscope/deepseek-ai/DeepSeek-V4-Pro-0813`.

The `compat` block matters: `thinkingFormat: qwen` sends the DashScope-style
top-level `enable_thinking` switch (with `off` actually disabling thinking),
and `supportsReasoningEffort` forwards `reasoning_effort`. Both are accepted by
ModelScope's gateway for Qwen and DeepSeek models.

---

## What you get

| State | Statusline |
|---|---|
| ModelScope model selected, balance known | `Magicubes: 6,242 available` |
| Mid-spend (some credits frozen) | `Magicubes: 6,247.4 available / 6,247.6 total (0.2 frozen)` |
| Rate derived for the selected model | `Magicubes: 6,242 available · 0.2/req` |
| Non-ModelScope model selected | *(status entry cleared)* |

Behavior:

- **Balance** is fetched from `/openapi/v1/magicubes/balance` when a
  ModelScope model becomes active and refreshed after each ModelScope response
  (throttled to one call / 15 s). On API errors the last known value stays on
  screen.
- **Rate is derived from your own deductions.** ModelScope publishes tier
  prices but **no model→tier mapping** anywhere (models list, response
  headers, and the rates API are all tier-only). So the extension snapshots
  the transactions ledger (`/openapi/v1/magicubes/transactions`) when a model
  is selected, diffs it after the model's first response, and if exactly one
  tier moved, the rate is `Δamount / Δcount` — the *actually applied* price.
  It is derived **once per model selection**, cached until you switch models,
  and never re-derived every turn.
  - If several tiers moved in the same window (another session sharing your
    token spent elsewhere), the window is poisoned; the extension re-baselines
    and retries on the next response, giving up after two attempts rather than
    showing a wrong number.
  - Confirmation lag: a just-finished request may not be in the ledger yet;
    the retry on the next response resolves that.
- The rate cache is in-memory (per agent process) and deliberately not
  persisted — ModelScope can reprice tiers, and re-derivation costs at most
  two small ledger reads.

### Magicube pricing (api_inference, per request)

| Tier | Price |
|---|---|
| discount | 0.2 |
| lite | 0.5 |
| standard | 1 |
| ultra | 2 |

Observed mapping (derived with this extension; can change without notice):
`Qwen-Ambassador/Qwen3.7-Plus` → discount, `Qwen-Ambassador/Qwen3.8-Max` →
lite. Your balance and rate are always *your* numbers — the
`/openapi/v1/magicubes/{balance,transactions,spend/rates}` endpoints accept
the same `Authorization: Bearer <token>` as the inference API.

---

## Extras (opt-in, pi only)

Not installed by the package — copy what you want manually:

```bash
cp extras/<name>.ts ~/.pi/agent/extensions/
```

| Extension | What it does |
|---|---|
| `graceful-429.ts` | Live "retrying in ~Ns · #N" statusline countdown when a provider returns HTTP 429 (surfaces pi's built-in retry; changes nothing). |
| `mux-transcript.ts` | Mirrors every bash tool call + output into a persistent zellij/tmux pane beside the conversation (read-only). |
| `zellij-job.ts` | The `zellij_job` tool: run long/interactive commands in visible zellij panes you can `tail`/`wait`/`send`/`interrupt` — a port of [pi-tmux-job](https://github.com/kevinb361/pi-tmux-job) (MIT). |
| `thinking-level-status.ts` | Shows the current thinking level (e.g. `thinking: high`) in the statusline. |

## Requirements

- pi (`@earendil-works/pi-coding-agent`) **or** oh-my-pi (`omp`), recent
  versions (extension API with `modelRegistry` + `model_select`)
- A ModelScope account + API token; `Qwen-Ambassador/*` access for the
  Ambassador models

## Adding your own extensions

1. Drop a `.ts` file exporting `default function (pi: ExtensionAPI) { … }`
   into the agent's `extensions/` directory (or into
   `extensions/qwen-quota/{pi,omp}` here if it belongs to the package).
2. For packaged pi extensions, add the path to `pi.extensions` in
   `package.json` and document it.

## License

MIT — see [LICENSE](./LICENSE). `extras/zellij-job.ts` is a port of
`kevinb361/pi-tmux-job` (Copyright (c) 2026 Kevin Blalock, MIT).
