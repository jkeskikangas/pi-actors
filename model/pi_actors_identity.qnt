// pi-actors identity (design v4, D15). A companion to pi_actors.qnt.
//
// Scope: which process may act as an agent incarnation: pid ownership, incarnations after
// resume, the root's pid and session fence, same-process session switches, `--continue`
// takeover. Messages (seq, leases, dedupe, DOWN notices) are pi_actors.qnt's job.
//
// Each action mirrors a Tree reducer event or an environment event; src/tree.ts implements them.
module pi_actors_identity {
  type Status = Live | Disconnected | Down
  // A process that may say hello as `id` (its flags or its session say so).
  type Proc = { id: str, inc: int, session: int, owns: bool, alive: bool }

  type State = {
    // --- broker (durable: the log) ---
    status: str -> Status,
    inc: str -> int,
    agentPid: str -> int,       // last accepted pid (0: none yet)
    rootSession: int,           // the root's session as the broker knows it
    holder: str -> int,         // pid of the current connection (0: none)
    resumes: int,
    // --- processes (environment) ---
    procs: int -> Proc,
    nextPid: int,
    nextSession: int,
    // --- observation only ---
    lastRootSession: int,       // the session of the last accepted root hello
    forkSessions: Set[int],     // sessions created by forking the root into a new process
    stolen: bool,               // the root taken over while its previous process still lived
    lockedOut: bool,            // a legitimate `--continue` of the root's session refused
    faults: int,
    rootEnds: int,              // separate budget, so the takeover paths stay reachable
  }

  pure val ROOT = "r"
  pure val AGENTS = Set("r", "a", "b")
  pure val PARENT = Map("r" -> "", "a" -> "r", "b" -> "r")
  pure val MAX_PROCS = 10
  pure val MAX_RESUMES = 1
  pure val MAX_FAULTS = 3

  var s: State

  pure def proc(st: State, pid: int): Proc = st.procs.get(pid)
  pure def isAlive(st: State, pid: int): bool = pid != 0 and proc(st, pid).alive

  action init = s' = {
    status: Map("r" -> Live, "a" -> Live, "b" -> Live),
    inc: Map("r" -> 1, "a" -> 1, "b" -> 1),
    agentPid: Map("r" -> 1, "a" -> 2, "b" -> 3),
    rootSession: 1,
    holder: Map("r" -> 1, "a" -> 2, "b" -> 3),
    resumes: 0,
    // Every pid slot exists up front (unused ones are dead), which keeps simulation fast.
    procs: 0.to(MAX_PROCS).mapBy(pid =>
      if (pid == 1) { id: "r", inc: 1, session: 1, owns: true, alive: true }
      else if (pid == 2) { id: "a", inc: 1, session: 2, owns: true, alive: true }
      else if (pid == 3) { id: "b", inc: 1, session: 3, owns: true, alive: true }
      else { id: "", inc: 0, session: 0, owns: false, alive: false }),
    nextPid: 4,
    nextSession: 4,
    lastRootSession: 1,
    forkSessions: Set(),
    stolen: false,
    lockedOut: false,
    faults: 0,
    rootEnds: 0,
  }

  // ---------------- lifecycle (Tree: goDown, the link rule) ----------------

  pure def goDown1(st: State, id: str): State = { ...st,
    status: st.status.set(id, Down),
    holder: st.holder.set(id, 0),
    procs: if (st.agentPid.get(id) != 0) st.procs.setBy(st.agentPid.get(id), p => { ...p, alive: false }) else st.procs,
  }
  pure def goDown(st: State, id: str): State = {
    val st1 = goDown1(st, id)
    AGENTS.filter(c => PARENT.get(c) == id and st1.status.get(c) != Down).fold(st1, (acc, c) => goDown1(acc, c))
  }

  // ---------------- lifecycle events and resume ----------------

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

  // A reload or dropped connection: the identity stays (INV-7).
  action connectionDrops(id: str): bool = all {
    s.holder.get(id) != 0, s.status.get(id) == Live, s.faults < MAX_FAULTS,
    s' = { ...s, holder: s.holder.set(id, 0), status: s.status.set(id, Disconnected), faults: s.faults + 1 },
  }

  action step = {
    nondet pid = 1.to(s.nextPid - 1).oneOf()
    nondet id = AGENTS.oneOf()
    any {
      childEnds(id), rootGraceExpires, resume(id), hello(pid),
      inheritEnv(pid), rootSwitchesSession(pid), rootForked(pid), rootContinued(pid),
      rootProcessEnds(pid), connectionDrops(id),
    }
  }

  // ---------------- invariants ----------------

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

  val all_invariants = holdersLegit and rootNotStolen and continueAccepted

  // ---------------- reachability witnesses (each MUST be violated by simulation) ----------------
  val witnessResumed = s.resumes == 0
  val witnessTakeover = not(s.holder.get(ROOT) > 3 and proc(s, s.holder.get(ROOT)).session == 1)
  // Deep (switch, hello, crash, continue, hello) and the root's grace may end the tree at any
  // step, so random simulation reaches it only sometimes: switchThenContinueTest covers it.
  val witnessSwitchedThenContinued = not(1.to(MAX_PROCS).exists(q => q > 3 and proc(s, q).id == ROOT and s.holder.get(ROOT) == q and proc(s, q).session != 1))

  // ---------------- scenarios ----------------

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
