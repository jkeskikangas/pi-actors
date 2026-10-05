// pi-actors protocol model (design v3, D15).
//
// Scope: agent lifecycle and DOWN notices, links, limits, sender sequence numbers with
// retransmit, leased fetch with client-side dedupe and deferred ack, client reloads, process
// crashes, and broker crash plus effect-free replay with recover(). Not modelled: calls and
// replies, resume, human routing, clocks (see model/README.md).
//
// Each `action` is one Tree reducer event or one environment fault; src/tree.ts mirrors the
// reducer events. The invariants at the bottom are re-implemented as Tree property tests.
module pi_actors {
  type Status = Unborn | Starting | Live | Disconnected | Exiting | Killing | Down
  // uid: unique message identity (the design's "<sender>:<inc>:<seq>"); seq: sender order.
  type Msg = { uid: int, src: str, dst: str, seq: int, kind: str }
  type Agent = { status: Status, parent: str, depth: int }

  type State = {
    // --- durable (event log) ---
    agents: str -> Agent,
    mailbox: str -> List[Msg],
    lastSeq: str -> int,
    spawns: int,
    downCount: str -> int,
    rejected: Set[int],
    // --- broker memory (lost on broker crash) ---
    brokerUp: bool,
    connected: str -> bool,
    leases: str -> Set[int],
    // --- processes (owned by Keepers; survive broker crashes) ---
    procAlive: str -> bool,
    exitPending: str -> bool,
    // --- client memory (lost on reload or process death) ---
    nextSeq: str -> int,
    inflight: str -> List[Msg],
    fetched: str -> List[Msg],
    pendingAck: str -> Set[int],
    // --- client durable (the agent's own session) ---
    persisted: str -> Set[int],
    // --- observation only ---
    uidCounter: int,
    acceptedBySender: Set[Msg],
    lastSeen: str -> (str -> int),
    dupConsumed: bool,
    ackedUnpersisted: bool,
    fifoViolated: bool,
    redeliveries: int,
    faults: int,
  }

  pure val AGENTS = Set("r", "a", "b", "c")
  pure val PARENT = Map("r" -> "", "a" -> "r", "b" -> "r", "c" -> "a")
  pure val DEPTH = Map("r" -> 0, "a" -> 1, "b" -> 1, "c" -> 2)
  pure val DOWN_UID = Map("r" -> 1000, "a" -> 1001, "b" -> 1002, "c" -> 1003)
  pure val MAX_DEPTH = 2
  pure val MAX_SPAWNS = 3
  pure val MAX_SENT = 4
  pure val MAX_FETCHED = 2
  pure val MAX_FAULTS = 2  // bounds environment faults per trace so random simulation reaches deep paths

  var s: State

  pure def emptyMap(v) = AGENTS.mapBy(_ => v)

  action init = s' = {
    agents: AGENTS.mapBy(id => { status: if (id == "r") Live else Unborn, parent: PARENT.get(id), depth: DEPTH.get(id) }),
    mailbox: emptyMap(List()),
    lastSeq: emptyMap(0),
    spawns: 0,
    downCount: emptyMap(0),
    rejected: Set(),
    brokerUp: true,
    connected: AGENTS.mapBy(id => id == "r"),
    leases: emptyMap(Set()),
    procAlive: AGENTS.mapBy(id => id == "r"),
    exitPending: emptyMap(false),
    nextSeq: emptyMap(1),
    inflight: emptyMap(List()),
    fetched: emptyMap(List()),
    pendingAck: emptyMap(Set()),
    persisted: emptyMap(Set()),
    uidCounter: 0,
    acceptedBySender: Set(),
    lastSeen: AGENTS.mapBy(_ => emptyMap(0)),
    dupConsumed: false,
    ackedUnpersisted: false,
    fifoViolated: false,
    redeliveries: 0,
    faults: 0,
  }

  pure def status(st: State, id: str): Status = st.agents.get(id).status
  pure def setStatus(st: State, id: str, x: Status): State =
    { ...st, agents: st.agents.setBy(id, a => { ...a, status: x }) }
  pure def isActive(x: Status): bool = x == Starting or x == Live or x == Disconnected
  pure def accepting(x: Status): bool = x != Down and x != Unborn

  // Link rule: active children of `id` start being killed.
  pure def killChildren(st: State, id: str): State =
    AGENTS.filter(c => st.agents.get(c).parent == id and isActive(status(st, c)))
      .fold(st, (acc, c) => setStatus(acc, c, Killing))

  // Entering `down`: exactly one DOWN notice to the parent, then the link rule.
  pure def goDown(st: State, id: str): State = {
    val p = st.agents.get(id).parent
    val notice = { uid: DOWN_UID.get(id), src: "broker", dst: p, seq: 0, kind: "down" }
    val st1 = setStatus(st, id, Down)
    val st2 = { ...st1,
      downCount: st1.downCount.setBy(id, n => n + 1),
      mailbox: if (p == "") st1.mailbox else st1.mailbox.setBy(p, l => l.append(notice)),
      connected: st1.connected.set(id, false),
      leases: st1.leases.set(id, Set()),
    }
    killChildren(st2, id)
  }

  pure def clientMemoryLost(st: State, id: str): State = { ...st,
    inflight: st.inflight.set(id, List()),
    fetched: st.fetched.set(id, List()),
    pendingAck: st.pendingAck.set(id, Set()),
    nextSeq: st.nextSeq.set(id, 1),
  }

  // A process (and its client) stops; its Keeper retains the exit report.
  pure def procStops(st: State, id: str): State = {
    val st1 = clientMemoryLost(st, id)
    { ...st1,
      procAlive: st1.procAlive.set(id, false),
      exitPending: st1.exitPending.set(id, true),
      connected: st1.connected.set(id, false),
      leases: st1.leases.set(id, Set()),
    }
  }

  pure def fault(st: State): State = { ...st, faults: st.faults + 1 }

  pure def canAct(st: State, id: str): bool =
    st.brokerUp and st.connected.get(id) and st.procAlive.get(id) and status(st, id) == Live

  // ---------------- agent-initiated events ----------------

  action spawn(p: str, c: str): bool = all {
    canAct(s, p),
    s.agents.get(c).parent == p,
    status(s, c) == Unborn,
    s.agents.get(c).depth <= MAX_DEPTH,
    s.spawns < MAX_SPAWNS,
    val st1 = setStatus(s, c, Starting)
    s' = { ...st1, spawns: s.spawns + 1, procAlive: s.procAlive.set(c, true) },
  }

  // Accepted hello. welcome.last_seq resyncs the client's counter when nothing is in flight.
  action hello(id: str): bool = all {
    s.brokerUp,
    s.procAlive.get(id),
    not(s.connected.get(id)),
    isActive(status(s, id)),
    val st1 = setStatus(s, id, Live)
    s' = { ...st1,
      connected: s.connected.set(id, true),
      nextSeq: if (s.inflight.get(id).length() == 0) s.nextSeq.set(id, s.lastSeq.get(id) + 1) else s.nextSeq,
    },
  }

  action send(src: str, dst: str): bool = all {
    canAct(s, src),
    src != dst,
    s.uidCounter < MAX_SENT,
    val n = s.nextSeq.get(src)
    val m = { uid: s.uidCounter, src: src, dst: dst, seq: n, kind: "mail" }
    s' = { ...s,
      inflight: s.inflight.setBy(src, l => l.append(m)),
      nextSeq: s.nextSeq.set(src, n + 1),
      uidCounter: s.uidCounter + 1,
    },
  }

  // Broker applies the oldest in-flight frame (also retransmission after reconnect).
  // seq = last+1: logged; appended if the target accepts mail, otherwise logged as rejected.
  // seq <= last: duplicate, no change (the cached response is returned).
  action brokerAccept(src: str): bool = all {
    s.brokerUp,
    s.connected.get(src),
    s.inflight.get(src).length() > 0,
    val m = s.inflight.get(src).head()
    s' = if (m.seq == s.lastSeq.get(src) + 1) {
        if (accepting(status(s, m.dst))) { ...s,
          lastSeq: s.lastSeq.set(src, m.seq),
          mailbox: s.mailbox.setBy(m.dst, l => l.append(m)),
        } else { ...s,
          lastSeq: s.lastSeq.set(src, m.seq),
          rejected: s.rejected.union(Set(m.uid)),
        }
      } else s,
  }

  // The broker's response reaches the client; the frame leaves its memory.
  action clientAccepted(src: str): bool = all {
    s.brokerUp,
    s.connected.get(src),
    s.inflight.get(src).length() > 0,
    val m = s.inflight.get(src).head()
    all {
      m.seq <= s.lastSeq.get(src),
      s' = { ...s,
        inflight: s.inflight.setBy(src, l => l.tail()),
        acceptedBySender: if (s.rejected.contains(m.uid)) s.acceptedBySender else s.acceptedBySender.union(Set(m)),
      },
    },
  }

  // receive -> fetch: the oldest unleased message is leased to this connection. The client
  // skips (and queues an ack for) anything its session already consumed.
  action fetch(id: str): bool = all {
    canAct(s, id),
    s.fetched.get(id).length() < MAX_FETCHED,
    val avail = s.mailbox.get(id).select(m => not(s.leases.get(id).contains(m.uid)))
    all {
      avail.length() > 0,
      val m = avail.head()
      val seen = s.persisted.get(id).contains(m.uid)
      // Also skip a message this client is still delivering (fetched before a broker restart).
      val inFlight = s.fetched.get(id).select(x => x.uid == m.uid).length() > 0
      s' = { ...s,
        leases: s.leases.setBy(id, x => x.union(Set(m.uid))),
        fetched: if (seen or inFlight) s.fetched else s.fetched.setBy(id, l => l.append(m)),
        pendingAck: if (seen) s.pendingAck.setBy(id, x => x.union(Set(m.uid))) else s.pendingAck,
        redeliveries: if (seen) s.redeliveries + 1 else s.redeliveries,
      },
    },
  }

  // The tool result reaches the session: the model has consumed the message.
  action persist(id: str): bool = all {
    s.procAlive.get(id),
    s.fetched.get(id).length() > 0,
    val m = s.fetched.get(id).head()
    val prev = s.lastSeen.get(id).get(m.src)
    s' = { ...s,
      fetched: s.fetched.setBy(id, l => l.tail()),
      persisted: s.persisted.setBy(id, x => x.union(Set(m.uid))),
      pendingAck: s.pendingAck.setBy(id, x => x.union(Set(m.uid))),
      dupConsumed: s.dupConsumed or s.persisted.get(id).contains(m.uid),
      fifoViolated: s.fifoViolated or (m.kind == "mail" and m.seq <= prev),
      lastSeen: if (m.kind != "mail") s.lastSeen else s.lastSeen.setBy(id, mm => mm.set(m.src, m.seq)),
    },
  }

  // Deferred ack (D3): only persisted ids are acked.
  action ack(id: str): bool = all {
    s.brokerUp,
    s.connected.get(id),
    s.pendingAck.get(id).size() > 0,
    nondet mid = s.pendingAck.get(id).oneOf()
    s' = { ...s,
      mailbox: s.mailbox.setBy(id, l => l.select(m => m.uid != mid)),
      leases: s.leases.setBy(id, x => x.exclude(Set(mid))),
      pendingAck: s.pendingAck.setBy(id, x => x.exclude(Set(mid))),
      ackedUnpersisted: s.ackedUnpersisted or not(s.persisted.get(id).contains(mid)),
    },
  }

  action exit(id: str): bool = all {
    canAct(s, id),
    id != "r",
    s' = setStatus(s, id, Exiting),
  }

  action kill(p: str, c: str): bool = all {
    canAct(s, p),
    s.agents.get(c).parent == p,
    isActive(status(s, c)),
    s' = setStatus(s, c, Killing),
  }

  // ---------------- broker timers and Keeper reports ----------------

  action graceExpire(id: str): bool = all {
    s.brokerUp, status(s, id) == Disconnected,
    s' = setStatus(s, id, Killing),
  }

  action startTimeout(id: str): bool = all {
    s.brokerUp, status(s, id) == Starting,
    s' = setStatus(s, id, Killing),
  }

  // Kill escalation (TERM, then KILL to the pgid) or a clean exit after `exit`.
  action processEnds(id: str): bool = all {
    s.procAlive.get(id),
    status(s, id) == Killing or status(s, id) == Exiting,
    s' = procStops(s, id),
  }

  // The Keeper's retained proc_exit reaches the broker.
  action procExitReported(id: str): bool = all {
    s.brokerUp,
    s.exitPending.get(id),
    status(s, id) != Down,
    s' = goDown({ ...s, exitPending: s.exitPending.set(id, false) }, id),
  }

  // `killing` expiry: SIGKILL to the pgid; Down(killed, unconfirmed).
  action killingExpire(id: str): bool = all {
    s.brokerUp, status(s, id) == Killing,
    val st1 = if (s.procAlive.get(id)) procStops(s, id) else s
    s' = goDown({ ...st1, exitPending: st1.exitPending.set(id, false) }, id),
  }

  // ---------------- environment faults ----------------

  action processCrash(id: str): bool = all {
    s.procAlive.get(id), id != "r", s.faults < MAX_FAULTS,
    s' = fault(procStops(s, id)),
  }

  // A pi reload: same process, fresh extension runtime. Client memory is lost; the session is not.
  action reload(id: str): bool = all {
    s.procAlive.get(id), isActive(status(s, id)), s.faults < MAX_FAULTS,
    val st1 = if (status(s, id) == Live) setStatus(s, id, Disconnected) else s
    val st2 = clientMemoryLost(fault(st1), id)
    s' = { ...st2, connected: st2.connected.set(id, false), leases: st2.leases.set(id, Set()) },
  }

  action connectionDrop(id: str): bool = all {
    s.connected.get(id), s.faults < MAX_FAULTS,
    val st1 = if (status(s, id) == Live) setStatus(s, id, Disconnected) else s
    s' = { ...fault(st1), connected: s.connected.set(id, false), leases: s.leases.set(id, Set()) },
  }

  action brokerCrash: bool = all {
    s.brokerUp, s.faults < MAX_FAULTS,
    s' = { ...fault(s), brokerUp: false, connected: emptyMap(false), leases: emptyMap(Set()) },
  }

  // Replay is effect-free; recover() turns live agents into disconnected ones and sweeps orphans.
  pure def recover(st: State): State = {
    val st1 = AGENTS.filter(id => status(st, id) == Live).fold(st, (acc, id) => setStatus(acc, id, Disconnected))
    AGENTS.filter(id => isActive(status(st1, id)) and st1.agents.get(id).parent != ""
                    and status(st1, st1.agents.get(id).parent) == Down)
      .fold(st1, (acc, id) => setStatus(acc, id, Killing))
  }

  action brokerRestart: bool = all {
    not(s.brokerUp),
    s' = { ...recover(s), brokerUp: true },
  }

  action step = {
    nondet a = AGENTS.oneOf()
    nondet b = AGENTS.oneOf()
    any {
      spawn(a, b), hello(a), send(a, b), brokerAccept(a), clientAccepted(a),
      fetch(a), persist(a), ack(a), exit(a), kill(a, b),
      graceExpire(a), startTimeout(a), processEnds(a), procExitReported(a), killingExpire(a),
      processCrash(a), reload(a), connectionDrop(a), brokerCrash, brokerRestart,
    }
  }

  // ---------------- invariants (mirrored by test/tree.property.test.ts) ----------------

  // INV-2: at most one DOWN per agent, and every Down agent produced one.
  val downOnce = AGENTS.forall(id => s.downCount.get(id) <= 1)
  val downNotified = AGENTS.forall(id => status(s, id) == Down implies s.downCount.get(id) == 1)
  // INV-3: consumed at most once; never acked before persisted; every message the sender saw
  // accepted is either still in the target's mailbox or consumed by it.
  val consumedOnce = not(s.dupConsumed)
  val noLossOnAck = not(s.ackedUnpersisted)
  val atLeastOnce = s.acceptedBySender.forall(m =>
    s.persisted.get(m.dst).contains(m.uid) or s.mailbox.get(m.dst).select(x => x.uid == m.uid).length() > 0)
  // INV-4: per-sender FIFO as seen by each receiver.
  val fifo = not(s.fifoViolated)
  // INV-1 (safety part): no active agent under a Down parent.
  val noOrphans = AGENTS.forall(id =>
    (s.agents.get(id).parent != "" and status(s, s.agents.get(id).parent) == Down)
      implies not(isActive(status(s, id))))
  // INV-5: limits.
  val limits = s.spawns <= MAX_SPAWNS and AGENTS.forall(id => status(s, id) != Unborn implies s.agents.get(id).depth <= MAX_DEPTH)
  // Leases never outlive the connection that took them.
  val leasesNeedConnection = AGENTS.forall(id => s.leases.get(id).size() > 0 implies s.connected.get(id))

  val all_invariants = downOnce and downNotified and consumedOnce and noLossOnAck and atLeastOnce
    and fifo and noOrphans and limits and leasesNeedConnection

  // ---------------- reachability witnesses (each MUST be violated by simulation) ----------------
  val witnessConsumed = AGENTS.forall(id => s.persisted.get(id).size() == 0)
  val witnessRedelivered = s.redeliveries == 0
  val witnessRetransmitPending = not(AGENTS.exists(id => s.inflight.get(id).length() > 0
      and s.inflight.get(id).head().seq <= s.lastSeq.get(id) and not(s.connected.get(id))))
  val witnessTwoAccepted = s.acceptedBySender.size() < 2
  val witnessChildDown = AGENTS.forall(id => id == "r" or status(s, id) != Down)
  val witnessGrandchildKilledByLink = not(status(s, "a") == Down and status(s, "c") == Down)

  // ---------------- deterministic scenario tests (quint test; mirrored as Tree unit tests) ----------------
  run redeliveryAfterReloadTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(clientAccepted("r")).then(fetch("a")).then(persist("a")).then(reload("a"))
      .then(hello("a")).then(fetch("a"))
      .then(all { assert(s.redeliveries == 1 and s.fetched.get("a").length() == 0 and all_invariants), s' = s })

  run retransmitAfterBrokerCrashTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(brokerCrash).then(brokerRestart).then(hello("r")).then(hello("a"))
      .then(brokerAccept("r")).then(clientAccepted("r"))
      .then(all { assert(s.mailbox.get("a").length() == 1 and all_invariants), s' = s })

  run linkKillsGrandchildTest =
    init.then(spawn("r", "a")).then(hello("a")).then(spawn("a", "c")).then(hello("c"))
      .then(processCrash("a")).then(procExitReported("a"))
      .then(all { assert(status(s, "c") == Killing and all_invariants), s' = s })
      .then(killingExpire("c"))
      .then(all { assert(status(s, "c") == Down and s.downCount.get("c") == 1 and all_invariants), s' = s })

  run replaySweepsOrphanTest =
    init.then(spawn("r", "a")).then(hello("a")).then(brokerCrash).then(brokerRestart)
      .then(all { assert(status(s, "a") == Disconnected and status(s, "r") == Disconnected), s' = s })

  run sendAfterReloadTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(clientAccepted("r")).then(reload("r")).then(hello("r")).then(send("r", "a"))
      .then(brokerAccept("r")).then(clientAccepted("r"))
      .then(all { assert(s.mailbox.get("a").length() == 2 and all_invariants), s' = s })

  // Found by the Tree property test: a delivery in flight across a broker restart.
  run inFlightAcrossBrokerRestartTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(clientAccepted("r")).then(fetch("a")).then(brokerCrash).then(brokerRestart)
      .then(hello("a")).then(fetch("a"))
      .then(all { assert(s.fetched.get("a").length() == 1 and all_invariants), s' = s })
      .then(persist("a"))
      .then(all { assert(all_invariants), s' = s })
}
