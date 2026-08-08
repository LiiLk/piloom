<p align="center">
  <a href="https://github.com/LiiLk/piloom">
    <img alt="PiLoom" src="assets/piloom-mark.svg" width="144" style="max-width: 100%;">
  </a>
</p>

<h3 align="center">
PiLoom: a persistent recursive coding and research agent
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-agent">Prime Agent upstream</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">pi</a>
</p>

<p align="center">
  <a href="https://github.com/LiiLk/piloom/actions/workflows/ci.yml">
    <img src="https://github.com/LiiLk/piloom/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/LiiLk/piloom/actions/workflows/build-binaries.yml">
    <img src="https://github.com/LiiLk/piloom/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
</p>

PiLoom is an independent cross-platform fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) with a Windows-first development focus. It preserves Prime Agent's architecture while preparing its daemon, workers, sessions, RPC interfaces, and development workflows for Windows and other platforms.

The project is based on two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool / sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that PiLoom can refine through small, evidence-backed updates, local to the session by default.

PiLoom combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** persistent IPython is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Project status

PiLoom is at the foundation stage of its cross-platform work, with Windows as its first platform target. The upstream behavior and architecture are being retained while platform compatibility is addressed incrementally. The current roadmap includes Windows-safe directory synchronization, Python virtual-environment discovery, a native `uv` installation path, Windows CI and release jobs, and Windows daemon/lifecycle coverage.

Until that work is complete, the existing Unix installer and some development paths remain upstream-oriented. Check the project issues and development documentation before relying on this fork for production Windows use.

## Getting Started

### From source

Clone PiLoom and follow the development documentation:

```bash
git clone https://github.com/LiiLk/piloom.git
cd piloom
```

See the [development guide](packages/coding-agent/docs/development.md) for the source workflow and the [quickstart](packages/coding-agent/docs/quickstart.md) for authentication and first-run instructions. The [provider setup guide](packages/coding-agent/docs/providers.md) covers subscription and API-key providers.

Start the agent from the repository or directory it should work in:

```bash
cd /path/to/project
prime-agent
```

On first launch, run `/login` to choose a subscription or API-key provider. PiLoom works in the current directory and can run commands and modify files there. Use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

The current CLI executable remains `prime-agent`; the repository and project identity are PiLoom.

> [!WARNING]
> PiLoom executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not a security sandbox**. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
prime-agent agents                   # Browse running, idle, and saved sessions
prime-agent attach <agent>           # Reattach to a running session
prime-agent --resume <path|id>       # Resume a saved session
prime-agent status                   # Inspect background service state
prime-agent doctor [--fix]            # Inspect or repair background services
prime-agent update [--force]          # Update Prime Agent
prime-agent shutdown [--force]        # Stop every agent, worker, and background service
```

## Built for Long-Running Work

PiLoom is designed for long-running work, especially for evaluations in research. These features are available in the TUI and autonomous mode:

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, IPython state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `prime-agent schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) - install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) - commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) - detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) - persistent IPython, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) - headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) - install and create reusable capabilities
- [Provider setup](packages/coding-agent/docs/providers.md) - subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) - daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) - build and run from source

## Attribution

PiLoom is an independent fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) by [Prime Intellect](https://github.com/PrimeIntellect-ai). Prime Agent is built on top of [`pi`](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/badlogic).

This fork preserves the upstream attribution and MIT license. See [LICENSE](LICENSE) for the complete license text.

## License

PiLoom is released under the [MIT License](LICENSE).
