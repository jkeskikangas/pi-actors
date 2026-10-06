// pi-actors calls, answers and identity (design v4, D15). A companion to pi_actors.qnt.
//
// Scope: calls between agents and to the human, with their three outcomes (reply or answer,
// timeout, target down); who may answer; the human's question list; and identity: which
// process may act as an agent incarnation (pid ownership, incarnations after resume, the
// root's pid and session fence, same-process session switches, `--continue` takeover).
// Message delivery itself (seq, leases, dedupe) is pi_actors.qnt's job and is abstracted here:
// a reply is queued in the caller's mailbox, durable, and consumed by whoever holds the caller.
//
// Each action mirrors a Tree reducer event or an environment event; src/tree.ts implements them.
module pi_actors_calls {
  type Status = Live | Disconnected | Down
  type Call = { ref: int, caller: str, inc: int, target: str }
  type Reply = { ref: int, kind: str }
  // A process that may say hello as `id` (its flags or its session say so).
  type Proc = { id: str, inc: int, session: int, owns: bool, alive: bool }

  type State = {
    // --- broker (durable: the log) ---
    status: str -> Status,
    inc: str -> int,
    agentPid: str -> int,       // last accepted pid (0: none yet)
    rootSession: int,           // the root's session as the broker knows it
    holder: str -> int,         // pid of the current connection (0: none)
    pending: Set[Call],
    mailbox: str -> List[Reply],
    humanQ: Set[int],           // the questions listed for the human (mailbox[human])
    resumes: int,
    // --- processes (environment) ---
    procs: int -> Proc,
    nextPid: int,
    nextSession: int,
    nextRef: int,
    // --- observation only ---
    made: Set[Call],
    replies: int -> int,        // outcomes delivered per ref
    voided: Set[int],           // calls dropped because their caller ended
    lastRootSession: int,       // the session of the last accepted root hello
    forkSessions: Set[int],     // sessions created by forking the root into a new process
    misrouted: bool,            // a reply or answer from someone not allowed to give it
    stolen: bool,               // the root taken over while its previous process still lived
    lockedOut: bool,            // a legitimate `--continue` of the root's session refused
    faults: int,
    rootEnds: int,              // separate budget, so the takeover paths stay reachable
  }

  pure val HUMAN = "h"
  pure val ROOT = "r"
  pure val AGENTS = Set("r", "a", "b")
  pure val PARENT = Map("r" -> "", "a" -> "r", "b" -> "r")
  pure val MAX_REFS = 4
  pure val MAX_PROCS = 10
  pure val MAX_RESUMES = 1
  pure val MAX_FAULTS = 3

  var s: State

  pure def proc(st: State, pid: int): Proc = st.procs.get(pid)
  pure def isAlive(st: State, pid: int): bool = pid != 0 and proc(st, pid).alive
  // The process connected as `id`, acting now.
  pure def acting(st: State, pid: int): bool = all {
    proc(st, pid).alive,
    val id = proc(st, pid).id
    st.holder.get(id) == pid and st.status.get(id) == Live,
  }

  action init = s' = {
    status: Map("r" -> Live, "a" -> Live, "b" -> Live),
    inc: Map("r" -> 1, "a" -> 1, "b" -> 1),
    agentPid: Map("r" -> 1, "a" -> 2, "b" -> 3),
    rootSession: 1,
    holder: Map("r" -> 1, "a" -> 2, "b" -> 3),
    pending: Set(),
    mailbox: Map("r" -> List(), "a" -> List(), "b" -> List()),
    humanQ: Set(),
    resumes: 0,
    // Every pid slot exists up front (unused ones are dead), which keeps simulation fast.
    procs: 0.to(MAX_PROCS).mapBy(pid =>
      if (pid == 1) { id: "r", inc: 1, session: 1, owns: true, alive: true }
      else if (pid == 2) { id: "a", inc: 1, session: 2, owns: true, alive: true }
      else if (pid == 3) { id: "b", inc: 1, session: 3, owns: true, alive: true }
      else { id: "", inc: 0, session: 0, owns: false, alive: false }),
    nextPid: 4,
    nextSession: 4,
    nextRef: 0,
    made: Set(),
    replies: Map(),
    voided: Set(),
    lastRootSession: 1,
    forkSessions: Set(),
    misrouted: false,
    stolen: false,
    lockedOut: false,
    faults: 0,
    rootEnds: 0,
  }

  // ---------------- call outcomes (Tree: deliverReply, answer, goDown, tick) ----------------

  // One outcome for a pending call: it leaves `pending`, its question leaves the human's list,
  // and the reply is queued for the caller unless the caller has ended.
  pure def resolve(st: State, c: Call, kind: str): State = { ...st,
    pending: st.pending.exclude(Set(c)),
    humanQ: st.humanQ.exclude(Set(c.ref)),
    mailbox: if (st.status.get(c.caller) == Down) st.mailbox else st.mailbox.setBy(c.caller, l => l.append({ ref: c.ref, kind: kind })),
    replies: st.replies.put(c.ref, (if (st.replies.keys().contains(c.ref)) st.replies.get(c.ref) else 0) + 1),
  }

  // Entering Down: calls to it fail for their callers; calls it made are void (their questions
  // are withdrawn); a down root fails every question to the human; the link rule ends children.
  pure def goDown1(st: State, id: str): State = {
    val st1 = { ...st,
      status: st.status.set(id, Down),
      holder: st.holder.set(id, 0),
      procs: if (st.agentPid.get(id) != 0) st.procs.setBy(st.agentPid.get(id), p => { ...p, alive: false }) else st.procs,
    }
    val failed = st1.pending.filter(c => c.target == id or (id == ROOT and c.target == HUMAN))
    val st2 = failed.fold(st1, (acc, c) => resolve(acc, c, "down"))
    val mine = st2.pending.filter(c => c.caller == id)
    { ...st2,
      pending: st2.pending.exclude(mine),
      humanQ: st2.humanQ.exclude(mine.map(c => c.ref)),
      voided: st2.voided.union(mine.map(c => c.ref)),
    }
  }
  pure def goDown(st: State, id: str): State = {
    val st1 = goDown1(st, id)
    AGENTS.filter(c => PARENT.get(c) == id and st1.status.get(c) != Down).fold(st1, (acc, c) => goDown1(acc, c))
  }

  // ---------------- agent operations ----------------

  action call(pid: int, target: str): bool = all {
    acting(s, pid),
    s.nextRef < MAX_REFS,
    val id = proc(s, pid).id
    all {
      target != id,
      target == HUMAN or (AGENTS.contains(target) and s.status.get(target) != Down),
      val c = { ref: s.nextRef, caller: id, inc: s.inc.get(id), target: target }
      s' = { ...s,
        pending: s.pending.union(Set(c)),
        made: s.made.union(Set(c)),
        humanQ: if (target == HUMAN) s.humanQ.union(Set(c.ref)) else s.humanQ,
        nextRef: s.nextRef + 1,
      },
    },
  }

  // send{kind: reply}: only the call's target may reply (else not_authorized).
  action reply(pid: int, ref: int): bool = all {
    acting(s, pid),
    s.pending.exists(c => c.ref == ref),
    val c = s.pending.filter(c => c.ref == ref).getOnlyElement()
    val id = proc(s, pid).id
    all {
      c.target != HUMAN,
      if (c.target == id) s' = { ...resolve(s, c, "answer"), misrouted: s.misrouted or c.target != id }
      else s' = s,
    },
  }

  // answer: a question to the human is answered from the root's panel or the asker's own pane.
  action answer(pid: int, ref: int): bool = all {
    acting(s, pid),
    s.pending.exists(c => c.ref == ref),
    val c = s.pending.filter(c => c.ref == ref).getOnlyElement()
    val id = proc(s, pid).id
    all {
      c.target == HUMAN,
      if (id == ROOT or id == c.caller) s' = { ...resolve(s, c, "answer"), misrouted: s.misrouted or not(id == ROOT or id == c.caller) }
      else s' = s,
    },
  }

  // The caller reads a reply (any process holding the caller's identity may).
  action consume(pid: int): bool = all {
    acting(s, pid),
    val id = proc(s, pid).id
    all {
      s.mailbox.get(id).length() > 0,
      s' = { ...s, mailbox: s.mailbox.setBy(id, l => l.tail()) },
    },
  }

  // ---------------- broker timers ----------------

  action timeout(ref: int): bool = all {
    s.pending.exists(c => c.ref == ref),
    s' = resolve(s, s.pending.filter(c => c.ref == ref).getOnlyElement(), "timeout"),
  }

  // A child's process ends (exit, kill, crash): procExit, then Down.
  action childEnds(id: str): bool = all {
    id != ROOT, s.status.get(id) != Down,
    s' = goDown(s, id),
  }

  // The root's grace period runs out while no process holds it.
  action rootGraceExpires: bool = all {
    s.status.get(ROOT) == Disconnected,
    s' = goDown(s, ROOT),
  }

  // Resume: the parent restarts a down child under the same id, as a new incarnation, once its
  // old process is confirmed gone. The broker starts the new process.
  action resume(id: str): bool = all {
    id != ROOT, s.status.get(id) == Down, s.status.get(PARENT.get(id)) == Live,
    s.resumes < MAX_RESUMES, s.nextPid < MAX_PROCS,
    not(isAlive(s, s.agentPid.get(id))),
    val pid = s.nextPid
    val n = s.inc.get(id) + 1
    s' = { ...s,
      status: s.status.set(id, Disconnected),
      inc: s.inc.set(id, n),
      agentPid: s.agentPid.set(id, pid),
      procs: s.procs.set(pid, { id: id, inc: n, session: s.nextSession, owns: true, alive: true }),
      nextPid: pid + 1,
      nextSession: s.nextSession + 1,
      resumes: s.resumes + 1,
    },
  }

  // ---------------- identity: hello (Tree: hello) ----------------

  action hello(pid: int): bool = all {
    isAlive(s, pid),
    val p = proc(s, pid)
    val a = p.id
    all {
      s.holder.get(a) != pid,
      s.status.get(a) != Down,
      val recorded = s.agentPid.get(a)
      val reloadOrFirst = recorded == 0 or recorded == pid
      val takeover = s.rootSession == p.session and not(isAlive(s, recorded))
      val ok = if (a == ROOT) (reloadOrFirst or takeover) else (p.inc == s.inc.get(a) and p.owns)
      // A `--continue` of the root's current session after its process died must get in.
      val legitContinue = a == ROOT and p.session == s.lastRootSession and not(isAlive(s, recorded))
      if (ok) {
        val old = s.holder.get(a)
        s' = { ...s,
          holder: s.holder.set(a, pid),
          agentPid: s.agentPid.set(a, pid),
          status: s.status.set(a, Live),
          // The same process may have switched sessions: the root now lives in that one (N4).
          rootSession: if (a == ROOT and reloadOrFirst) p.session else s.rootSession,
          lastRootSession: if (a == ROOT) p.session else s.lastRootSession,
          stolen: s.stolen or (a == ROOT and recorded != 0 and recorded != pid and isAlive(s, recorded)),
        }
      } else s' = { ...s, lockedOut: s.lockedOut or legitContinue },
    },
  }

  // ---------------- environment ----------------

  // A process started from the agent's shell inherits its flags, but does not own the pid the
  // broker recorded (the Keeper or pane check fails it).
  action inheritEnv(pid: int): bool = all {
    isAlive(s, pid), s.nextPid < MAX_PROCS, s.faults < MAX_FAULTS,
    val p = proc(s, pid)
    s' = { ...s,
      procs: s.procs.set(s.nextPid, { ...p, owns: false, session: s.nextSession }),
      nextPid: s.nextPid + 1, nextSession: s.nextSession + 1, faults: s.faults + 1,
    },
  }

  // The root process switches session (/new, /resume, /fork in place): same pid, new session,
  // the extension runtime is replaced, so the connection drops and it says hello again.
  action rootSwitchesSession(pid: int): bool = all {
    isAlive(s, pid), proc(s, pid).id == ROOT,
    s.nextSession < 20,
    s' = { ...s,
      procs: s.procs.setBy(pid, p => { ...p, session: s.nextSession }),
      nextSession: s.nextSession + 1,
      holder: if (s.holder.get(ROOT) == pid) s.holder.set(ROOT, 0) else s.holder,
      status: if (s.holder.get(ROOT) == pid and s.status.get(ROOT) == Live) s.status.set(ROOT, Disconnected) else s.status,
    },
  }

  // `pi --fork <root session>` in another terminal: a new process in a new session that still
  // names this tree.
  action rootForked(pid: int): bool = all {
    isAlive(s, pid), proc(s, pid).id == ROOT, s.nextPid < MAX_PROCS,
    s' = { ...s,
      procs: s.procs.set(s.nextPid, { id: ROOT, inc: 1, session: s.nextSession, owns: true, alive: true }),
      forkSessions: s.forkSessions.union(Set(s.nextSession)),
      nextPid: s.nextPid + 1, nextSession: s.nextSession + 1,
    },
  }

  // `pi --continue` of a session some root process has (or had): a new process in that session.
  action rootContinued(src: int): bool = all {
    s.nextPid < MAX_PROCS,
    proc(s, src).id == ROOT,
    not(s.forkSessions.contains(proc(s, src).session)),
    s' = { ...s,
      procs: s.procs.set(s.nextPid, { id: ROOT, inc: 1, session: proc(s, src).session, owns: true, alive: true }),
      nextPid: s.nextPid + 1,
    },
  }

  // A root process ends (quit or crash). Its connection drops; the tree waits out the grace.
  action rootProcessEnds(pid: int): bool = all {
    isAlive(s, pid), proc(s, pid).id == ROOT, s.rootEnds < 2,
    s' = { ...s,
      procs: s.procs.setBy(pid, p => { ...p, alive: false }),
      holder: if (s.holder.get(ROOT) == pid) s.holder.set(ROOT, 0) else s.holder,
      status: if (s.holder.get(ROOT) == pid and s.status.get(ROOT) == Live) s.status.set(ROOT, Disconnected) else s.status,
      rootEnds: s.rootEnds + 1,
    },
  }

  // A reload or dropped connection: identity, mail and pending calls stay (INV-7).
  action connectionDrops(id: str): bool = all {
    s.holder.get(id) != 0, s.status.get(id) == Live, s.faults < MAX_FAULTS,
    s' = { ...s, holder: s.holder.set(id, 0), status: s.status.set(id, Disconnected), faults: s.faults + 1 },
  }

  action step = {
    nondet pid = 1.to(s.nextPid - 1).oneOf()
    nondet id = AGENTS.oneOf()
    nondet target = Set("r", "a", "b", "h").oneOf()
    nondet ref = 0.to(MAX_REFS - 1).oneOf()
    any {
      call(pid, target), reply(pid, ref), answer(pid, ref), consume(pid), timeout(ref),
      childEnds(id), rootGraceExpires, resume(id), hello(pid),
      inheritEnv(pid), rootSwitchesSession(pid), rootForked(pid), rootContinued(pid),
      rootProcessEnds(pid), connectionDrops(id),
    }
  }

  // ---------------- invariants ----------------

  // INV-6 / UC-6: every call ends in exactly one way: still pending, one outcome delivered, or
  // void because its caller ended. Never two outcomes.
  val oneOutcome = s.made.forall(c => {
    val n = if (s.replies.keys().contains(c.ref)) s.replies.get(c.ref) else 0
    n <= 1 and (if (s.pending.contains(c)) 1 else 0) + n + (if (s.voided.contains(c.ref)) 1 else 0) == 1
  })
  // Replies go to the caller and only to it.
  val repliesToCaller = AGENTS.forall(id => s.mailbox.get(id).foldl(true, (ok, r) =>
    ok and s.made.exists(c => c.ref == r.ref and c.caller == id)))
  // The human sees exactly the questions that can still be answered.
  val humanListIsLive = s.humanQ == s.pending.filter(c => c.target == HUMAN).map(c => c.ref)
  // Only a call's target replies; only the root or the asker answers for the human.
  val noMisroute = not(s.misrouted)
  // INV-10: whoever holds an identity is a live process of that incarnation that owns it, and
  // never a process forked from the root into another session.
  val holdersLegit = AGENTS.forall(id => s.holder.get(id) == 0 or {
    val p = proc(s, s.holder.get(id))
    p.alive and p.id == id and p.inc == s.inc.get(id) and p.owns and not(s.forkSessions.contains(p.session))
  })
  // The root is never taken over while its previous process is alive.
  val rootNotStolen = not(s.stolen)
  // ...and a `--continue` of its current session, after its process ended, is never refused.
  val continueAccepted = not(s.lockedOut)

  val all_invariants = oneOutcome and repliesToCaller and humanListIsLive and noMisroute
    and holdersLegit and rootNotStolen and continueAccepted

  // ---------------- reachability witnesses (each MUST be violated by simulation) ----------------
  val witnessHumanAnswered = s.made.forall(c => c.target != HUMAN or not(s.replies.keys().contains(c.ref)) or s.pending.contains(c))
  val witnessTimedOut = s.made.forall(c => not(s.replies.keys().contains(c.ref)))
  val witnessVoided = s.voided.size() == 0
  val witnessResumed = s.resumes == 0
  val witnessTakeover = not(s.holder.get(ROOT) > 3 and proc(s, s.holder.get(ROOT)).session == 1)
  // Deep (switch, hello, crash, continue, hello) and the root's grace may end the tree at any
  // step, so random simulation reaches it only sometimes: switchThenContinueTest covers it.
  val witnessSwitchedThenContinued = not(1.to(MAX_PROCS).exists(q => q > 3 and proc(s, q).id == ROOT and s.holder.get(ROOT) == q and proc(s, q).session != 1))

  // ---------------- scenarios ----------------

  // A question times out: it leaves the human's list, the asker gets one timeout reply.
  run questionTimesOutTest =
    init.then(call(2, "h")).then(timeout(0))
      .then(all { assert(s.humanQ.size() == 0 and s.mailbox.get("a").length() == 1 and all_invariants), s' = s })

  // The asker ends: its question is withdrawn and cannot be answered any more.
  run askerEndsTest =
    init.then(call(2, "h")).then(childEnds("a"))
      .then(all { assert(s.humanQ.size() == 0 and s.pending.size() == 0 and all_invariants), s' = s })

  // An answer races the timeout: whichever comes first wins; the other is refused.
  run answerThenTimeoutTest =
    init.then(call(3, "h")).then(answer(3, 0))
      .then(all { assert(s.pending.size() == 0 and s.mailbox.get("b").length() == 1 and all_invariants), s' = s })

  // N4: the root switches session in the same process, then crashes; `pi --continue` of the new
  // session takes the tree over.
  run switchThenContinueTest =
    init.then(rootSwitchesSession(1)).then(hello(1)).then(rootProcessEnds(1)).then(rootContinued(1)).then(hello(4))
      .then(all { assert(s.holder.get("r") == 4 and all_invariants), s' = s })

  // A fork of the root session in another process is refused; so is a continue while the root lives.
  run forkAndLiveContinueRefusedTest =
    init.then(rootForked(1)).then(hello(4))
      .then(all { assert(s.holder.get("r") == 1), s' = s })
      .then(rootContinued(1)).then(hello(5))
      .then(all { assert(s.holder.get("r") == 1 and all_invariants), s' = s })

  // A process inheriting a child's flags cannot take the child's identity; after a resume, the
  // old incarnation's leftovers cannot either.
  run inheritedAndStaleRefusedTest =
    init.then(inheritEnv(2)).then(connectionDrops("a")).then(hello(4))
      .then(all { assert(s.holder.get("a") == 0 and all_invariants), s' = s })
      .then(childEnds("a")).then(resume("a")).then(hello(5))
      .then(all { assert(s.holder.get("a") == 5 and s.inc.get("a") == 2 and all_invariants), s' = s })
}
