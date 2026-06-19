# OmniFleet

OmniFleet is a local-first AI coding runner network.

The long-term vision is simple:

> AI follows the user. Compute follows the task.

In Chinese:

> AI 随人而走，算力随任务而走。

OmniFleet aims to let a user start, supervise, and approve software development tasks from any device, while the actual work is executed by the most suitable trusted environment: a MacBook, a Windows workstation, a Linux server, an Android device, a cloud runner, or any future capable node.

The goal is not to replace tools like opencode, Claude Code, Codex, Trae, Cursor, Aider, or other AI coding agents. The goal is to orchestrate them.

OmniFleet is the layer that connects user intent, device capability, project context, execution permissions, and AI coding tools into one personal development network.

## Final Goal

The final goal is to build a decentralized, cross-platform AI development system made of trusted apps and runners across Android, macOS, Windows, Linux, and cloud environments.

From any device, the user should be able to say:

> Fix this bug in my project, run the tests, show me the diff, and wait for my approval.

OmniFleet should then be able to:

1. Understand the user's intent.
2. Locate the project and relevant context.
3. Find the best available execution environment.
4. Select the appropriate AI coding tool.
5. Execute the task inside a controlled permission boundary.
6. Stream progress back to the user.
7. Return logs, diffs, test results, and risk notes.
8. Let the user approve, reject, continue, or take over.

In the mature version, OmniFleet should support:

1. Cross-device task handoff.
2. Local-first execution on user-owned machines.
3. Optional cloud execution when appropriate.
4. Tool-neutral orchestration across multiple AI coding agents.
5. Capability-based task routing.
6. End-to-end encrypted sync and relay.
7. Self-hostable coordination infrastructure.
8. Auditable permission and execution history.
9. Project-aware context management.
10. Human-in-the-loop approval for risky actions.

The user's identity, context, permissions, and development goals should move with the user. The computation should move to the device or environment best suited for the task.

## Why This Exists

AI coding tools are becoming powerful, but today's workflow is fragmented.

Common problems:

1. Work is tied to one machine or one IDE.
2. Context is trapped inside individual tools.
3. A phone or tablet can describe work, but usually cannot safely execute it.
4. Powerful machines sit idle while the user is away.
5. Different AI coding agents have different strengths, but no shared task layer.
6. Remote development often means SSH or remote desktop, not intent-based task execution.
7. Users need control, auditability, and approval before trusting autonomous code changes.

OmniFleet treats development work as tasks, not screens.

Instead of moving a desktop UI across devices, OmniFleet moves:

1. Intent.
2. Context.
3. Permissions.
4. Execution events.
5. Results.
6. Review and approval.

## Core Idea

OmniFleet is built around two principles.

### AI Follows The User

The user should not lose continuity when switching devices.

A task may be created from a phone, inspected from a tablet, executed on a workstation, tested on a Linux server, and finally approved from a browser.

The AI layer should carry the necessary project context, task history, user preferences, and permission boundaries across this flow.

### Compute Follows The Task

Tasks should run where they make the most sense.

That may be:

1. A local laptop with the source code.
2. A Windows machine that can reproduce a platform-specific issue.
3. A Linux server with the right dependencies.
4. A Mac with the correct mobile build setup.
5. A cloud runner for isolated execution.
6. A future Android runner for lightweight work.

Internally, this should be capability-based rather than purely compute-based. The best runner is not always the most powerful machine. It is the one with the right repository, dependencies, tools, permissions, network access, and safety constraints.

## Product Shape

OmniFleet is not a traditional IDE.

It is also not just remote desktop, SSH, CI, or a single cloud agent.

It is a personal AI coding runner network.

The system consists of several components:

1. **Client**: Web, mobile, desktop, chat, or CLI entry points used to create tasks and review results.
2. **Runner**: A trusted local or remote process installed on a device that can execute tasks.
3. **Relay**: A lightweight coordination service for device discovery, message forwarding, and task state.
4. **Tool adapters**: Integrations for tools such as opencode, Claude Code, Codex, Aider, Trae, Cursor, and future agents.
5. **Context store**: Project summaries, task history, user preferences, and execution metadata.
6. **Permission system**: Policy boundaries around files, commands, tools, network access, git operations, and approvals.

## Initial MVP

The first milestone should be deliberately narrow:

> Create a task from a phone or web page, execute it on a trusted local computer using an AI coding CLI, and return logs, diffs, and test results for approval.

The MVP should prove one core experience:

> Even when the user is not sitting at the development machine, they can safely ask that machine's AI coding agent to make progress.

### MVP Flow

1. Install a runner on macOS, Windows, or Linux.
2. Register a local project directory.
3. Detect available AI coding tools such as opencode or Claude Code.
4. Open the web or mobile control surface.
5. Create a development task.
6. Choose the project, runner, and tool.
7. Stream the execution log in real time.
8. Collect the resulting git diff.
9. Show test results and a task summary.
10. Ask the user to approve, reject, continue, or take over.

### MVP Scope

The MVP should include:

1. Device registration.
2. Project registration.
3. Task creation.
4. Runner task execution.
5. opencode adapter.
6. Real-time logs.
7. Git diff collection.
8. Basic test command execution.
9. Task history.
10. Manual approval before commit or push.

The MVP should not initially include:

1. Full peer-to-peer networking.
2. Native Android heavy execution.
3. GUI automation for every IDE.
4. Complex multi-agent collaboration.
5. Full long-term memory.
6. Enterprise administration.
7. Fully automatic tool and runner selection.

## Architecture

```text
+----------------------+
|  Web / Mobile Client |
|  create / review     |
+----------+-----------+
           |
           | HTTPS / WebSocket
           v
+----------------------+
|     Relay Server     |
|  discovery / events  |
+----------+-----------+
           |
           | encrypted task channel
           v
+----------------------+
|    Device Runner     |
|  policy / execution  |
+----------+-----------+
           |
           v
+----------------------+
|    Tool Adapters     |
| opencode / cc / etc. |
+----------+-----------+
           |
           v
+----------------------+
|   Local Workspace    |
|  repo / tests / env  |
+----------------------+
```

## Core Abstractions

### Task

A task is a structured development request, not just a prompt.

Example:

```json
{
  "id": "task_123",
  "project": "OmniFleet",
  "intent": "fix_bug",
  "description": "Fix the vehicle status filter and run tests.",
  "runner": "windows-workstation",
  "tool": "opencode",
  "permissions": {
    "canEdit": true,
    "canRunTests": true,
    "canPush": false,
    "requiresApprovalForShell": true
  },
  "status": "running"
}
```

### Runner

A runner is a trusted device process that can execute tasks.

It should expose a capability manifest such as:

```json
{
  "device": "windows-workstation",
  "os": "windows",
  "online": true,
  "projects": ["OmniFleet"],
  "tools": ["opencode", "codex"],
  "capabilities": ["read_repo", "edit_code", "run_tests", "git_diff"]
}
```

### Tool Adapter

A tool adapter wraps an AI coding tool behind a common interface.

Example interface:

```ts
interface ToolAdapter {
  name: string
  detect(): Promise<boolean>
  start(task: Task): Promise<RunHandle>
  stream(runId: string): AsyncIterable<ToolEvent>
  cancel(runId: string): Promise<void>
  collectResult(runId: string): Promise<TaskResult>
}
```

### Context

Context should be useful, scoped, and auditable.

Early context should include:

1. Project summary.
2. Directory structure.
3. Test and build commands.
4. Recent task history.
5. User preferences.
6. Tool execution results.

OmniFleet should avoid blindly syncing all memory into every task. Context must be selected according to project, permission, recency, and relevance.

## Security Principles

OmniFleet controls tools that can read files, edit code, and run commands. Security is not optional.

The default posture should be conservative.

### Local-First Execution

Code should run on user-approved devices by default. Cloud execution should be optional and explicit.

### Project-Level Authorization

Runners should only access explicitly registered project directories.

They should not receive broad access to the user's full filesystem.

### Sensitive File Protection

Sensitive files should be denied or require explicit approval by default, including:

```text
.env
.env.*
*.pem
*.key
id_rsa
id_ed25519
.ssh/
.aws/
.npmrc
credentials
```

### Human Approval For Risky Actions

High-risk operations should require user approval.

Examples:

```text
git push
git reset --hard
rm -rf
del /s
curl | sh
Invoke-WebRequest ... | iex
npm publish
pnpm publish
kubectl apply
terraform apply
```

### Diff Before Merge

The default workflow should be:

1. Create or select a safe task branch or worktree.
2. Execute the task.
3. Generate a diff.
4. Run tests if configured.
5. Ask the user for approval.
6. Commit or push only after explicit confirmation.

### Audit Everything

Each task should preserve an audit trail:

1. Prompt and task metadata.
2. Runner and tool used.
3. Files read or modified when available.
4. Commands executed.
5. Logs and errors.
6. Diff output.
7. Test results.
8. User approvals or rejections.

## Roadmap

### Phase 0: Prototype

Goal: prove the core loop.

1. One web page.
2. One local runner.
3. One relay.
4. One opencode adapter.
5. Real-time logs.
6. Git diff return.

Success means a real repository can be modified by an AI coding tool from a remote task request, with the result visible to the user.

### Phase 1: Personal MVP

Goal: make it useful for a single developer.

1. Multiple projects.
2. Multiple devices.
3. Runner status.
4. Task history.
5. Basic permissions.
6. Branch or worktree isolation.
7. Test command configuration.
8. Additional adapter for Claude Code, Codex, or Aider.

### Phase 2: Context Layer

Goal: make tasks smarter across time.

1. Project scanning.
2. Project summaries.
3. Build and test command detection.
4. Recent task summaries.
5. User preferences.
6. Context selection and injection.

### Phase 3: Capability Routing

Goal: route tasks to the right environment.

1. Runner capability manifests.
2. Tool capability manifests.
3. Automatic runner suggestions.
4. Automatic tool suggestions.
5. Retry and fallback.
6. Review agents.
7. Multi-step workflows.

### Phase 4: Decentralized Operation

Goal: align with the full vision.

1. End-to-end encrypted messaging.
2. Self-hostable relay.
3. Local network discovery.
4. Peer-to-peer direct channels where possible.
5. Offline task queues.
6. Local-first sync.
7. Device-to-device handoff.

### Phase 5: Ecosystem

Goal: become a tool-neutral orchestration layer.

1. Adapter SDK.
2. MCP integration.
3. Workflow templates.
4. Team collaboration.
5. Enterprise permissions and audit.
6. Hosted and self-hosted runners.
7. Integrations with GitHub, GitLab, Jira, Linear, Slack, and Feishu.

## Positioning

OmniFleet is not trying to be one more AI coding tool.

It is trying to become the network that lets many AI coding tools run safely across the user's own devices.

Short description:

> A local-first AI coding runner network for orchestrating development tasks across trusted devices.

Developer-facing description:

> Start a task from anywhere, run it on the right machine, use the right AI coding agent, and approve the result before it touches your main branch.

Vision statement:

> Your identity, context, and intent move with you. Your devices provide the capabilities. OmniFleet routes the task.

## Guiding Principles

1. User intent is the primary interface.
2. Devices are execution nodes, not isolated work silos.
3. Tools are adapters, not the platform itself.
4. Local-first execution is the default.
5. Permission comes before automation.
6. Every task must be observable.
7. Every risky action must be reviewable.
8. Context should be scoped, relevant, and auditable.
9. The system should be self-hostable over time.
10. The final product should make AI development feel continuous across devices.

## Current Status

This repository currently contains the initial product vision, technical direction, and a landed first version of OmniFleet.

The first version implements the core local loop:

1. Create a development task.
2. Select a trusted local runner, project, and tool.
3. Dispatch the task to a real local runner API.
4. Stream runner logs through Server-Sent Events.
5. Execute a policy-approved project command.
6. Review the task result.
7. Approve the result through a human-in-the-loop gate.

The visual direction is structuralist and geometric: grid-based layout, hard borders, modular panels, restrained color, and clear execution states.

Implementation should start with the smallest useful loop:

> Web task creation -> local runner execution -> AI tool invocation -> streamed logs -> git diff -> user approval.

## Running The Landed First Version

Install dependencies:

```bash
npm install
```

Start the frontend development server:

```bash
npm run dev
```

Start the local runner in another terminal:

```bash
npm run runner
```

Then open the Vite URL shown in the terminal. The frontend will connect to `http://localhost:8787` during development.

Run the built app and runner together:

```bash
npm run app
```

This builds the frontend and serves it from the local runner at:

```text
http://localhost:8787
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## First Version Scope

The current app includes a real local runner, but remains intentionally narrow. It proves task dispatch, streamed execution, project-level command policy, adapter-based tool detection, isolated opencode execution, git result collection, and approval flow before introducing distributed relay infrastructure and richer AI tool execution.

Implemented:

1. Vite + React + TypeScript app shell.
2. Task creation panel.
3. Project, runner, and tool selection.
4. Local Node runner API.
5. Runner route visualization.
6. Server-Sent Events execution stream.
7. Whitelisted project command execution.
8. Adapter registry for `build-check`, `mock-agent`, `opencode`, `claude`, and `codex`.
9. Tool availability detection from the runner environment.
10. Isolated `opencode run` execution inside per-task git worktrees.
11. Real git status and git diff collection.
12. Permission policy panel.
13. Result review card.
14. Approval state.
15. Responsive desktop and mobile layout.
16. Offline demo fallback when the runner is not available.
17. Persistent local task history.
18. Local device identity and runner token authentication.

Not implemented yet:

1. Real relay server.
2. Multi-device registration.
3. Claude Code / Codex task execution wiring.
4. Command-by-command approval interception.
5. Applying approved worktree changes back to the main workspace.
6. Authentication and device identity.
7. End-to-end encrypted remote dispatch.

## Local Runner

The first runner lives in:

```text
runner/server.mjs
```

Configuration lives in:

```text
omnifleet.config.json
```

The default configuration registers this repository as the first project and allows one safe command:

```text
npm run build
```

The runner exposes:

```text
GET  /api/health
GET  /api/runners
GET  /api/projects
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:id
GET  /api/tasks/:id/events
POST /api/tasks/:id/approve
POST /api/tasks/:id/apply
```

The execution model is deliberately conservative:

1. The runner only executes commands listed in the project's `allowedCommands`.
2. The default task command is `npm run build`.
3. `opencode` runs inside a per-task git worktree under `.omnifleet/worktrees`.
4. Push, publish, destructive shell, deployment, and secret-reading operations are not implemented.
5. Approval only approves the task result; it does not commit or push code.
6. Applying a task is a separate action that checks the main workspace is clean before patching.
7. Applying uses the isolated worktree diff and `git apply --index`; commit and push remain explicit future actions.

The runner now has a minimal adapter registry:

1. `build-check`: executes the project's whitelisted build command.
2. `mock-agent`: simulates an agent for UI and flow testing.
3. `opencode`: detected from `PATH`, executed with `opencode run --dir <task-worktree>`.
4. `claude`: detected from `PATH`, execution wiring pending.
5. `codex`: detected from `PATH`, execution wiring pending.

Each task result includes git metadata when available:

1. Whether the project is inside a git worktree.
2. `git status --short` output.
3. A bounded `git diff --no-ext-diff` result for review.
4. Worktree path, branch, and agent-side git status when using `opencode`.

The approval flow is intentionally two-stage:

1. `approve`: marks the reviewed result as trusted enough to apply.
2. `apply`: applies the approved worktree patch to the main workspace index, only if the main workspace is clean.

This prevents a UI approval click from silently mutating the main project.

## Device Token

On first start, the runner creates a local device identity file:

```text
.omnifleet/device.json
```

It contains:

```json
{
  "id": "local-runner-01",
  "name": "Local OmniFleet Runner",
  "token": "...",
  "createdAt": "..."
}
```

All runner API endpoints except `GET /api/health` require authentication.

HTTP requests must include:

```text
X-OmniFleet-Token: <token>
```

The web UI includes a runner token field. Paste the token from `.omnifleet/device.json` and click `Save`. The token is stored in browser `localStorage` for local development.

Server-Sent Events use a query token because the browser `EventSource` API does not support custom headers:

```text
GET /api/tasks/:id/events?token=<token>
```

This is a local-first development guard, not a complete remote security model. A future relay version should use stronger device registration, token rotation, TLS, and scoped permissions.

Task history is stored locally at:

```text
.omnifleet/tasks.json
```

The runner keeps the latest 100 tasks, including task metadata, events, status, and result summaries. The web UI reads the latest 50 tasks from `GET /api/tasks` and displays them in the task history panel. This is intentionally local-only and ignored by git.

This gives OmniFleet a real but safe first landing point: the user can dispatch a task to a local runner and observe an actual project command execute with streamed logs.
