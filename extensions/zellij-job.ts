import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * zellij_job — observable long-lived command execution in Pi-owned zellij panes.
 *
 * A zellij port of kevinb361/pi-tmux-job (MIT). Same tool shape and runner
 * design, but drives `zellij action` instead of tmux and tracks jobs in a
 * jobs.json registry (zellij has no per-pane user-options). Requires Pi to be
 * running inside zellij.
 */

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

type ExecFunction = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

interface ZellijPaneJob {
  paneId: string;
  id: string;
  name: string;
  directory: string;
  cwd: string;
  state: string;
  pid?: number;
  exitCode?: number;
  createdAt: string;
}

interface StartJobOptions {
  name: string;
  command: string;
  cwd: string;
  signal?: AbortSignal;
}

interface JobRecord {
  id: string;
  name: string;
  paneId: string;
  directory: string;
  cwd: string;
  pid?: number;
  createdAt: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function assertSafeName(value: string): void {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      "job name must start with an alphanumeric character and contain only letters, numbers, dot, underscore, colon, or dash",
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseExitCode(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  return Number.parseInt(value.trim(), 10);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function runnerScript(cwd: string, commandPath: string, logPath: string, statePath: string, exitPath: string, pidPath: string): string {
  return `#!/usr/bin/env bash
set +e

cwd=${shellQuote(cwd)}
command_file=${shellQuote(commandPath)}
log_file=${shellQuote(logPath)}
state_file=${shellQuote(statePath)}
exit_file=${shellQuote(exitPath)}
pid_file=${shellQuote(pidPath)}
interrupted=0
trap 'interrupted=1' INT

write_state() {
  local value="$1"
  local tmp="${statePath}.tmp.$$"
  printf '%s\\n' "$value" > "$tmp"
  mv -f -- "$tmp" "$state_file"
}

write_state running
rm -f -- "$exit_file"
printf '[zellij-job] started=%s cwd=%s\\n' "$(date --iso-8601=seconds)" "$cwd" | tee -a "$log_file"
cd -- "$cwd"
cd_rc=$?
if [ "$cd_rc" -ne 0 ]; then
  printf '[zellij-job] unable to enter cwd; exit=%s\\n' "$cd_rc" | tee -a "$log_file"
  printf '%s\\n' "$cd_rc" > "$exit_file"
  write_state exited
else
  shell="\${SHELL:-/bin/bash}"
  set -o pipefail
  "$shell" -lc "$(<"$command_file")" 2>&1 | tee -a "$log_file" &
  job_pid=$!
  printf '%s\\n' "$job_pid" > "$pid_file"
  wait "$job_pid"
  rc=$?
  printf '%s\\n' "$rc" > "$exit_file"
  write_state exited
  printf '[zellij-job] finished=%s exit=%s\\n' "$(date --iso-8601=seconds)" "$rc" | tee -a "$log_file"
fi

printf '\\n[zellij-job] command finished; pane left open for inspection\\n'
cd -- "$cwd" 2>/dev/null || cd -- "$HOME"
exec "\${SHELL:-/bin/bash}" -l
`;
}

class ZellijJobManager {
  private readonly rootDirectory: string;

  constructor(
    private readonly exec: ExecFunction,
    options: { rootDirectory?: string } = {},
  ) {
    this.rootDirectory =
      options.rootDirectory ?? process.env.PI_ZELLIJ_JOB_ROOT ?? resolve(homedir(), ".pi", "agent", "zellij-jobs");
  }

  private get registryPath(): string {
    return resolve(this.rootDirectory, "jobs.json");
  }

  async ensureAvailable(signal?: AbortSignal): Promise<string> {
    if (!process.env.ZELLIJ_SESSION_NAME && !process.env.ZELLIJ) {
      throw new Error("zellij_job requires Pi to be running inside zellij");
    }
    const version = await this.exec("zellij", ["--version"], { signal, timeout: 5000 });
    if (version.code !== 0) {
      throw new Error(`zellij is unavailable: ${version.stderr.trim() || version.stdout.trim()}`);
    }
    return process.env.ZELLIJ_SESSION_NAME ?? "zellij";
  }

  private async readRegistry(): Promise<JobRecord[]> {
    const raw = await readOptional(this.registryPath);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeRegistry(records: JobRecord[]): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const tmp = `${this.registryPath}.tmp.${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    // best-effort atomic replace
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.registryPath);
  }

  private async enrich(record: JobRecord): Promise<ZellijPaneJob> {
    const state = (await readOptional(resolve(record.directory, "state"))) ?? "unknown";
    const rawExit = await readOptional(resolve(record.directory, "exit-code"));
    const rawPid = await readOptional(resolve(record.directory, "pid"));
    return {
      paneId: record.paneId,
      id: record.id,
      name: record.name,
      directory: record.directory,
      cwd: record.cwd,
      state,
      pid: rawPid ? parseExitCode(rawPid) : record.pid,
      exitCode: rawExit === undefined ? undefined : parseExitCode(rawExit),
      createdAt: record.createdAt,
    };
  }

  async list(signal?: AbortSignal): Promise<ZellijPaneJob[]> {
    await this.ensureAvailable(signal);
    const records = await this.readRegistry();
    const jobs: ZellijPaneJob[] = [];
    for (const record of records) {
      jobs.push(await this.enrich(record));
    }
    return jobs;
  }

  async start(options: StartJobOptions): Promise<ZellijPaneJob> {
    assertSafeName(options.name);
    if (!options.command.trim()) throw new Error("command must not be empty");
    if (Buffer.byteLength(options.command, "utf8") > 64 * 1024) {
      throw new Error("command exceeds the 64KB zellij_job limit");
    }
    const cwd = resolve(options.cwd);
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    await this.ensureAvailable(options.signal);

    const existing = await this.readRegistry();
    if (existing.some((job) => job.name === options.name)) {
      throw new Error(`A zellij job named ${options.name} already exists; close it before reusing the name`);
    }

    const id = `${options.name}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const directory = resolve(this.rootDirectory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const commandPath = resolve(directory, "command.sh");
    const runnerPath = resolve(directory, "runner.sh");
    const logPath = resolve(directory, "output.log");
    const statePath = resolve(directory, "state");
    const exitPath = resolve(directory, "exit-code");
    const pidPath = resolve(directory, "pid");
    await writeFile(commandPath, `${options.command}\n`, { mode: 0o700 });
    await writeFile(runnerPath, runnerScript(cwd, commandPath, logPath, statePath, exitPath, pidPath), { mode: 0o700 });
    await writeFile(statePath, "launching\n", { mode: 0o600 });
    await writeFile(
      resolve(directory, "metadata.json"),
      `${JSON.stringify({ id, name: options.name, cwd, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );

    // Create a named zellij pane running the runner script. new-pane prints the
    // created pane id (format: terminal_<id>) to stdout.
    const created = await this.exec(
      "zellij",
      ["action", "new-pane", "--name", options.name, "--cwd", cwd, "--", "bash", runnerPath],
      { signal: options.signal, timeout: 10000 },
    );
    if (created.code !== 0) {
      await writeFile(statePath, "launch-failed\n", { mode: 0o600 });
      throw new Error(`Unable to create zellij pane: ${created.stderr.trim() || created.stdout.trim()}`);
    }
    const paneId = (created.stdout.trim().match(/terminal_\d+|plugin_\d+|\d+/) ?? [created.stdout.trim()])[0];
    if (!paneId) {
      await writeFile(statePath, "launch-failed\n", { mode: 0o600 });
      throw new Error(`zellij new-pane did not report a pane id: ${created.stdout.trim()}`);
    }

    const record: JobRecord = {
      id,
      name: options.name,
      paneId,
      directory,
      cwd,
      createdAt: new Date().toISOString(),
    };
    const records = await this.readRegistry();
    records.push(record);
    await this.writeRegistry(records);

    return this.enrich(record);
  }

  async resolve(target: string, signal?: AbortSignal): Promise<ZellijPaneJob | undefined> {
    const jobs = await this.list(signal);
    return jobs.find((job) => job.paneId === target || job.id === target || job.name === target);
  }

  private async requireJob(target: string, signal?: AbortSignal): Promise<ZellijPaneJob> {
    if (!target.trim()) throw new Error("target is required for this zellij_job action");
    const job = await this.resolve(target, signal);
    if (!job) throw new Error(`No Pi-owned zellij job found for target: ${target}`);
    return job;
  }

  async capture(target: string, lines = 100, signal?: AbortSignal): Promise<{ job: ZellijPaneJob; output: string }> {
    const job = await this.requireJob(target, signal);
    // Read the runner's tee'd log (reliable, full output) and take the tail.
    const full = (await readOptional(resolve(job.directory, "output.log"))) ?? "";
    const allLines = full.split("\n");
    const bounded = Math.max(1, Math.min(lines, 2000));
    const output = allLines.slice(-bounded).join("\n").trimEnd();
    return { job, output };
  }

  async send(target: string, text: string, pressEnter: boolean, signal?: AbortSignal): Promise<ZellijPaneJob> {
    if (text.includes("\0")) throw new Error("text must not contain a NUL byte");
    const job = await this.requireJob(target, signal);
    const sent = await this.exec("zellij", ["action", "write-chars", "-p", job.paneId, text], { signal, timeout: 5000 });
    if (sent.code !== 0) throw new Error(`Unable to send text to ${job.paneId}: ${sent.stderr.trim()}`);
    if (pressEnter) {
      const entered = await this.exec("zellij", ["action", "write", "-p", job.paneId, "10"], { signal, timeout: 5000 });
      if (entered.code !== 0) throw new Error(`Unable to press Enter in ${job.paneId}: ${entered.stderr.trim()}`);
    }
    return (await this.resolve(job.paneId, signal)) ?? job;
  }

  async interrupt(target: string, signal?: AbortSignal): Promise<ZellijPaneJob> {
    const job = await this.requireJob(target, signal);
    // Ctrl-C is byte 3.
    const result = await this.exec("zellij", ["action", "write", "-p", job.paneId, "3"], { signal, timeout: 5000 });
    if (result.code !== 0) throw new Error(`Unable to interrupt ${job.paneId}: ${result.stderr.trim()}`);
    return (await this.resolve(job.paneId, signal)) ?? job;
  }

  async close(target: string, force: boolean, signal?: AbortSignal): Promise<ZellijPaneJob> {
    const job = await this.requireJob(target, signal);
    if (["launching", "running"].includes(job.state) && !force) {
      throw new Error(`Refusing to close running job ${job.name}; interrupt it first or pass force=true`);
    }
    // Kill the runner process tree if we have a pid, then close the pane.
    if (job.pid) {
      await this.exec("bash", ["-c", `kill -TERM -- -${job.pid} 2>/dev/null || kill -TERM ${job.pid} 2>/dev/null || true`], {
        signal,
        timeout: 5000,
      });
    }
    // close-pane only acts on the focused pane, so focus it first.
    await this.exec("zellij", ["action", "focus-pane-id", job.paneId], { signal, timeout: 5000 });
    await this.exec("zellij", ["action", "close-pane"], { signal, timeout: 5000 });
    // Remove from registry.
    const records = (await this.readRegistry()).filter((r) => r.id !== job.id);
    await this.writeRegistry(records);
    await writeFile(resolve(job.directory, "closed"), `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => {});
    return job;
  }

  async wait(
    target: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    onPoll?: (job: ZellijPaneJob) => void,
  ): Promise<{ job: ZellijPaneJob; timedOut: boolean }> {
    const deadline = Date.now() + Math.max(1, Math.min(timeoutSeconds, 7200)) * 1000;
    let job = await this.requireJob(target, signal);
    while (["launching", "running"].includes(job.state)) {
      if (signal?.aborted) throw new Error("zellij_job wait cancelled");
      if (Date.now() >= deadline) return { job, timedOut: true };
      onPoll?.(job);
      await new Promise<void>((r) => setTimeout(r, 1000));
      job = await this.requireJob(job.paneId, signal);
    }
    return { job, timedOut: false };
  }
}

function describeJob(job: ZellijPaneJob): string {
  const exit = job.exitCode === undefined ? "-" : String(job.exitCode);
  return `${job.name} id=${job.id} pane=${job.paneId} state=${job.state} exit=${exit}`;
}

function formatJobs(jobs: ZellijPaneJob[]): string {
  if (jobs.length === 0) return "No Pi-owned zellij jobs are open in this session.";
  return jobs.map(describeJob).join("\n");
}

function boundedOutput(output: string, fullOutputPath?: string): string {
  const truncation = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return truncation.content;
  return (
    `${truncation.content}\n\n` +
    `[Output truncated to ${truncation.outputLines}/${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}).` +
    (fullOutputPath ? ` Full job log: ${fullOutputPath}]` : "]")
  );
}

function requireParameter(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for this zellij_job action`);
  return value;
}

const ACTIONS = ["start", "list", "status", "tail", "wait", "send", "interrupt", "close"] as const;

export default function (pi: ExtensionAPI) {
  const manager = new ZellijJobManager((command, args, options) => pi.exec(command, args, options));

  pi.registerTool({
    name: "zellij_job",
    label: "zellij job",
    description:
      "Run and manage observable commands in Pi-owned zellij panes. " +
      "Use start for long-running or user-visible commands, list/status/tail/wait to monitor them, " +
      "send for interactive input, interrupt for Ctrl-C, and close to remove a pane. " +
      "start requires name and command. All actions except start/list require target (job name, id, or pane id). " +
      "send requires text. close refuses running jobs unless force=true. Output is limited to 50KB/2000 lines.",
    promptSnippet: "Run and monitor long-lived commands in visible Pi-owned zellij panes",
    promptGuidelines: [
      "Use zellij_job instead of background bash when a command is long-running, interactive, or the user asks to watch it live.",
      "Use normal bash for short commands; do not create zellij panes for routine listings or quick checks unless the user explicitly requests it.",
      "zellij_job provides execution and visibility, not authorization; preserve all production, migration, and destructive-operation approval gates.",
      "Do not launch concurrent zellij_job commands that edit the same shared repository files; prepare shared state serially before parallel execution.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS, { description: "Job operation" }),
      name: Type.Optional(Type.String({ description: "Unique safe pane/job name for start, such as cloud-eval" })),
      command: Type.Optional(Type.String({ description: "Shell command for start" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for start; defaults to Pi's cwd" })),
      target: Type.Optional(Type.String({ description: "Existing job name, id, or pane id" })),
      lines: Type.Optional(Type.Integer({ description: "Lines to capture for tail/status", minimum: 1, maximum: 2000 })),
      timeout_seconds: Type.Optional(Type.Integer({ description: "Maximum wait duration", minimum: 1, maximum: 7200 })),
      text: Type.Optional(Type.String({ description: "Literal text for send" })),
      press_enter: Type.Optional(Type.Boolean({ description: "Press Enter after send; defaults true" })),
      force: Type.Optional(Type.Boolean({ description: "Allow close to kill a running job" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], details: {} };
      switch (params.action) {
        case "start": {
          const name = requireParameter(params.name, "name");
          const command = requireParameter(params.command, "command");
          const cwd = resolve(ctx.cwd, params.cwd ?? ".");
          const job = await manager.start({ name, command, cwd, signal });
          return {
            content: [
              {
                type: "text",
                text:
                  `Started ${describeJob(job)}\n` +
                  `Persistent files: ${job.directory}\n` +
                  "Use zellij_job wait/status/tail with this job name or pane id.",
              },
            ],
            details: { job },
          };
        }
        case "list": {
          const jobs = await manager.list(signal);
          return { content: [{ type: "text", text: formatJobs(jobs) }], details: { jobs } };
        }
        case "status": {
          const target = requireParameter(params.target, "target");
          const captured = await manager.capture(target, params.lines ?? 30, signal);
          const text = `${describeJob(captured.job)}\n\n${boundedOutput(captured.output, `${captured.job.directory}/output.log`)}`;
          return { content: [{ type: "text", text }], details: { job: captured.job } };
        }
        case "tail": {
          const target = requireParameter(params.target, "target");
          const captured = await manager.capture(target, params.lines ?? 100, signal);
          return {
            content: [{ type: "text", text: boundedOutput(captured.output, `${captured.job.directory}/output.log`) }],
            details: { job: captured.job },
          };
        }
        case "wait": {
          const target = requireParameter(params.target, "target");
          let polls = 0;
          const result = await manager.wait(target, params.timeout_seconds ?? 1800, signal, (job) => {
            polls += 1;
            if (polls % 5 === 0) {
              onUpdate?.({ content: [{ type: "text", text: `Waiting: ${describeJob(job)}` }], details: { job } });
            }
          });
          const captured = await manager.capture(result.job.paneId, params.lines ?? 60, signal);
          const prefix = result.timedOut ? "Wait timed out; job is still running." : "Job command finished.";
          return {
            content: [
              {
                type: "text",
                text: `${prefix}\n${describeJob(captured.job)}\n\n${boundedOutput(captured.output, `${captured.job.directory}/output.log`)}`,
              },
            ],
            details: { job: captured.job, timedOut: result.timedOut },
          };
        }
        case "send": {
          const target = requireParameter(params.target, "target");
          if (params.text === undefined) throw new Error("text is required for zellij_job send");
          const job = await manager.send(target, params.text, params.press_enter ?? true, signal);
          return { content: [{ type: "text", text: `Sent literal input to ${job.name} (${job.paneId}).` }], details: { job } };
        }
        case "interrupt": {
          const target = requireParameter(params.target, "target");
          const job = await manager.interrupt(target, signal);
          return { content: [{ type: "text", text: `Sent Ctrl-C to ${job.name} (${job.paneId}).` }], details: { job } };
        }
        case "close": {
          const target = requireParameter(params.target, "target");
          const job = await manager.close(target, params.force ?? false, signal);
          return {
            content: [{ type: "text", text: `Closed ${job.name} (${job.paneId}). Persistent files remain at ${job.directory}.` }],
            details: { job },
          };
        }
      }
    },
  });
}
