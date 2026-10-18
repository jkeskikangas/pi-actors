#!/usr/bin/env python3
"""Inject known protocol bugs into the models; every one must be caught by all_invariants.

A mutant that survives means the invariants (and therefore Tree's property tests) are too weak.
"""
import os, subprocess, sys, tempfile

MUTANTS = [
    ("ack-before-persist (S1)",
     "s.pendingAck.get(id).size() > 0,\n    nondet mid = s.pendingAck.get(id).oneOf()",
     "s.leases.get(id).size() > 0,\n    nondet mid = s.leases.get(id).oneOf()"),
    # Duplicate delivery has three independent guards: the broker's lease, the client's dedupe at
    # fetch (persisted or in flight), and the context hook at consumption (N1). Each mutant that
    # breaks an earlier guard also removes the context hook, or the hook would mask it.
    ("no-lease and no in-flight dedupe: parallel receives consume the same message (S2)",
     [(".select(m => not(s.leases.get(id).contains(m.uid)))", ".select(m => true)"),
      ("if (seen or inFlight) s.batch", "if (seen) s.batch"), ("if (seen or inFlight) s.injected", "if (seen) s.injected"),
      ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("no-link: parent DOWN does not kill children (INV-1)",
     "    killChildren(st2, id)\n", "    st2\n"),
    ("no-seq-resync after reload: fresh frames look like duplicates (R2)",
     "nextSeq: s.nextSeq.set(id, s.lastSeq.get(id) + 1 + unapplied(s.inflight.get(id), s.lastSeq.get(id)).length()),",
     "nextSeq: s.nextSeq,"),
    # The 0.2.5 incident, one bug at a time and together.
    ("broker lets one connection's frames overtake each other (0.2.6 onFrame not chained)",
     "    i == 0 or st.legacyBroker,\n", "    true,\n"),
    ("client drops an op answered seq_gap and never resyncs (0.2.6 client)",
     "    gapped: st.gapped.setBy(src, g => g.union(Set(m.uid))),\n    reorderGap:",
     "    inflight: st.inflight.setBy(src, l => l.select(x => x.uid != m.uid)),\n    reorderGap:"),
    ("0.2.6 broker and client together: op 180 overtakes 179, is refused and every later op wedges",
     [("    i == 0 or st.legacyBroker,\n", "    true,\n"),
      ("    gapped: st.gapped.setBy(src, g => g.union(Set(m.uid))),\n    reorderGap:",
       "    inflight: st.inflight.setBy(src, l => l.select(x => x.uid != m.uid)),\n    reorderGap:")], None),
    ("broker SIGTERM is a tree shutdown: Keepers kill live agents (0.2.6 main.ts)",
     "sigtermed: true },", "sigtermed: true, shutdownSent: true },"),
    ("no-client-dedupe: redelivery after reload is consumed again (INV-3)",
     [("val seen = s.persisted.get(id).contains(m.uid)", "val seen = false"), ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("reclaim-too-early: reclaiming an injection that pi still holds delivers it twice (F4)",
     [("val gone = s.injected.get(id).filter(u => not(inPi(s, id, u)))",
       "val gone = s.injected.get(id)"), ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("no-in-flight-dedupe: a delivery in flight across a broker restart is consumed twice",
     [("if (seen or inFlight) s.batch", "if (seen) s.batch"), ("if (seen or inFlight) s.injected", "if (seen) s.injected"),
      ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    # The 0.2.8 incident: every notification its own injection, so an urgent steer overtook the
    # same sender's older mail still queued in pi as a follow-up (INV-4, fifo).
    ("client injects each notification separately (0.2.8): an urgent steer overtakes queued older mail",
     "    not(waiting(st, id)),\n", "    true,\n"),
    ("no-context-dedupe: pi keeps an injection that reclaim also redelivered; the model sees it twice (N1)",
     "val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false"),
    ("forget while a descendant is still ending: an active agent loses its parent's record",
     "status(st, x) == Down or status(st, x) == Unborn or status(st, x) == Gone),", "true),"),
    ("forget an agent that has not ended",
     "    status(st, t) == Down,\n    AGENTS.filter", "    status(st, t) != Unborn and status(st, t) != Gone,\n    AGENTS.filter"),
    ("a forgotten id is spawned again",
     "    status(st, c) == Unborn,\n", "    (status(st, c) == Unborn or status(st, c) == Gone),\n"),
    ("mail to a forgotten agent is still queued",
     "x != Down and x != Unborn and x != Gone", "x != Down and x != Unborn"),
    ("parent-only clear removed: the root forgets a running parent's ended child",
     "par == p or status(st, par) == Down or status(st, par) == Gone", "true"),
    ("parent-only clear over-restricted: only the parent ever forgets, so a dead parent's child is stuck",
     "par == p or status(st, par) == Down or status(st, par) == Gone", "par == p"),
    ("forget keeps the forgotten agent's mailbox",
     "mailbox: s.mailbox.keys().mapBy(x => if (gone.contains(x)) List() else s.mailbox.get(x)),\n      leases", "leases"),
]

# model/pi_actors_identity.qnt: which process may act as which agent.
IDENTITY_MUTANTS = [
    ("no session rebind on a same-process switch: --continue locked out (N4)",
     "rootSession: if (a == ROOT and reloadOrFirst) p.session else s.rootSession,", "rootSession: s.rootSession,"),
    ("root takeover while the recorded process still lives",
     "val takeover = s.rootSession == p.session and not(isAlive(s, recorded))", "val takeover = s.rootSession == p.session"),
    ("root takeover from any session (a fork takes the tree)",
     "val takeover = s.rootSession == p.session and not(isAlive(s, recorded))", "val takeover = not(isAlive(s, recorded))"),
    ("a process with inherited flags takes a child's identity",
     "(p.inc == s.inc.get(a) and p.owns)", "(p.inc == s.inc.get(a))"),
]

here = os.path.dirname(__file__) or "."
survivors = 0
for model, mutants, samples in [
    ("pi_actors.qnt", MUTANTS, os.environ.get("SAMPLES", "20000")),
    ("pi_actors_identity.qnt", IDENTITY_MUTANTS, os.environ.get("IDENTITY_SAMPLES", "5000")),
]:
    src = open(os.path.join(here, model)).read()
    for name, old, new in mutants:
        edits = old if isinstance(old, list) else [(old, new)]
        mutated = src
        for a, b in edits:
            assert mutated.count(a) == 1, f"mutation anchor not unique/missing: {name}: {a}"
            mutated = mutated.replace(a, b)
        with tempfile.NamedTemporaryFile("w", suffix=".qnt", dir=here, delete=False) as f:
            f.write(mutated); path = f.name
        try:
            by = "scenario" if subprocess.run(["npx", "quint", "test", path], capture_output=True, text=True).returncode != 0 else None
            # Random simulation; for pi_actors.qnt also the focused delivery simulation.
            sims = [("simulation", [])] + ([("delivery simulation", ["--init=initDelivery", "--step=deliveryStep"])] if model == "pi_actors.qnt" else [])
            for label, extra in sims:
                if by:
                    break
                r = subprocess.run(["npx", "quint", "run", path, "--invariant=all_invariants", *extra,
                                    f"--max-samples={samples}", "--max-steps=40"], capture_output=True, text=True)
                if r.returncode != 0 and "violation" in (r.stdout + r.stderr).lower():
                    by = label
            caught = by is not None
            print((f"caught   ({by}) " if caught else "SURVIVED ") + f"{model}: {name}")
            survivors += not caught
        finally:
            os.unlink(path)
sys.exit(1 if survivors else 0)
