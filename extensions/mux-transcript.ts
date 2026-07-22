import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { appendFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * mux-transcript — mirror every pi `bash` execution into a live zellij pane.
 *
 * Keeps one persistent pane (named pi-mux-<pid>) running `tail -f` on a
 * transcript log, and appends `$ <command>` on each bash tool_call plus the
 * (truncated) output on each tool_result. Read-only mirror — commands are NOT
 * re-executed, so there are no side effects.
 *
 * Uses pi-terminal-mux when it resolves; falls back to raw `zellij action`
 * (pi runs inside zellij here, so the fallback always works).
 */
export default function (pi: ExtensionAPI) {
  const id = process.pid;
  const logFile = join(tmpdir(), `pi-mux-transcript-${id}.log`);
  const paneName = `pi-mux-${id}`;
  let paneStarted = false;
  let surface: any = null;
  let mux: any = null;
  let paneId: string | undefined; // zellij pane id of OUR mirror pane

  async function ensurePane() {
    if (paneStarted) return;
    paneStarted = true;
    try {
      await writeFile(logFile, `═══ pi bash transcript · pid ${id} · ${new Date().toLocaleTimeString()} ═══\n`);
      // Prefer pi-terminal-mux (honors the install); fall back to raw zellij.
      try {
        mux = await import("pi-terminal-mux");
        if (mux?.isMuxAvailable?.()) {
          surface = mux.createSurface(paneName);
          mux.sendCommand(surface, `tail -f --retry "${logFile}"`);
          return;
        }
      } catch {
        /* pi-terminal-mux not resolvable from this extension — use zellij */
      }
      const out = execSync(
        `zellij action new-pane --name "${paneName}" -- bash -c 'tail -f --retry "${logFile}"'`,
        { stdio: ["ignore", "pipe", "ignore"] },
      ).toString();
      // new-pane prints the created pane id (e.g. "terminal_28"); remember it so
      // cleanup closes THIS pane, not whatever pane happens to be focused.
      paneId = (out.trim().match(/terminal_\d+|plugin_\d+|\d+/) ?? [])[0];
    } catch {
      /* pane creation failed — transcript disabled, pi keeps working normally */
    }
  }

  async function log(line: string) {
    try {
      await appendFile(logFile, line + "\n");
    } catch {
      /* best effort */
    }
  }

  function truncate(s: string, n = 2500): string {
    if (!s) return "";
    return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
  }

  // Before each bash command runs: show it in the pane.
  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event)) {
      await ensurePane();
      const cmd = (event.input.command ?? "").trim();
      await log(`\n\x1b[36m$ ${truncate(cmd, 1000)}\x1b[0m`);
    }
  });

  // After it finishes: show the (truncated) output + exit status.
  pi.on("tool_result", async (event) => {
    if (isBashToolResult(event)) {
      const text = (event.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      const tag = event.isError ? "\x1b[31m[exit≠0]\x1b[0m " : "";
      await log(`${tag}\x1b[33m${truncate(text)}\x1b[0m`);
    }
  });

  // Clean up the pane + log on shutdown.
  pi.on("session_shutdown", async () => {
    try {
      if (surface && mux?.closeSurface) {
        mux.closeSurface(surface);
      } else if (paneId) {
        // Close OUR mirror pane by id. A bare `close-pane` closes the *focused*
        // pane, which on /resume //reload //new/quit was killing pi's own pane
        // (or whichever pane the user was looking at) instead of the transcript.
        execSync(`zellij action close-pane --pane-id ${paneId} 2>/dev/null || true`, { stdio: "ignore" });
      }
      // No paneId (capture failed) -> deliberately do nothing: leaking a harmless
      // `tail -f` pane is far better than closing an unrelated focused pane.
    } catch {
      /* best effort */
    }
  });
}
