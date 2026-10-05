# pi-actors

Subagents for [pi](https://pi.dev), built like Erlang processes. An agent can **spawn** children (with a fresh context, or forked from its own conversation, on any model), **send** them messages, and **stop** them. Children's reports, messages and answers are **pushed** into the conversation, so an agent never polls; it just ends its turn and is woken when something arrives.

```
pi install npm:pi-actors
```

## The three tools

| Tool                                                                                   | What it does                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn{task, name?, model?, thinking?, fork?, cwd?, pane?, timeout_minutes?, resume?}` | Starts a child and returns its id immediately. `fork: true` gives the child a copy of this conversation. `model` can be any provider's model. `pane: true` runs the child in a visible [herdr](https://herdr.dev) pane. |
| `send{to, text, reply_to?, urgent?}`                                                   | Sends a message to a child (its id), to `"parent"`, or to `"human"`. Never blocks. `reply_to` answers a message you received.                                                                                           |
| `stop{id}`                                                                             | Stops a descendant, including its own children.                                                                                                                                                                         |

Everything else arrives by itself:

- **Reports:** each time a child finishes a run, its final answer is pushed to its parent. The child then stays alive; another `send` continues it.
- **Messages and answers:** these come from other agents or from the human. Answers are marked with the message they reply to.
- **End notices:** if a child crashes, is stopped, or loses its parent, the parent gets exactly one notice with the reason.

A typical pattern: spawn a few children, end your turn, and react to their reports as they arrive. To ask a child something, `send` it and end your turn. Its answer arrives as its next report.

## The agents panel

While a tree has agents or open questions, a line under the editor says so: `pi-actors · 2 agents · 1 question for you — ↓ to open`. Press **↓ on an empty editor** to open the panel:

- **Questions for you:** these come first. Enter on a question to type your answer, and it is delivered right away.
- **The agent tree:** each agent's status, model and placement. Enter on an agent to see its recent transcript: what it was asked, the tools it ran, what it said. For a child in a herdr pane, `f` focuses its pane.
- **Keys:** ↑/↓ move, Esc goes back or closes. A non-empty editor is never intercepted.

`/inbox` opens the same panel. In RPC or print mode, where there is no TUI, `/inbox` prints the questions and `/answer <#> <text>` replies.

## Escalating to you

An agent that needs a decision only a human can make sends to `"human"`. The question appears in the root's panel. A child running in a herdr pane also asks right in its own pane, and answering in either place closes the question in both.

## herdr (optional)

pi-actors works without [herdr](https://herdr.dev): children run headless and the panel lives in the root's TUI. Inside herdr, two things are added:

- **Visible children:** `pane: true` runs a child in a visible pane, which you can watch and talk to.
- **The blocked signal:** the pane where you'd answer a question is marked *blocked*, through herdr's official pi integration. That is the child's own pane for questions from pane children, and the root's pane for everything else. The label names who is asking, and the mark clears as soon as the question is answered.

Outside herdr, `pane: true` fails immediately with a clear message, and nothing else changes.

## Commands

- **`/actors`** prints the tree. **`/actors stop <id>`** stops one agent, and **`/actors stop`** stops the whole tree.
- **`/inbox`** opens the agents panel. **`/answer <#> <text>`** answers without the TUI.

## Limits

There are two limits, set in `~/.pi/agent/pi-actors.json`:

```json
{ "maxDepth": 2, "maxSpawns": 40 }
```

- **`maxDepth`:** how deep the tree can nest. The root is depth 0.
- **`maxSpawns`:** the total number of spawns in the tree, including resumes.

A spawn beyond either limit fails with an error that tells the model to do the work itself. Each agent's mailbox is also bounded: 200 messages or 2 MiB of ordinary mail.

## Reliability

Each agent tree has one small broker process that owns all routing state behind a Unix socket. Every change is fsynced to an append-only event log before it is acknowledged.

- **Reloads and crashes:**
  - A pi reload, a closed terminal or a broker crash loses no messages and kills no children.
  - Headless children run under a *keeper* process that owns their stdin, so they survive the broker restarting.
  - A disconnected agent gets a grace period of 60 s, or 300 s for the root. After that its children are stopped, so nothing is orphaned.
- **Exactly-once delivery:** pushed messages are stamped session entries. They are acknowledged only once saved, and duplicates are dropped by message id.
- **Version pinning:** each tree runs from a snapshot of the extension's code (`~/.pi/agent/actors/runtime/`), so `pi update` mid-run can't mix versions.
- **Verification:** the protocol is modelled in Quint (`model/`). The reducer is checked against the model's invariants by property tests, and a mutation suite proves those invariants catch known bugs.

## With pi-verified-goal

Under [pi-verified-goal](https://github.com/jkeskikangas/pi-verified-goal)'s `/goal`, a coordinator that is waiting on children, or on a question to you, neither continues nor pauses. Their reports wake it.

## Requirements

- pi 1.0 or newer, running on Node 22.18 or newer (for native TypeScript type stripping).
- Optional: herdr 0.9 or newer, for `pane: true` and the blocked signal.

## Development

```
npm install
npm test            # reducer scenarios and properties, delivery, conformance, broker integration
npm run test:live   # real pi with a scripted provider (no model calls); pane test inside herdr only
npm run model       # Quint model: scenarios, simulation, witnesses, mutation suite
```

The design is in `designs/pi-actors.md`, and the spec in `specs/pi-actors.md`.
