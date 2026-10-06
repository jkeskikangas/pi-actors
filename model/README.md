# Protocol model

Two Quint models of the pi-actors protocol (design v4, D15). Quint is a specification language built on TLA+'s logic.

- `pi_actors.qnt`: message delivery and lifecycle. `src/tree.ts` mirrors its reducer actions, and `test/tree.property.test.ts` re-implements its invariants.
- `pi_actors_calls.qnt`: calls, the human's questions and answers, and identity. Its scenarios are mirrored as Tree unit tests in `test/tree.scenarios.test.ts`.

Run it with `npm run model`. That command:

- runs the scripted scenario tests (`quint test`);
- runs random simulation of `all_invariants`;
- checks that every reachability witness is reached;
- checks that every bug in `mutants.py` is caught.

## Push delivery (design v4)

The model's `fetch` / `persist` / `ack` actions describe the client's mailroom, not a model-facing tool: the client fetches (leases) messages when notified, injects them as one stamped entry (`persist` is that entry being saved), and acks at `turn_end`. So v4's push delivery is covered as is.

## Covered

Lifecycle and DOWN notices, links, depth and spawn limits, sender sequence numbers with retransmit, leased fetch with client dedupe and deferred ack, pi dropping an injected message and the reclaim that redelivers it, reloads, process crashes, and broker crash with effect-free replay plus `recover()`.

## Calls, answers and identity (`pi_actors_calls.qnt`)

Invariants:

- every call ends exactly one way: still pending, one outcome (reply or answer, timeout, target down), or void because its caller ended;
- replies reach the caller only; only a call's target replies, and only the root or the asker answers for the human;
- the human's list holds exactly the questions that can still be answered;
- whoever holds an identity is a live process of the current incarnation that owns it, never a process forked from the root into another session or one that inherited a child's flags;
- the root is never taken over while its previous process lives, and a `pi --continue` of its current session after its process ended is never refused, including after a same-process session switch.

The model found one bug: a question to the human stayed listed after it timed out or its asker ended (answering it then failed with `stale_ref`). Fixed in `src/tree.ts` (`endCall`); its mutant reintroduces the old behaviour.

Message delivery inside a call (seq, leases, dedupe) is abstracted here; `pi_actors.qnt` covers it. This model simulates slowly (about 35 traces a second), so its checks use 5,000 samples (`CALLS_SAMPLES`).

## Not covered

- the reply reserve (mailbox accounting);
- clocks and sleep (timers are modelled as "may fire at any time");
- a stale incarnation's process surviving: resume requires the old process confirmed gone, so the incarnation check in `hello` is defence in depth, unit-tested only.

## Limits of the check

The check is random simulation, not exhaustive. `quint verify` (Apalache) needs Java, which isn't installed on the development machine. Faults are bounded at 2 per trace (`MAX_FAULTS`) so that traces reach deep paths. The mutation suite is the evidence that the invariants have teeth.
