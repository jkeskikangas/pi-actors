# pi-actors — Spec

**Status:** draft, derived from the design discussion of 2026-10-05 (pi-subagents review, herdr evaluation, OTP lessons). Needs user review.

## Problem

A pi agent must be able to start other pi agents, fresh or as a fork of its own conversation, on any model, and exchange messages with them. All of this has to hold up under pi reloads, crashes and long autonomous runs. The incumbent `pi-subagents` meets the functional needs, but at around 106k lines, with about 10 ad-hoc file protocols, and a history of lost, duplicated and stale messages and orphaned processes. This package provides a small set of orthogonal primitives instead, modeled on Erlang/OTP.

## Users and scenarios

Primary workflow: a coordinator works through a backlog. For each item it starts an agent, which designs the feature, forks frontend and backend agents on different models, starts a fresh-context reviewer, and escalates decisions to the human only when needed.

## Use cases

| ID   | Use case                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-1 | An agent spawns a **fresh** child with a task, a model, a thinking level and a working directory.                                                                                                                                                              |
| UC-2 | An agent spawns a **fork** child that inherits its conversation (pi native fork), on a model that may be from a different provider, and optionally in another working directory such as a git worktree.                                                        |
| UC-3 | Any agent in a tree **sends** a one-way message, or **calls** another agent with a request and a deadline. The reply is correlated by a reference.                                                                                                             |
| UC-4 | An agent **receives** its next message matching an optional filter (sender, tag), with a timeout. An idle agent is woken when mail arrives.                                                                                                                    |
| UC-5 | A child **exits** with a result. Its parent receives exactly one DOWN notice carrying the exit reason and the result.                                                                                                                                          |
| UC-6 | An agent **escalates to the human** by calling the address `human` and gets the answer back. This works for headless agents (answered from the root session) and for agents in visible terminal panes (answered in the agent's own pane, with Herdr notified). |
| UC-7 | An agent **kills** a child: graceful first, then forced.                                                                                                                                                                                                       |
| UC-8 | An agent **resumes** an exited or lost child under the same identity, from that child's session.                                                                                                                                                               |
| UC-9 | The user **inspects** the tree: agents, parentage, status, mailbox depth and recent events.                                                                                                                                                                    |

## Invariants

| ID    | Invariant                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-1 | No orphans: an agent whose parent link is lost terminates within grace period G (default 60 s).                                                               |
| INV-2 | Every child termination produces exactly one DOWN notice to its parent, with a reason from: `normal`, `error`, `killed`, `timeout`, `lost`.                   |
| INV-3 | Effectively-once: while the receiver lives, every accepted message is delivered at least once, and the receiving agent consumes each message ID at most once. |
| INV-4 | FIFO per (sender, receiver) pair.                                                                                                                             |
| INV-5 | Limits (depth, spawn budget, concurrent children) are enforced at spawn time by the broker, and a child's limits are never looser than its parent's.          |
| INV-6 | A send or call to an unknown or terminated agent fails immediately. A pending call fails when its target goes DOWN or its deadline passes.                    |
| INV-7 | A pi reload of any agent loses no mail, no identity, no children and no pending calls.                                                                        |
| INV-8 | Every payload is bounded (message, result, mailbox). Truncation is explicit, never silent.                                                                    |
| INV-9 | Messaging semantics are identical regardless of where an agent runs (headless or terminal pane).                                                              |

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
