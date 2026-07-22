import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("after_provider_response", (event, ctx) => {
    // Check if we're using a Qwen Ambassador model
    const modelId = ctx.model?.id;
    if (!modelId || !modelId.startsWith("Qwen-Ambassador/")) {
      return;
    }

    // Extract the ModelScope ratelimit headers
    // Headers are normalized to lowercase by pi's headersToRecord
    const remaining = event.headers["modelscope-ratelimit-model-month-requests-remaining"];
    const limit = event.headers["modelscope-ratelimit-model-month-requests-limit"];

    if (remaining && limit) {
      const remainingNum = parseInt(remaining, 10);
      const limitNum = parseInt(limit, 10);
      
      // Calculate percentage used
      const usedPercent = ((limitNum - remainingNum) / limitNum) * 100;
      
      // Update statusline with quota info
      ctx.ui.setStatus(
        "qwen-quota",
        `Qwen quota: ${remainingNum.toLocaleString()}/${limitNum.toLocaleString()} remaining (${usedPercent.toFixed(1)}% used)`
      );
    }
  });
}
