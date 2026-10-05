# Protocol model

`pi_actors.qnt` is a Quint model of the pi-actors protocol (design v3, D15). `src/tree.ts` mirrors its reducer actions, and `test/tree.property.test.ts` re-implements its invariants.

Run it with `npm run model`. That command:

- runs the scripted scenario tests (`quint test`);
- runs random simulation of `all_invariants`;
- checks that every reachability witness is reached;
- checks that every bug in `mutants.py` is caught.

## Covered

Lifecycle and DOWN notices, links, depth and spawn limits, sender sequence numbers with retransmit, leased fetch with client dedupe and deferred ack, reloads, process crashes, and broker crash with effect-free replay plus `recover()`.

## Not covered (yet)

- calls, replies and the reply reserve;
- resume and incarnations;
- human routing;
- clocks and sleep;
- the identity and pid fence. That one is unit-tested instead, because it is not an interleaving problem.

## Limits of the check

The check is random simulation, not exhaustive. `quint verify` (Apalache) needs Java, which isn't installed on the development machine. Faults are bounded at 2 per trace (`MAX_FAULTS`) so that traces reach deep paths. The mutation suite is the evidence that the invariants have teeth.
