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

# model/pi_actors_calls.qnt: calls, answers, identity.
CALLS_MUTANTS = [
    # What src/tree.ts did before this model existed: only an answer removed the question.
    ("question stays listed after a timeout or after its asker ended",
     [("    humanQ: st.humanQ.exclude(Set(c.ref)),\n", ""),
      ("      humanQ: st2.humanQ.exclude(mine.map(c => c.ref)),\n", "")], None),
    ("any agent may reply to a call",
     "if (c.target == id) s' = { ...resolve(s, c, \"answer\")", "if (true) s' = { ...resolve(s, c, \"answer\")"),
    ("any agent may answer for the human",
     "if (id == ROOT or id == c.caller) s' = { ...resolve(s, c, \"answer\")", "if (true) s' = { ...resolve(s, c, \"answer\")"),
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
    ("pi_actors_calls.qnt", CALLS_MUTANTS, os.environ.get("CALLS_SAMPLES", "5000")),
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
            caught = subprocess.run(["npx", "quint", "test", path], capture_output=True, text=True).returncode != 0
            if not caught:
                r = subprocess.run(["npx", "quint", "run", path, "--invariant=all_invariants",
                                    f"--max-samples={samples}", "--max-steps=40"], capture_output=True, text=True)
                caught = r.returncode != 0 and "violation" in (r.stdout + r.stderr).lower()
            print(("caught   " if caught else "SURVIVED ") + f"{model}: {name}")
            survivors += not caught
        finally:
            os.unlink(path)
sys.exit(1 if survivors else 0)
