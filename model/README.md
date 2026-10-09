# Protocol model

Two Quint models of the pi-actors protocol (design v4, D15). Quint is a specification language built on TLA+'s logic.

- `pi_actors.qnt`: message delivery and lifecycle. `src/tree.ts` mirrors its reducer actions, and `test/tree.property.test.ts` re-implements its invariants.
- `pi_actors_identity.qnt`: identity, meaning which process may act as which agent. Its scenarios are mirrored as Tree unit tests in `test/tree.scenarios.test.ts`.

Run it with `npm run model`. That command:

- runs the scripted scenario tests (`quint test`);
- runs random simulation of `all_invariants`;
- checks that every reachability witness is reached;
- checks that every bug in `mutants.py` is caught.

## Push delivery (design v4)

The model's `fetch` / `persist` / `ack` actions describe the client's mailroom, not a model-facing tool: the client fetches (leases) messages when notified, injects them as one stamped entry (`persist` is that entry being saved), and acks at `turn_end`. So v4's push delivery is covered as is.

## Covered

Lifecycle and DOWN notices, links, depth and spawn limits, sender sequence numbers with retransmit, leased fetch with client dedupe and deferred ack, pi dropping an injected message and the reclaim that redelivers it, reloads, process crashes, broker crash with effect-free replay plus `recover()`, and forgetting ended agents.

## Forget

`forget{target}` removes an ended agent and its ended subtree from the tree, so the panel stops listing it. Only a strict ancestor may forget, and only once the target and every agent below it are down. The forgotten agents' mailboxes, leases and sequence tracking go with them; DOWN notices already queued for their parent stay. A forgotten id is never spawned again, a hello claiming it is refused, and mail sent to it is refused (`unknown_target`), including a frame accepted only after the forget. While the target's parent still runs, only that parent may forget it, because the parent may still resume the child; once the parent has ended, any active ancestor may. Invariants: `forgetsOnlyDown`, `forgottenStaysGone`, `forgottenHoldsNothing`, `noForgetUnderRunningParent` (no one but a running parent forgets its child), and `endedIsClearable` (never stuck: an ended, settled agent whose parent has ended or still runs can always be forgotten by some active ancestor, unless none is left because the tree is winding down). Witness `witnessClearedAfterParentKilled` reaches a child that ended while its parent ran, whose parent was then killed, and which the root then cleared. Two mutants pin the rule from both sides: without the guard (`noForgetUnderRunningParent` catches it), and with only the parent ever allowed (`endedIsClearable` catches it). `atLeastOnce` exempts mail a forgotten receiver never read: that mail is discarded with the receiver, deliberately.

The model found one bug while forget was being added: a send in flight when the receiver was forgotten was still queued into the forgotten agent's mailbox. Fixed by treating a forgotten target as unknown; its mutant reintroduces the old behaviour.

## Identity (`pi_actors_identity.qnt`)

Invariants:

- whoever holds an identity is a live process of the current incarnation that owns it, never a process forked from the root into another session or one that inherited a child's flags;
- the root is never taken over while its previous process lives, and a `pi --continue` of its current session after its process ended is never refused, including after a same-process session switch.

Messages (seq, leases, dedupe) are abstracted here; `pi_actors.qnt` covers them. This model simulates more slowly, so its checks use 5,000 samples (`IDENTITY_SAMPLES`).

## Not covered

- the reply reserve (mailbox accounting);
- clocks and sleep (timers are modelled as "may fire at any time");
- a stale incarnation's process surviving: resume requires the old process confirmed gone, so the incarnation check in `hello` is defence in depth, unit-tested only.

## Limits of the check

The check is random simulation, not exhaustive. `quint verify` (Apalache) needs Java, which isn't installed on the development machine. Faults are bounded at 2 per trace (`MAX_FAULTS`) so that traces reach deep paths. The mutation suite is the evidence that the invariants have teeth.
