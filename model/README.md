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

The model's `fetch` / `inject` / `persist` / `ack` actions describe the client's mailroom, not a model-facing tool: the client drains (fetches and leases) the available mail into one batch (`batch`), injects it into pi as one stamped entry (`inject`), and acks it once saved (`persist` is the model consuming it).

pi's queues are "one-at-a-time": pi hands the model one queued injection per turn, steers before follow-ups. The model keeps them as one list, `fetched`, whose first `steerLen` items are steers. A follow-up is appended; a steer goes after the queued steers but ahead of every queued follow-up. A message is urgent (`Msg.urgent`, chosen by `send`); a batch holding urgent mail is injected as a steer, otherwise as a follow-up (or as a steer if urgent mail was announced, `urgentOwed`).

At most one injection waits in pi (`mailroom.waiting`, the model's `waiting`: an injected id that is not in the batch and is neither consumed nor reclaimed). While one waits, `fetch` is disabled: mail that arrives meanwhile stays in the broker, unleased, and the next delivery takes all of it, in order, in one batch. So pi's queues never hold two of our live injections (a copy pi kept across an aborted run is already reclaimed, and the context hook hides it once redelivered), and a steer has nothing of ours to overtake. `reclaim` never takes an id in the batch, which is not injected yet. When the client calls `deliver` (urgent mail at once, the rest at the run's last turn or at settle) is not modelled: `fetch` and `inject` may happen at any time.

The incident behind this rule (0.2.8): the client injected each `mail` notification separately, non-urgent ones as follow-ups and urgent ones as steers. Sender bpe-finish's urgent message 2:66 was consumed (acked 12:59:13) before the same sender's earlier, non-urgent 2:54 to 2:65 (acked 13:08 to 13:09), so per-sender FIFO (INV-4) was broken, and the root saw messages up to 14 minutes late. The mutant "client injects each notification separately" removes the `waiting` gate; `urgentAfterQueuedMailTest` fails on it, and without that scenario the delivery simulation finds `fifo` violated. Scenarios `urgentAfterQueuedMailTest` (a non-urgent message waits in pi, so the same sender's urgent one cannot be fetched until it is consumed; both are consumed in send order) and `urgentBatchInOrderTest` (both in one steer batch, in order). Witness `witnessUrgentConsumed`.

Abstractions: pi saves a batch as one entry and drops its queues whole; the model consumes and drops a message at a time, which allows more orderings, not fewer.

Random traces of `step` rarely reach deep delivery orderings: the gate mutant needs about 170,000 traces. `check.sh` and `mutants.py` therefore also simulate `deliveryStep` from `initDelivery`: only the root and one live child, with the delivery actions and their faults. Every such trace is a trace of `step`, so the invariants must hold there too; it catches the gate mutant within a few hundred traces.

## Covered

Lifecycle and DOWN notices, links, depth and spawn limits, sender sequence numbers with retransmit and `seq_gap` resync, leased fetch with client dedupe and deferred ack, pi dropping an injected message and the reclaim that redelivers it, reloads, process crashes, broker crash with effect-free replay plus `recover()`, and forgetting ended agents.

## Sequencing and broker signals (0.2.7)

The 0.2.5 incident: a broker that let one connection's frames overtake each other (op 180 passed an awaiting `spawn{resume}` 179 and got `seq_gap`), and a client that then failed every later op with the same `expected` seq. `legacyBroker` (chosen at init) stands for a 0.2.6 broker in a mixed-version tree: `brokerAcceptAny` may process any frame on the wire, while the current broker processes only the oldest (`brokerAccept`). A frame answered `seq_gap` stays in flight, held (`gapped`), until `clientResend`; `hello` renumbers unapplied frames from `last_seq + 1` (`realign`). Invariants: `appliedOnce`, `appliedInSendOrder`, `noSilentDrop` (every op sent is applied, still in flight, or died with its client), `brokerInOrder` (the current broker never answers `seq_gap` while the expected frame is on that connection) and `noWedge` (with nothing in flight the next seq is the broker's next, and a held head frame is the one the broker waits for).

`brokerSigterm` stops the broker like a crash; `stopTree` and `brokerFinish` model `stop_tree` and the finished-tree shutdown, after which `keeperShutdown` kills any child left. Invariant `noKillWithoutStop`: no Keeper kills its child unless the tree was stopped. Witnesses: `witnessGapRecovered`, `witnessSigtermSurvived`, `witnessTreeFinished`. Mutants reintroduce each 0.2.6 bug (broker reordering, client dropping a `seq_gap` op, both together, SIGTERM as shutdown); all are caught (`noSilentDrop` and `noWedge` catch the client, `brokerInOrder` the broker, `noKillWithoutStop` the signal). `stopTree` counts against `MAX_FAULTS` so random traces still reach deep paths.

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
