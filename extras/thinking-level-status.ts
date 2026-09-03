import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Show thinking level in statusline when it changes
  pi.on("thinking_level_select", (event, ctx) => {
    const level = event.level;
    ctx.ui.setStatus("thinking-level", `thinking: ${level}`);
  });
}
