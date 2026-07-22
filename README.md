# club-3090-pi-extensions

[Pi coding-agent](https://pi.dev) extensions used on the **club-3090** local-LLM
inference stack (2× RTX 3090, models served via vLLM/SGLang behind LiteLLM). The
rig runs Pi inside [zellij](https://zellij.dev), so these extensions make the
agent's shell work **observable in zellij panes**.

One Pi package, many extensions — each lives in `extensions/` and is registered
in `package.json`'s `pi.extensions` array.

## Install

```bash
pi install git:github.com/noonghunna/club-3090-pi-extensions
```

Then restart Pi or run `/reload`.

## Requirements

- Linux / Unix-like
- [zellij](https://zellij.dev) 0.44+ — and **Pi must be running inside a zellij session**
- Node.js 24+
- Pi coding agent 0.80+

## Extensions

### `zellij_job` — observable long-lived command execution

A Pi-owned terminal-multiplexer job runner for zellij: run long or interactive
commands in **visible panes** you can watch, tail, interrupt, or take over —
instead of opaque background bash.

> A zellij port of [`kevinb361/pi-tmux-job`](https://github.com/kevinb361/pi-tmux-job)
> (MIT) — same tool shape and runner design, driving `zellij action` and tracking
> jobs in a `~/.pi/agent/zellij-jobs/jobs.json` registry (zellij has no per-pane
> user-options like tmux).

Use normal `bash` for quick commands. Use `zellij_job` for tests, builds, dev
servers, benchmarks, log tails, migrations — anything where visibility or
persistence matters.

| Action      | Purpose                                                        |
| ----------- | -------------------------------------------------------------- |
| `start`     | Start a command in a Pi-owned pane (requires `name`, `command`) |
| `list`      | List open Pi-owned jobs in this session                        |
| `status`    | Job state + recent output                                      |
| `tail`      | Capture recent output (from the runner's `output.log`)         |
| `wait`      | Wait for the command to finish, bounded timeout                |
| `send`      | Send literal input (requires `text`), optionally press Enter   |
| `interrupt` | Send Ctrl-C                                                    |
| `close`     | Close a completed pane; running jobs require `force=true`      |

Jobs are addressed by **name**, generated **id**, or zellij **pane id**
(`terminal_N`). Each job keeps persistent files under
`~/.pi/agent/zellij-jobs/<id>/` (`command.sh`, `runner.sh`, `output.log`,
`state`, `exit-code`, `pid`).

**Example prompts**

```text
Run rebench-full.sh in a visible zellij pane named rebench, wait for it, and show the result.
```

```text
Start the cloud quality eval in a pane named cloud-eval and tail the last 50 lines.
```

```text
List my Pi-owned zellij jobs and close the completed ones.
```

**Behavior**

- Panes are created with `zellij action new-pane --name … --cwd … -- bash runner.sh`.
- The runner tees all output to `output.log` and writes `state`/`exit-code`, so
  `tail`/`status`/`wait` work from files (reliable, full output — not just the
  viewport).
- `send`/`interrupt` target the pane by `--pane-id` (`write-chars` / `write 3`).
- Output returned to the model is capped at 50 KB / 2000 lines.

### `mux-transcript` — mirror every bash execution into a live pane

Passive visibility: keeps one persistent pane (`pi-mux-<pid>`) running
`tail -f` on a transcript log, and appends `$ <command>` on each `bash` tool call
plus the (truncated) output on each result. **Read-only mirror** — commands are
not re-executed, so there are no side effects.

This one is always-on once installed. If you only want the opt-in `zellij_job`
tool, disable `mux-transcript` with `pi config` (toggle the extension off).

## Adding a new extension

1. Drop a `.ts` file in `extensions/` exporting `default function (pi: ExtensionAPI) { … }`.
2. Add its path to `pi.extensions` in `package.json`.
3. If it registers a tool, list the tool under `provides.tools` in `extension-manifest.json`.
4. Document it above.

## License

MIT — see [LICENSE](./LICENSE). `extensions/zellij-job.ts` is a port of
`kevinb361/pi-tmux-job` (Copyright (c) 2026 Kevin Blalock, MIT).
