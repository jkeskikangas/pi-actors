# pi-actors

Subagents for [pi](https://pi.dev). An agent can start child agents, each with a fresh context or a copy of its own conversation, on any model. It can message them and stop them. Their results and messages arrive in the conversation by themselves.

```
pi install npm:pi-actors
```

## Why it's built this way

Running agents in the background goes wrong in predictable ways: messages get lost or delivered twice, children keep running after their parent is gone, a reload or crash breaks everything, and agents waste turns polling for results. pi-actors is designed so that none of these can happen, and then checked to make sure they don't.

- **Nothing is lost when something goes wrong.** Your session can reload, you can close the terminal, or the background process coordinating the agents can crash. Messages and children survive all of it, and every message is acted on exactly once, never dropped and never duplicated.
- **No orphaned agents.** If an agent goes away and doesn't come back within a short grace period, its children are stopped, and so are theirs. Nothing keeps running and spending tokens unseen.
- **No polling.** Results and messages are pushed into the agent's conversation when they arrive. An agent waiting for children simply ends its turn and is woken up.
- **Three tools, small and hard to misuse.** `spawn`, `send` and `stop` add about 700 tokens to the context. There are no multi-purpose tools with dozens of options for the model to get wrong.
- **One voice talks to you.** Agents only talk to each other. A child that needs a decision asks its parent, which answers from its own context when it can and otherwise asks further up. Only your session's agent asks you, in its own words and its own way.
- **Checked, not just tested.** The coordination protocol is written as formal models in [Quint](https://quint-lang.org), a specification language built on TLA+'s logic: message delivery, the agent lifecycle (clearing ended agents included), and which process may act as which agent. Tools explore thousands of interleavings of crashes, reloads, retries and restarts against their guarantees. Deliberately injected bugs are caught every time, and the implementation is tested against the same guarantees.

## The three tools

| Tool | What it does |
|---|---|
| `spawn{task, name?, model?, thinking?, fork?, cwd?, pane?, timeout_minutes?, resume?}` | Starts a child and returns its id immediately. `fork: true` gives the child a copy of this conversation. `model` can be any provider's model, and `cwd` can point to, say, a git worktree. `pane: true` runs the child in a visible pane when pi runs inside [herdr](https://herdr.dev) or tmux. |
| `send{to, text, reply_to?, urgent?}` | Sends a message to a child (by id) or to `"parent"`. It never blocks. `reply_to` answers a message. |
| `stop{id}` | Stops a child, together with its own children. |

What arrives by itself:

- **Reports:** each time a child finishes a piece of work, its final answer is delivered to its parent. The child then waits; another `send` continues it.
- **Messages and answers:** from other agents. Answers say which message they reply to.
- **End notices:** if a child crashes, times out or is lost, the parent hears about it once, with the reason. A child the parent stopped itself ends quietly.

In the chat, each delivery shows as one dim line, such as `⇢ report from backend`, and expands to the full text the agent read.

A typical pattern: start a few children, end the turn, and act on their reports as they arrive.

## The agents panel

While children run, a line under the editor says so: `pi-actors · 2 running — ↓ to open`. Press **↓ on an empty editor**, or run `/actors`, to open the panel.

- **Running agents come first**, in tree order, with their status, model and placement.
- **Ended agents fold into one row**, `▸ 5 ended`. Enter unfolds it. Their transcripts stay readable until you clear them.
- **Enter** shows an agent's transcript: its task, what it said, and the tools it ran with their main argument (`⚙ bash  git diff --stat`). ↑↓, PgUp/PgDn and Home/End scroll it; it follows new output while you're at the end. `e` expands tool output and full messages.
- **`x`** clears an ended agent together with its ended children, or, on the `ended` row, every ended agent. The panel stays open.
- **`f`** jumps to an agent's pane, when it runs in one.

## Panes in herdr or tmux (optional)

Everything works in a plain terminal. If pi runs inside [herdr](https://herdr.dev) or tmux, you also get:

- **Visible children:** `pane: true` puts a child in its own pane next to yours, where you can watch it and talk to it. If tmux runs inside herdr, the panes open in tmux, the multiplexer you're actually looking at.

Outside both, `pane: true` fails immediately with a clear message.

## Commands

- **`/actors`** opens the panel (without a TUI, it prints the tree).
- **`/actors stop <id>`** stops one agent, and **`/actors stop`** stops all of them.
- **`/actors clear`** removes every ended agent from the tree.
- **`/new`** stops the whole tree: a new session starts with no agents. `/resume`, `/fork` and reloads keep the tree running.

## Settings

Set in `~/.pi/agent/pi-actors.json`:

```json
{ "maxDepth": 2, "maxSpawns": 40, "keepFinishedDays": 7 }
```

- **`maxDepth`:** how many levels of children below you are allowed.
- **`maxSpawns`:** how many agents can be started in total, including restarts.

An agent can set lower limits for the children it starts, but never higher ones. When a limit is reached, the agent is told to do the work itself.

- **`keepFinishedDays`:** how long a finished tree keeps its files: the event log and every child's session, which hold their transcripts. After that, they're deleted the next time a session uses pi-actors. A finished tree is one that was stopped, or whose root never came back.

## How it works

Each tree of agents is coordinated by one small background process, the broker. Every change it makes is written to disk before it is confirmed, so after a crash it can be restarted and carry on exactly where it was. Agents that run without a visible pane are each watched by a tiny keeper process, which keeps them alive if the broker restarts. Each tree runs from its own copy of this extension's code, so updating pi in the middle of a run never mixes versions.

The design (`designs/pi-actors.md`), the spec (`specs/pi-actors.md`) and the formal model (`model/`) are in the repository.

## With pi-verified-goal

Under [pi-verified-goal](https://github.com/jkeskikangas/pi-verified-goal)'s `/goal`, an agent that is waiting on its children is neither pushed to continue nor paused. Their reports wake it up.

## Requirements

- pi 1.0 or newer, running on Node 22.18 or newer.
- Optional: herdr 0.9 or newer, or tmux 3.2 or newer, for panes.

## Development

```
npm install
npm test            # unit, property, broker and extension tests (no model calls)
npm run test:live   # real pi with a scripted model: round trip, fork, a tmux pane, and a herdr pane (inside herdr only)
npm run model       # the Quint models: scenarios, simulation, and the injected-bug suite
```
