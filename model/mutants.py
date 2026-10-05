#!/usr/bin/env python3
"""Inject known protocol bugs into the model; every one must be caught by all_invariants.

A mutant that survives means the invariants (and therefore Tree's property tests) are too weak.
"""
import os, subprocess, sys, tempfile

MUTANTS = [
    ("ack-before-persist (S1)",
     "s.pendingAck.get(id).size() > 0,\n    nondet mid = s.pendingAck.get(id).oneOf()",
     "s.leases.get(id).size() > 0,\n    nondet mid = s.leases.get(id).oneOf()"),
    ("no-lease: parallel receives fetch the same message (S2)",
     ".select(m => not(s.leases.get(id).contains(m.uid)))",
     ".select(m => true)"),
    ("no-link: parent DOWN does not kill children (INV-1)",
     "    killChildren(st2, id)\n", "    st2\n"),
    ("no-seq-resync after reload: fresh frames look like duplicates (R2)",
     "nextSeq: if (s.inflight.get(id).length() == 0) s.nextSeq.set(id, s.lastSeq.get(id) + 1) else s.nextSeq,",
     "nextSeq: s.nextSeq,"),
    ("no-client-dedupe: redelivery after reload is consumed again (INV-3)",
     "val seen = s.persisted.get(id).contains(m.uid)", "val seen = false"),
]

src = open(os.path.join(os.path.dirname(__file__), "pi_actors.qnt")).read()
samples = os.environ.get("SAMPLES", "20000")
survivors = 0
for name, old, new in MUTANTS:
    assert src.count(old) == 1, f"mutation anchor not unique/missing: {name}"
    with tempfile.NamedTemporaryFile("w", suffix=".qnt", dir=os.path.dirname(__file__) or ".", delete=False) as f:
        f.write(src.replace(old, new)); path = f.name
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
