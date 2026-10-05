# pi-actors

Subagents for [pi](https://pi.dev). An agent can start child agents, each with a fresh context or a copy of its own conversation, on any model. It can message them and stop them. Their results, messages and questions arrive in the conversation by themselves.

```
pi install npm:pi-actors
```

## Why it's built this way

Running agents in the background goes wrong in predictable ways: messages get lost or delivered twice, children keep running after their parent is gone, a reload or crash breaks everything, and agents waste turns polling for results. pi-actors is designed so that none of these can happen, and then checked to make sure they don't.

- **Nothing is lost when something goes wrong.** Your session can reload, you can close the terminal, or the background process coordinating the agents can crash. Messages and children survive all of it, and every message is acted on exactly once, never dropped and never duplicated.
- **No orphaned agents.** If an agent goes away and doesn't come back within a short grace period, its children are stopped, and so are theirs. Nothing keeps running and spending tokens unseen.
- **No polling.** Results and messages are pushed into the agent's conversation when they arrive. An agent waiting for children simply ends its turn and is woken up.
- **Three tools, small and hard to misuse.** `spawn`, `send` and `stop` add about 700 tokens to the context. There are no multi-purpose tools with dozens of options for the model to get wrong.
- **Questions come to you, answered with a few keystrokes.** An agent that needs a decision asks with options. You see who is asking and why, pick an answer with the arrow keys, and it goes straight back to that agent.
- **Checked, not just tested.** The coordination protocol is written as a formal model in [Quint](https://quint-lang.org), a specification language built on TLA+'s logic. Tools explore thousands of interleavings of crashes, reloads and retries against its guarantees. Deliberately injected bugs are caught every time, and the implementation is tested against the same guarantees.

## The three tools

| Tool | What it does |
|---|---|
| `spawn{task, name?, model?, thinking?, fork?, cwd?, pane?, timeout_minutes?, resume?}` | Starts a child and returns its id immediately. `fork: true` gives the child a copy of this conversation. `model` can be any provider's model, and `cwd` can point to, say, a git worktree. `pane: true` runs the child in a visible pane when pi runs inside [herdr](https://herdr.dev) or tmux. |
| `send{to, text, reply_to?, choices?, multi?, urgent?}` | Sends a message to a child (by id), to `"parent"`, or to `"human"`. It never blocks. `reply_to` answers a message. For a question to the human, `choices` offers options and `multi` allows picking several. |
| `stop{id}` | Stops a child, together with its own children. |

What arrives by itself:

- **Reports:** each time a child finishes a piece of work, its final answer is delivered to its parent. The child then waits; another `send` continues it.
- **Messages and answers:** from other agents and from you. Answers say which message they reply to.
- **End notices:** if a child crashes, is stopped or loses its parent, the parent hears about it once, with the reason.

A typical pattern: start a few children, end the turn, and act on their reports as they arrive.

## Answering questions

While agents are working or waiting on you, a line under the editor says so: `pi-actors · 2 agents · 1 question for you — ↓ to open`. Press **↓ on an empty editor** to open the panel.

- **Questions come first.** Each shows who is asking and the question. Press Enter to open it:
  - You see what the agent is working on, the question, and the options with their descriptions.
  - ↑↓ and Enter pick an option. For multi-select, Space toggles options and Enter confirms.
  - "Type something…" lets you answer in your own words.
  - `t` shows the agent's recent work, and `d` declines, telling the agent to use its own judgment.
  - Your answer goes back to exactly that agent and question.
- **Agents come next**, showing each one's status, model and placement. Enter shows an agent's recent transcript: its task, the tools it ran and what it said. For an agent in a pane, `f` jumps to it.

`/inbox` opens the same panel. Without a TUI (RPC or print mode), `/inbox` lists the questions and `/answer <#> <text>` or `/answer <#> 1,3` replies.

## Panes in herdr or tmux (optional)

Everything works in a plain terminal. If pi runs inside [herdr](https://herdr.dev) or tmux, you also get:

- **Visible children:** `pane: true` puts a child in its own pane next to yours, where you can watch it and talk to it. Its questions appear right there. If tmux runs inside herdr, the panes open in tmux, the multiplexer you're actually looking at.
- **Notifications:**
  - **In herdr,** the pane where a question should be answered is marked as waiting for you, which is the asking child's own pane or the root's pane for everything else. The mark clears once the question is answered.
  - **In tmux,** the pane rings the terminal bell, so tmux flags the window, and a short message names who is asking.

Outside both, `pane: true` fails immediately with a clear message.

## Commands

- **`/actors`** prints the agent tree. **`/actors stop <id>`** stops one agent, and **`/actors stop`** stops all of them.
- **`/inbox`** opens the panel. **`/answer`** answers without a TUI.

## Limits

There are two limits, set in `~/.pi/agent/pi-actors.json`:

```json
{ "maxDepth": 2, "maxSpawns": 40 }
```

- **`maxDepth`:** how many levels of children below you are allowed.
- **`maxSpawns`:** how many agents can be started in total, including restarts.

An agent can set lower limits for the children it starts, but never higher ones. When a limit is reached, the agent is told to do the work itself.

## How it works

Each tree of agents is coordinated by one small background process, the broker. Every change it makes is written to disk before it is confirmed, so after a crash it can be restarted and carry on exactly where it was. Agents that run without a visible pane are each watched by a tiny keeper process, which keeps them alive if the broker restarts. Each tree runs from its own copy of this extension's code, so updating pi in the middle of a run never mixes versions.

The design (`designs/pi-actors.md`), the spec (`specs/pi-actors.md`) and the formal model (`model/`) are in the repository.

## With pi-verified-goal

Under [pi-verified-goal](https://github.com/jkeskikangas/pi-verified-goal)'s `/goal`, an agent that is waiting on its children, or on an answer from you, is neither pushed to continue nor paused. Their reports wake it up.

## Requirements

- pi 1.0 or newer, running on Node 22.18 or newer.
- Optional: herdr 0.9 or newer, or tmux 3.2 or newer, for panes.

## Development

```
npm install
npm test            # unit, property, broker and extension tests (no model calls)
npm run test:live   # real pi with a scripted model: round trip, fork, a tmux pane, and a herdr pane (inside herdr only)
npm run model       # the Quint model: scenarios, simulation, and the injected-bug suite
```
