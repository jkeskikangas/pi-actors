#!/usr/bin/env python3
"""Inject known protocol bugs into the model; every one must be caught by all_invariants.

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
      ("if (seen or inFlight) s.fetched", "if (seen) s.fetched"), ("if (seen or inFlight) s.injected", "if (seen) s.injected"),
      ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("no-link: parent DOWN does not kill children (INV-1)",
     "    killChildren(st2, id)\n", "    st2\n"),
    ("no-seq-resync after reload: fresh frames look like duplicates (R2)",
     "nextSeq: if (s.inflight.get(id).length() == 0) s.nextSeq.set(id, s.lastSeq.get(id) + 1) else s.nextSeq,",
     "nextSeq: s.nextSeq,"),
    ("no-client-dedupe: redelivery after reload is consumed again (INV-3)",
     [("val seen = s.persisted.get(id).contains(m.uid)", "val seen = false"), ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("reclaim-too-early: reclaiming an injection that pi still holds delivers it twice (F4)",
     [("val gone = s.injected.get(id).filter(u => s.fetched.get(id).select(m => m.uid == u).length() == 0)",
       "val gone = s.injected.get(id)"), ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("no-in-flight-dedupe: a delivery in flight across a broker restart is consumed twice",
     [("if (seen or inFlight) s.fetched", "if (seen) s.fetched"), ("if (seen or inFlight) s.injected", "if (seen) s.injected"),
      ("val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false")], None),
    ("no-context-dedupe: pi keeps an injection that reclaim also redelivered; the model sees it twice (N1)",
     "val hidden = st.persisted.get(id).contains(m.uid)", "val hidden = false"),
]

src = open(os.path.join(os.path.dirname(__file__), "pi_actors.qnt")).read()
samples = os.environ.get("SAMPLES", "20000")
survivors = 0
for name, old, new in MUTANTS:
    edits = old if isinstance(old, list) else [(old, new)]
    mutated = src
    for a, b in edits:
        assert mutated.count(a) == 1, f"mutation anchor not unique/missing: {name}: {a}"
        mutated = mutated.replace(a, b)
    with tempfile.NamedTemporaryFile("w", suffix=".qnt", dir=os.path.dirname(__file__) or ".", delete=False) as f:
        f.write(mutated); path = f.name
    try:
        t = subprocess.run(["npx", "quint", "test", path], capture_output=True, text=True)
        r = subprocess.run(["npx", "quint", "run", path, "--invariant=all_invariants",
                            f"--max-samples={samples}", "--max-steps=40"], capture_output=True, text=True)
        caught = t.returncode != 0 or (r.returncode != 0 and "violation" in (r.stdout + r.stderr).lower())
        print(("caught   " if caught else "SURVIVED ") + name)
        survivors += not caught
    finally:
        os.unlink(path)
sys.exit(1 if survivors else 0)
