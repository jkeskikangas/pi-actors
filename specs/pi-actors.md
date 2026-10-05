# pi-actors — Spec

**Status:** draft, derived from the design discussion of 2026-10-05 (pi-subagents review, herdr evaluation, OTP lessons). Needs user review.

## Problem

A pi agent must be able to start other pi agents, fresh or as a fork of its own conversation, on any model, and exchange messages with them. All of this has to hold up under pi reloads, crashes and long autonomous runs. The incumbent `pi-subagents` meets the functional needs, but at around 106k lines, with about 10 ad-hoc file protocols, and a history of lost, duplicated and stale messages and orphaned processes. This package provides a small set of orthogonal primitives instead, modeled on Erlang/OTP.

## Users and scenarios

Example workflow: a coordinator agent delegates parts of a task to child agents. A child might fork frontend and backend implementers on different models, or start a fresh-context reviewer, and escalate decisions to the human only when needed. The primitives must not assume any one workflow shape.

## Use cases

| ID   | Use case                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UC-1 | An agent spawns a **fresh** child with a task, a model, a thinking level and a working directory.                                                                                                                                                                        |
| UC-2 | An agent spawns a **fork** child that inherits its conversation (pi native fork), on a model that may be from a different provider, and optionally in another working directory such as a git worktree.                                                                  |
| UC-3 | [CHANGED] Any agent in a tree **sends** a message to another agent, its parent or the human. Any message can be answered; an answer names the message it replies to (`reply_to`).                                                                                        |
| UC-4 | [CHANGED] Messages, answers, child reports and exit notices are **pushed** into the receiving agent's conversation at safe boundaries, waking it if idle. The model never polls.                                                                                         |
| UC-5 | [CHANGED] Each time a child finishes a run, its final answer is **reported** to its parent. The child stays alive and can be continued with another message until it is stopped. If it ends for any reason, its parent receives exactly one DOWN notice with the reason. |
| UC-6 | An agent **escalates to the human** by calling the address `human` and gets the answer back. This works for headless agents (answered from the root session) and for agents in visible terminal panes (answered in the agent's own pane, with Herdr notified).           |
| UC-7 | [CHANGED] An agent **stops** a descendant: graceful first, then forced.                                                                                                                                                                                                  |
| UC-8 | An agent **resumes** an exited or lost child under the same identity, from that child's session.                                                                                                                                                                         |
| UC-9 | The user **inspects** the tree: agents, parentage, status, mailbox depth and recent events.                                                                                                                                                                              |

## Invariants

| ID     | Invariant                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-1  | [CHANGED] No orphans: once the loss of an agent's parent link is detected, the agent terminates within G + 15 s (G default 60 s; 300 s for the root agent, so a slow root reload does not kill the tree).                                                                                            |
| INV-2  | [CHANGED] Every termination of an agent incarnation produces exactly one DOWN notice to its parent, with a reason from: `normal`, `error`, `killed`, `timeout`, `lost`.                                                                                                                              |
| INV-3  | [CHANGED] Effectively-once: while the receiver lives, every accepted message is delivered at least once, and the receiving agent consumes each message ID at most once. Retries by the sending extension never create a new message. A message the *model* deliberately sends twice is two messages. |
| INV-4  | [CHANGED] FIFO per sender incarnation.                                                                                                                                                                                                                                                               |
| INV-5  | [CHANGED] Two limits, enforced at spawn time by the broker: max nesting depth and total spawn count. A subtree may tighten them but never loosen them.                                                                                                                                               |
| INV-6  | A send or call to an unknown or terminated agent fails immediately. A pending call fails when its target goes DOWN or its deadline passes.                                                                                                                                                           |
| INV-7  | A pi reload of any agent loses no mail, no identity, no children and no pending calls.                                                                                                                                                                                                               |
| INV-8  | [CHANGED] Every payload is bounded: message, result, and mailbox depth and bytes. Mailbox overflow fails the send explicitly. Truncation is explicit, never silent.                                                                                                                                  |
| INV-10 | [NEW] At most one process acts as a given agent incarnation at a time. An inherited environment or a stale connection cannot take over an identity.                                                                                                                                                  |
| INV-9  | Messaging semantics are identical regardless of where an agent runs (headless or terminal pane).                                                                                                                                                                                                     |

## Non-functional requirements

| ID    | Requirement                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| NFR-1 | No runtime dependencies beyond pi's own host packages (`@earendil-works/pi-coding-agent`, `typebox`), all as `*` peers. |
| NFR-2 | Local single machine only.                                                                                              |
| NFR-3 | Every invariant is testable without a model (fake agents against a real broker).                                        |
| NFR-4 | Herdr is optional. Without it, everything works headless.                                                               |
| NFR-5 | Small: core plus adapters under about 2,000 lines of source.                                                            |

## Out of scope

Workflow engines, chains or DAG runners; retries or model fallback inside an agent; cross-machine messaging; a UI beyond one inspection command and the human inbox; and non-pi agents.
