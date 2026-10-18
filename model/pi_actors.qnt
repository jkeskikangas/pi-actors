// pi-actors protocol model (design v4, D15).
//
// Scope: agent lifecycle and DOWN notices, links, limits, sender sequence numbers with
// retransmit, leased fetch with client-side dedupe and deferred ack, client reloads, process
// crashes, broker crash plus effect-free replay with recover(), and forgetting ended agents.
// Not modelled: resume and identity (pi_actors_identity.qnt), clocks (see model/README.md).
//
// Each `action` is one Tree reducer event or one environment fault; src/tree.ts mirrors the
// reducer events. The invariants at the bottom are re-implemented as Tree property tests.
module pi_actors {
  // Gone: forgotten (removed from the tree); the id is never used again.
  type Status = Unborn | Starting | Live | Disconnected | Exiting | Killing | Down | Gone
  // uid: unique message identity (the design's "<sender>:<inc>:<seq>"); seq: sender order.
  // urgent: the sender asked for it to interrupt the receiver's run (pi steer).
  type Msg = { uid: int, src: str, dst: str, seq: int, kind: str, urgent: bool }
  type Agent = { status: Status, parent: str, depth: int }

  type State = {
    // --- durable (event log) ---
    agents: str -> Agent,
    mailbox: str -> List[Msg],
    lastSeq: str -> int,
    downCount: str -> int,
    rejected: Set[int],
    forgotten: Set[str],
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
    // Fetched (leased) by the current drain and not yet injected into pi: one batch.
    batch: str -> List[Msg],
    // pi's queues, in the order pi hands them to the model, one message per turn: the first
    // steerLen are steers (FIFO among themselves), then the follow-ups. A steer injected later
    // goes after the queued steers but ahead of every queued follow-up.
    fetched: str -> List[Msg],
    steerLen: str -> int,
    // The client's in-flight ids: injected but not yet consumed. pi may drop an injection (it
    // clears its queues on Esc); such ids stay here until reclaim releases them (fix F4).
    injected: str -> Set[int],
    // Injections pi kept queued across an aborted run; it hands them to the model later, in
    // order, ahead of anything injected after them. The client cannot see this queue.
    held: str -> List[Msg],
    pendingAck: str -> Set[int],
    // --- client durable (the agent's own session) ---
    persisted: str -> Set[int],
    // --- observation only ---
    uidCounter: int,
    acceptedBySender: Set[Msg],
    lastSeen: str -> (str -> int),
    dupConsumed: bool,
    urgentConsumed: bool,
    ackedUnpersisted: bool,
    fifoViolated: bool,
    forgotLive: bool,
    // Forgotten while its parent still ran, by someone other than that parent.
    forgotUnderRunningParent: bool,
    // Ended while its parent was still running (so only that parent could clear it then).
    endedBeforeParent: Set[str],
    // Who forgot each id (observation for the witness).
    forgottenBy: str -> str,
    redeliveries: int,
    faults: int,
    // --- sequencing across broker versions (incident 0.2.5: seq_gap wedge) ---
    // A 0.2.6 broker in a mixed-version tree: it may apply one connection's frames out of order.
    legacyBroker: bool,
    // Client: in-flight uids the broker answered seq_gap (not applied), held for a resend.
    gapped: str -> Set[int],
    // Observation: every op a client sent; ops lost with client memory (reload, process end).
    sentUids: Set[int],
    lostWithClient: Set[int],
    appliedUids: Set[int],
    lastAppliedUid: str -> int,
    dupApplied: bool,
    appliedOutOfOrder: bool,
    // A seq_gap while the expected frame was still on the same connection (frames overtook).
    reorderGap: bool,
    resentUids: Set[int],
    // --- stopping: broker process vs tree ---
    treeStopped: bool,
    // The broker told Keepers to leave (finished-tree shutdown); they kill any child left.
    shutdownSent: bool,
    killedWithoutStop: bool,
    sigtermed: bool,
  }

  pure val AGENTS = Set("r", "a", "b", "c")
  pure val PARENT = Map("r" -> "", "a" -> "r", "b" -> "r", "c" -> "a")
  pure val DEPTH = Map("r" -> 0, "a" -> 1, "b" -> 1, "c" -> 2)
  pure val DOWN_UID = Map("r" -> 1000, "a" -> 1001, "b" -> 1002, "c" -> 1003)
  pure val MAX_DEPTH = 2
  // Below the three non-root agents, so the cap binds and a freed place must be reused.
  pure val MAX_RUNNING = 2
  pure val MAX_SENT = 4
  pure val MAX_FETCHED = 2
  pure val MAX_FAULTS = 2  // bounds environment faults per trace so random simulation reaches deep paths

  var s: State

  pure def emptyMap(v) = AGENTS.mapBy(_ => v)

  action init = {
    nondet lb = Set(true, false).oneOf()
    initWith(lb)
  }

  action initWith(lb: bool): bool = s' = {
    agents: AGENTS.mapBy(id => { status: if (id == "r") Live else Unborn, parent: PARENT.get(id), depth: DEPTH.get(id) }),
    mailbox: emptyMap(List()),
    lastSeq: emptyMap(0),
    downCount: emptyMap(0),
    rejected: Set(),
    forgotten: Set(),
    brokerUp: true,
    connected: AGENTS.mapBy(id => id == "r"),
    leases: emptyMap(Set()),
    procAlive: AGENTS.mapBy(id => id == "r"),
    exitPending: emptyMap(false),
    nextSeq: emptyMap(1),
    inflight: emptyMap(List()),
    batch: emptyMap(List()),
    fetched: emptyMap(List()),
    steerLen: emptyMap(0),
    injected: emptyMap(Set()),
    held: emptyMap(List()),
    pendingAck: emptyMap(Set()),
    persisted: emptyMap(Set()),
    uidCounter: 0,
    acceptedBySender: Set(),
    lastSeen: AGENTS.mapBy(_ => emptyMap(0)),
    dupConsumed: false,
    urgentConsumed: false,
    ackedUnpersisted: false,
    fifoViolated: false,
    forgotLive: false,
    forgotUnderRunningParent: false,
    endedBeforeParent: Set(),
    forgottenBy: AGENTS.mapBy(_ => ""),
    redeliveries: 0,
    faults: 0,
    legacyBroker: lb,
    gapped: emptyMap(Set()),
    sentUids: Set(),
    lostWithClient: Set(),
    appliedUids: Set(),
    lastAppliedUid: emptyMap(-1),
    dupApplied: false,
    appliedOutOfOrder: false,
    reorderGap: false,
    resentUids: Set(),
    treeStopped: false,
    shutdownSent: false,
    killedWithoutStop: false,
    sigtermed: false,
  }

  pure def status(st: State, id: str): Status = st.agents.get(id).status
  pure def setStatus(st: State, id: str, x: Status): State =
    { ...st, agents: st.agents.setBy(id, a => { ...a, status: x }) }
  pure def isActive(x: Status): bool = x == Starting or x == Live or x == Disconnected
  // A forgotten (Gone) target is unknown: mail to it is refused, never queued.
  pure def accepting(x: Status): bool = x != Down and x != Unborn and x != Gone
  // INV-5: agents below the root whose process may still run; one that ends frees its place.
  pure def running(st: State): int =
    AGENTS.filter(id => id != "r" and not(Set(Unborn, Down, Gone).contains(status(st, id)))).size()

  // Link rule: active children of `id` start being killed.
  pure def killChildren(st: State, id: str): State =
    AGENTS.filter(c => st.agents.get(c).parent == id and isActive(status(st, c)))
      .fold(st, (acc, c) => setStatus(acc, c, Killing))

  // Entering `down`: exactly one DOWN notice to the parent, then the link rule.
  pure def goDown(st: State, id: str): State = {
    val p = st.agents.get(id).parent
    val notice = { uid: DOWN_UID.get(id), src: "broker", dst: p, seq: 0, kind: "down", urgent: false }
    val st1 = setStatus(st, id, Down)
    val st2 = { ...st1,
      downCount: st1.downCount.setBy(id, n => n + 1),
      mailbox: if (p == "") st1.mailbox else st1.mailbox.setBy(p, l => l.append(notice)),
      connected: st1.connected.set(id, false),
      leases: st1.leases.set(id, Set()),
      endedBeforeParent: if (p != "" and status(st1, p) != Down and status(st1, p) != Gone) st1.endedBeforeParent.union(Set(id)) else st1.endedBeforeParent,
    }
    killChildren(st2, id)
  }

  pure def clientMemoryLost(st: State, id: str): State = { ...st,
    lostWithClient: st.lostWithClient.union(st.inflight.get(id).foldl(Set(), (acc, m) => acc.union(Set(m.uid)))),
    gapped: st.gapped.set(id, Set()),
    inflight: st.inflight.set(id, List()),
    batch: st.batch.set(id, List()),
    fetched: st.fetched.set(id, List()),
    steerLen: st.steerLen.set(id, 0),
    injected: st.injected.set(id, Set()),
    held: st.held.set(id, List()),
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

  // Only an unborn id is spawned: a forgotten (Gone) one never comes back.
  pure def canSpawn(st: State, p: str, c: str): bool = all {
    canAct(st, p),
    st.agents.get(c).parent == p,
    status(st, c) == Unborn,
    st.agents.get(c).depth <= MAX_DEPTH,
    running(st) < MAX_RUNNING,
  }

  action spawn(p: str, c: str): bool = all {
    canSpawn(s, p, c),
    val st1 = setStatus(s, c, Starting)
    s' = { ...st1, procAlive: s.procAlive.set(c, true) },
  }

  // welcome.last_seq: frames up to it were applied and keep their seq (a resend gets the cached
  // answer); the rest were not, and are numbered on from last_seq + 1, in order.
  pure def unapplied(l: List[Msg], last: int): List[Msg] = l.select(m => m.seq > last)
  pure def realign(l: List[Msg], last: int): List[Msg] =
    l.foldl(List(), (acc, m) => if (m.seq <= last) acc.append(m)
      else acc.append({ ...m, seq: last + 1 + unapplied(acc, last).length() }))

  // Accepted hello. welcome.last_seq realigns the client's numbering; everything held is resent.
  pure def canHello(st: State, id: str): bool = all {
    st.brokerUp,
    st.procAlive.get(id),
    not(st.connected.get(id)),
    isActive(status(st, id)),
  }

  action hello(id: str): bool = all {
    canHello(s, id),
    val st1 = setStatus(s, id, Live)
    s' = { ...st1,
      connected: s.connected.set(id, true),
      inflight: s.inflight.set(id, realign(s.inflight.get(id), s.lastSeq.get(id))),
      nextSeq: s.nextSeq.set(id, s.lastSeq.get(id) + 1 + unapplied(s.inflight.get(id), s.lastSeq.get(id)).length()),
      gapped: s.gapped.set(id, Set()),
    },
  }

  action send(src: str, dst: str): bool = {
    nondet urgent = Set(false, true).oneOf()
    sendWith(src, dst, urgent)
  }

  action sendWith(src: str, dst: str, urgent: bool): bool = all {
    canAct(s, src),
    src != dst,
    s.uidCounter < MAX_SENT,
    val n = s.nextSeq.get(src)
    val m = { uid: s.uidCounter, src: src, dst: dst, seq: n, kind: "mail", urgent: urgent }
    s' = { ...s,
      inflight: s.inflight.setBy(src, l => l.append(m)),
      nextSeq: s.nextSeq.set(src, n + 1),
      uidCounter: s.uidCounter + 1,
      sentUids: s.sentUids.union(Set(m.uid)),
    },
  }

  // Frames on the wire: in flight and not held after a seq_gap answer.
  pure def wire(st: State, src: str): List[Msg] = st.inflight.get(src).select(m => not(st.gapped.get(src).contains(m.uid)))

  // seq = last+1: logged; appended if the target accepts mail, otherwise logged as rejected.
  pure def applyFrame(st: State, src: str, m: Msg): State = {
    val st1 = if (accepting(status(st, m.dst))) { ...st, mailbox: st.mailbox.setBy(m.dst, l => l.append(m)) }
      else { ...st, rejected: st.rejected.union(Set(m.uid)) }
    { ...st1,
      lastSeq: st1.lastSeq.set(src, m.seq),
      appliedUids: st1.appliedUids.union(Set(m.uid)),
      dupApplied: st1.dupApplied or st1.appliedUids.contains(m.uid),
      appliedOutOfOrder: st1.appliedOutOfOrder or m.uid <= st1.lastAppliedUid.get(src),
      lastAppliedUid: st1.lastAppliedUid.set(src, m.uid),
    }
  }

  // seq > last+1: answered seq_gap, not applied. The client holds the frame for a resend.
  pure def gapAnswer(st: State, src: str, m: Msg): State = { ...st,
    gapped: st.gapped.setBy(src, g => g.union(Set(m.uid))),
    reorderGap: st.reorderGap or wire(st, src).select(x => x.seq == st.lastSeq.get(src) + 1).length() > 0,
  }

  // seq <= last: duplicate, no change (the cached response is returned).
  pure def brokerProcess(st: State, src: str, m: Msg): State =
    if (m.seq == st.lastSeq.get(src) + 1) applyFrame(st, src, m)
    else if (m.seq > st.lastSeq.get(src) + 1) gapAnswer(st, src, m)
    else st

  // The broker processes the frame at position i of the wire. The current broker takes only
  // the oldest (per-connection queue); a 0.2.6 broker may let later frames overtake an awaiting
  // one (spawn{resume} awaits the process check).
  pure def canBrokerAccept(st: State, src: str, i: int): bool = all {
    st.brokerUp,
    st.connected.get(src),
    i >= 0, i < wire(st, src).length(),
    i == 0 or st.legacyBroker,
  }

  action brokerAcceptAt(src: str, i: int): bool = all {
    canBrokerAccept(s, src, i),
    s' = brokerProcess(s, src, wire(s, src)[i]),
  }

  action brokerAccept(src: str): bool = brokerAcceptAt(src, 0)

  action brokerAcceptAny(src: str): bool = all {
    wire(s, src).length() > 0,
    nondet i = wire(s, src).indices().oneOf()
    brokerAcceptAt(src, i),
  }

  // Every frame before the held ones is answered: resend them, in order.
  action clientResend(src: str): bool = all {
    s.brokerUp,
    s.connected.get(src),
    s.inflight.get(src).length() > 0,
    s.gapped.get(src).contains(s.inflight.get(src).head().uid),
    s' = { ...s, gapped: s.gapped.set(src, Set()), resentUids: s.resentUids.union(s.gapped.get(src)) },
  }

  // The broker's response reaches the client; the frame leaves its memory.
  action clientAccepted(src: str): bool = all {
    s.brokerUp,
    s.connected.get(src),
    s.inflight.get(src).length() > 0,
    val m = s.inflight.get(src).head()
    all {
      m.seq <= s.lastSeq.get(src),
      not(s.gapped.get(src).contains(m.uid)),
      s' = { ...s,
        inflight: s.inflight.setBy(src, l => l.tail()),
        acceptedBySender: if (s.rejected.contains(m.uid)) s.acceptedBySender else s.acceptedBySender.union(Set(m)),
      },
    },
  }

  // mailroom.waiting: an injection is in pi and not yet consumed (persisted) or reclaimed.
  pure def waiting(st: State, id: str): bool =
    st.injected.get(id).exists(u => st.batch.get(id).select(m => m.uid == u).length() == 0)

  // At most one injection waits in pi: mail that arrives meanwhile stays in the broker,
  // unleased, until the next delivery drains it.
  pure def mayFetch(st: State, id: str): bool = all {
    canAct(st, id),
    st.batch.get(id).length() + st.fetched.get(id).length() < MAX_FETCHED,
    not(waiting(st, id)),
  }

  // drain -> fetch, one message per step: the oldest unleased message is leased to this
  // connection and joins the batch. The client skips (and queues an ack for) anything its session
  // already consumed, and anything it is still delivering.
  action fetch(id: str): bool = all {
    mayFetch(s, id),
    val avail = s.mailbox.get(id).select(m => not(s.leases.get(id).contains(m.uid)))
    all {
      avail.length() > 0,
      val m = avail.head()
      val seen = s.persisted.get(id).contains(m.uid)
      // Also skip a message this client is still delivering (fetched before a broker restart).
      val inFlight = s.injected.get(id).contains(m.uid)
      s' = { ...s,
        leases: s.leases.setBy(id, x => x.union(Set(m.uid))),
        batch: if (seen or inFlight) s.batch else s.batch.setBy(id, l => l.append(m)),
        injected: if (seen or inFlight) s.injected else s.injected.setBy(id, x => x.union(Set(m.uid))),
        pendingAck: if (seen) s.pendingAck.setBy(id, x => x.union(Set(m.uid))) else s.pendingAck,
        redeliveries: if (seen) s.redeliveries + 1 else s.redeliveries,
      },
    },
  }

  // The drain ends: the batch goes to pi as one injection, a steer if it holds urgent mail (or
  // urgent mail was announced: urgentOwed), else a follow-up.
  pure def insertAt(l: List[Msg], k: int, b: List[Msg]): List[Msg] =
    l.slice(0, k).concat(b).concat(l.slice(k, l.length()))

  action inject(id: str): bool = {
    nondet owed = Set(false, true).oneOf()
    injectAs(id, owed)
  }

  action injectAs(id: str, owed: bool): bool = all {
    s.procAlive.get(id),
    s.batch.get(id).length() > 0,
    val b = s.batch.get(id)
    val steer = owed or b.select(m => m.urgent).length() > 0
    s' = { ...s,
      batch: s.batch.set(id, List()),
      fetched: s.fetched.setBy(id, l => if (steer) insertAt(l, s.steerLen.get(id), b) else l.concat(b)),
      steerLen: if (steer) s.steerLen.setBy(id, n => n + b.length()) else s.steerLen,
    },
  }

  // pi takes the head of its queues.
  pure def piPops(st: State, id: str): State = { ...st,
    fetched: st.fetched.setBy(id, l => l.tail()),
    steerLen: st.steerLen.setBy(id, n => if (n > 0) n - 1 else 0),
  }

  // A delivery reaches the session. The context hook shows the model only ids the session does
  // not hold yet (fix N1), so a second copy is saved but never consumed again. Abstraction: the
  // real hook sees the current context, not the whole session; after a compaction an earlier
  // copy may be summarized away, so the model's "never twice" holds per context window.
  pure def consume(st: State, id: str, m: Msg): State = {
    val hidden = st.persisted.get(id).contains(m.uid)
    val prev = st.lastSeen.get(id).get(m.src)
    { ...st,
      injected: st.injected.setBy(id, x => x.exclude(Set(m.uid))),
      persisted: st.persisted.setBy(id, x => x.union(Set(m.uid))),
      pendingAck: st.pendingAck.setBy(id, x => x.union(Set(m.uid))),
      dupConsumed: st.dupConsumed or (st.persisted.get(id).contains(m.uid) and not(hidden)),
      urgentConsumed: st.urgentConsumed or (not(hidden) and m.urgent),
      fifoViolated: st.fifoViolated or (not(hidden) and m.kind == "mail" and m.seq <= prev),
      lastSeen: if (hidden or m.kind != "mail") st.lastSeen else st.lastSeen.setBy(id, mm => mm.set(m.src, m.seq)),
    }
  }

  // The injected entry reaches the session: the model has consumed the message. Anything pi
  // kept goes first. (pi saves a batch as one entry; taking it a message at a time allows more.)
  action persist(id: str): bool = all {
    s.procAlive.get(id),
    s.held.get(id).length() == 0,
    s.fetched.get(id).length() > 0,
    val m = s.fetched.get(id).head()
    s' = piPops(consume(s, id, m), id),
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

  // pi drops an injected message before saving it (Esc clears its queues). The client does not
  // know yet: the id stays in flight and the broker keeps the lease.
  action piDrops(id: str): bool = all {
    s.fetched.get(id).length() > 0, s.faults < MAX_FAULTS,
    s' = piPops(fault(s), id),
  }

  // pi keeps an injected message queued across an aborted run (RPC abort keeps queues). The
  // client cannot tell it from a dropped one: after the age guard, reclaim redelivers it.
  action piKeeps(id: str): bool = all {
    s.fetched.get(id).length() > 0, s.faults < MAX_FAULTS,
    s' = { ...piPops(fault(s), id), held: s.held.setBy(id, l => l.append(s.fetched.get(id).head())) },
  }

  // The next run: pi hands the model what it kept.
  action piDeliversKept(id: str): bool = all {
    s.procAlive.get(id),
    s.held.get(id).length() > 0,
    val m = s.held.get(id).head()
    s' = { ...consume(s, id, m), held: s.held.setBy(id, l => l.tail()) },
  }

  // Reclaim (fix F4): an in-flight id that never reached the session is released and forgotten,
  // so it is fetched and delivered again. Only ids that are really gone qualify (the age guard);
  // the batch being drained is not injected yet.
  pure def inPi(st: State, id: str, u: int): bool =
    st.fetched.get(id).select(m => m.uid == u).length() > 0 or st.batch.get(id).select(m => m.uid == u).length() > 0
  action reclaim(id: str): bool = all {
    s.brokerUp, s.connected.get(id),
    val gone = s.injected.get(id).filter(u => not(inPi(s, id, u)))
    all {
      gone.size() > 0,
      nondet u = gone.oneOf()
      s' = { ...s,
        injected: s.injected.setBy(id, x => x.exclude(Set(u))),
        leases: s.leases.setBy(id, x => x.exclude(Set(u))),
      },
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

  // Strict ancestry (the tree is at most two levels below the root).
  pure def isAncestor(x: str, y: str): bool =
    PARENT.get(y) == x or (PARENT.get(y) != "" and PARENT.get(PARENT.get(y)) == x)

  // forget{target}: a strict ancestor removes an ended agent and its ended subtree. Their
  // mailboxes, leases and sequence tracking go; DOWN notices already queued elsewhere stay.
  // While the target's parent runs, only that parent may forget it: it may still resume the child.
  pure def parentLets(st: State, p: str, t: str): bool = {
    val par = PARENT.get(t)
    par == p or status(st, par) == Down or status(st, par) == Gone
  }
  // Everything but the sender being able to act right now.
  pure def mayForget(st: State, p: str, t: str): bool = all {
    isAncestor(p, t),
    status(st, t) == Down,
    AGENTS.filter(x => isAncestor(t, x)).forall(x => status(st, x) == Down or status(st, x) == Unborn or status(st, x) == Gone),
    parentLets(st, p, t),
  }
  pure def canForget(st: State, p: str, t: str): bool = canAct(st, p) and mayForget(st, p, t)

  action forget(p: str, t: str): bool = all {
    canForget(s, p, t),
    val gone = Set(t).union(AGENTS.filter(x => isAncestor(t, x) and status(s, x) == Down))
    s' = { ...s,
      agents: s.agents.keys().mapBy(x => if (gone.contains(x)) { ...s.agents.get(x), status: Gone } else s.agents.get(x)),
      mailbox: s.mailbox.keys().mapBy(x => if (gone.contains(x)) List() else s.mailbox.get(x)),
      leases: s.leases.keys().mapBy(x => if (gone.contains(x)) Set() else s.leases.get(x)),
      lastSeq: s.lastSeq.keys().mapBy(x => if (gone.contains(x)) 0 else s.lastSeq.get(x)),
      forgotten: s.forgotten.union(gone),
      forgotLive: s.forgotLive or gone.exists(x => status(s, x) != Down),
      forgotUnderRunningParent: s.forgotUnderRunningParent
        or (PARENT.get(t) != p and status(s, PARENT.get(t)) != Down and status(s, PARENT.get(t)) != Gone),
      forgottenBy: s.forgottenBy.keys().mapBy(x => if (gone.contains(x)) p else s.forgottenBy.get(x)),
    },
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

  // SIGTERM/SIGINT/SIGHUP to the broker process: it stops like a crash. Keepers keep their
  // children through the grace period and reconnect to the relaunched broker.
  action brokerSigterm: bool = all {
    s.brokerUp, s.faults < MAX_FAULTS,
    s' = { ...fault(s), brokerUp: false, connected: emptyMap(false), leases: emptyMap(Set()), sigtermed: true },
  }

  // stop_tree (root): kill every agent; the root's record ends. Counted against MAX_FAULTS only
  // so that random traces do not end the tree early and still reach deep paths.
  action stopTree: bool = all {
    canAct(s, "r"), s.faults < MAX_FAULTS,
    val st1 = AGENTS.filter(id => id != "r" and isActive(status(s, id))).fold(goDown(fault(s), "r"), (acc, id) => setStatus(acc, id, Killing))
    s' = { ...st1, treeStopped: true },
  }

  pure def finished(st: State): bool = AGENTS.forall(id => Set(Down, Unborn, Gone).contains(status(st, id)))

  // A finished tree: the broker tells Keepers to leave, compacts and exits.
  action brokerFinish: bool = all {
    s.brokerUp, finished(s),
    s' = { ...s, brokerUp: false, connected: emptyMap(false), leases: emptyMap(Set()), shutdownSent: true },
  }

  // A Keeper told to leave kills its child, if it still runs.
  action keeperShutdown(id: str): bool = all {
    s.shutdownSent, id != "r", s.procAlive.get(id),
    val st1 = procStops(s, id)
    s' = { ...st1, killedWithoutStop: s.killedWithoutStop or not(s.treeStopped) },
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
      spawn(a, b), hello(a), send(a, b), brokerAccept(a), brokerAcceptAny(a), clientResend(a), clientAccepted(a),
      brokerSigterm, stopTree, brokerFinish, keeperShutdown(a),
      fetch(a), inject(a), persist(a), ack(a), piDrops(a), piKeeps(a), piDeliversKept(a), reclaim(a), exit(a), kill(a, b), forget(a, b),
      graceExpire(a), startTimeout(a), processEnds(a), procExitReported(a), killingExpire(a),
      processCrash(a), reload(a), connectionDrop(a), brokerCrash, brokerRestart,
    }
  }

  // Focused simulation of delivery between r and a live child a: every trace is a trace of
  // `step` (from the state that init, spawn("r", "a") and hello("a") reach), so the invariants
  // must hold here too; random `step` traces rarely reach the deep delivery orderings.
  action initDelivery = {
    nondet lb = Set(true, false).oneOf()
    initWith(lb).then(spawn("r", "a")).then(hello("a"))
  }

  action deliveryStep = {
    nondet a = Set("r", "a").oneOf()
    nondet b = Set("r", "a").oneOf()
    any {
      send(a, b), brokerAccept(a), brokerAcceptAny(a), clientResend(a), clientAccepted(a), hello(a),
      fetch(a), inject(a), persist(a), ack(a), piDrops(a), piKeeps(a), piDeliversKept(a), reclaim(a),
      reload(a), connectionDrop(a), brokerCrash, brokerRestart,
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
  // (A forgotten receiver's unread mail is discarded with it, deliberately.)
  val atLeastOnce = s.acceptedBySender.forall(m =>
    s.persisted.get(m.dst).contains(m.uid) or s.mailbox.get(m.dst).select(x => x.uid == m.uid).length() > 0
      or s.forgotten.contains(m.dst))
  // INV-4: per-sender FIFO as seen by each receiver.
  val fifo = not(s.fifoViolated)
  // INV-1 (safety part): no active agent under a Down parent.
  val noOrphans = AGENTS.forall(id =>
    (s.agents.get(id).parent != "" and status(s, s.agents.get(id).parent) == Down)
      implies not(isActive(status(s, id))))
  // INV-5: limits.
  val limits = running(s) <= MAX_RUNNING and AGENTS.forall(id => status(s, id) != Unborn implies s.agents.get(id).depth <= MAX_DEPTH)
  // Leases never outlive the connection that took them.
  val leasesNeedConnection = AGENTS.forall(id => s.leases.get(id).size() > 0 implies s.connected.get(id))

  // Forget: only ended agents are forgotten; a forgotten id never comes back and keeps no
  // mailbox, leases or connection.
  val forgetsOnlyDown = not(s.forgotLive)
  val forgottenStaysGone = AGENTS.forall(id => s.forgotten.contains(id) iff status(s, id) == Gone)
  val forgottenHoldsNothing = s.forgotten.forall(id =>
    s.mailbox.get(id).length() == 0 and s.leases.get(id).size() == 0 and not(s.connected.get(id)))

  // A running parent's ended child is that parent's to forget (it may resume it).
  val noForgetUnderRunningParent = not(s.forgotUnderRunningParent)
  // Never stuck: an ended, settled agent whose parent has ended or still runs can be forgotten
  // by some active ancestor, unless no ancestor is active any more (the tree is winding down).
  val endedIsClearable = AGENTS.forall(id => {
    val par = PARENT.get(id)
    val settled = status(s, id) == Down
      and AGENTS.filter(x => isAncestor(id, x)).forall(x => status(s, x) == Down or status(s, x) == Unborn or status(s, x) == Gone)
    val parentSettledOrRunning = par != "" and (status(s, par) == Down or isActive(status(s, par)))
    val activeAncestors = AGENTS.filter(p => isAncestor(p, id) and isActive(status(s, p)))
    (settled and parentSettledOrRunning)
      implies (activeAncestors.size() == 0 or activeAncestors.exists(p => mayForget(s, p, id)))
  })

  // Sequencing: every op is applied at most once, in the order its sender sent it, and is never
  // silently dropped: it is applied, still in flight, or died with its client (reload, process end).
  val appliedOnce = not(s.dupApplied)
  val appliedInSendOrder = not(s.appliedOutOfOrder)
  val noSilentDrop = s.sentUids.forall(u => s.appliedUids.contains(u) or s.lostWithClient.contains(u)
    or AGENTS.exists(id => s.inflight.get(id).select(m => m.uid == u).length() > 0))
  // The current broker applies one connection's frames in arrival order: no seq_gap while the
  // expected frame is on that connection (only a 0.2.6 broker in a mixed tree does that).
  val brokerInOrder = not(s.legacyBroker) implies not(s.reorderGap)
  // A seq_gap never wedges a sender: with nothing in flight its next seq is the broker's next,
  // and a held frame at the head is the one the broker waits for, so it can be resent.
  val noWedge = AGENTS.forall(id => canAct(s, id) implies (
    (s.inflight.get(id).length() == 0 implies s.nextSeq.get(id) == s.lastSeq.get(id) + 1)
    and (s.inflight.get(id).length() > 0 and s.gapped.get(id).contains(s.inflight.get(id).head().uid)
      implies s.inflight.get(id).head().seq == s.lastSeq.get(id) + 1)))
  // Stopping the broker process (signal) never kills an agent: only a stopped, finished tree does.
  val noKillWithoutStop = not(s.killedWithoutStop)

  val all_invariants = downOnce and downNotified and consumedOnce and noLossOnAck and atLeastOnce
    and fifo and noOrphans and limits and leasesNeedConnection
    and forgetsOnlyDown and forgottenStaysGone and forgottenHoldsNothing
    and noForgetUnderRunningParent and endedIsClearable
    and appliedOnce and appliedInSendOrder and noSilentDrop and brokerInOrder and noWedge and noKillWithoutStop

  // ---------------- reachability witnesses (each MUST be violated by simulation) ----------------
  val witnessConsumed = AGENTS.forall(id => s.persisted.get(id).size() == 0)
  val witnessRedelivered = s.redeliveries == 0
  val witnessUrgentConsumed = not(s.urgentConsumed)
  val witnessRetransmitPending = not(AGENTS.exists(id => s.inflight.get(id).length() > 0
      and s.inflight.get(id).head().seq <= s.lastSeq.get(id) and not(s.connected.get(id))))
  val witnessTwoAccepted = s.acceptedBySender.size() < 2
  val witnessChildDown = AGENTS.forall(id => id == "r" or status(s, id) != Down)
  val witnessGrandchildKilledByLink = not(status(s, "a") == Down and status(s, "c") == Down)
  val witnessForgotten = s.forgotten.size() == 0
  // Every non-root agent has been started, which the cap of 2 allows only after one ended.
  val witnessPlaceReused = not(AGENTS.forall(id => status(s, id) != Unborn))
  // c ended while a ran; a was killed or lost later; the root then cleared c.
  val witnessClearedAfterParentKilled = not(s.forgottenBy.get("c") == "r" and s.endedBeforeParent.contains("c"))
  // A frame refused with seq_gap (a 0.2.6 broker reordered it) was resent and applied.
  val witnessGapRecovered = not(s.resentUids.exists(u => s.appliedUids.contains(u)))
  // After a broker SIGTERM and relaunch, a child is live and connected again.
  val witnessSigtermSurvived = not(s.sigtermed and s.brokerUp
    and AGENTS.exists(id => id != "r" and status(s, id) == Live and s.procAlive.get(id) and s.connected.get(id)))
  // A stopped tree finished and the broker told its Keepers to leave.
  val witnessTreeFinished = not(s.shutdownSent)

  // ---------------- deterministic scenario tests (quint test; mirrored as Tree unit tests) ----------------
  // The incident: op 1 (spawn{resume}) awaits the process check on a 0.2.6 broker; op 2 overtakes
  // it and is refused with seq_gap. The client holds op 2, resends it after op 1's answer, and
  // each op is applied once, in order.
  run seqGapRecoveredTest =
    initWith(true).then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(send("r", "a"))
      .then(brokerAcceptAt("r", 1))
      .then(all { assert(s.gapped.get("r") == Set(1) and s.lastSeq.get("r") == 0), s' = s })
      .then(brokerAccept("r")).then(clientAccepted("r")).then(clientResend("r"))
      .then(brokerAccept("r")).then(clientAccepted("r"))
      .then(all { assert(s.mailbox.get("a").length() == 2 and s.inflight.get("r").length() == 0 and all_invariants), s' = s })
      .then(send("r", "a")).then(brokerAccept("r")).then(clientAccepted("r"))
      .then(all { assert(s.mailbox.get("a").length() == 3 and all_invariants), s' = s })

  // The current broker never lets a frame overtake another on one connection.
  run inOrderBrokerTest =
    initWith(false).then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(send("r", "a"))
      .then(all { assert(canBrokerAccept(s, "r", 0) and not(canBrokerAccept(s, "r", 1))), s' = s })

  // A broker SIGTERM is a crash, not a tree stop: the child lives on and reconnects.
  run sigtermKeepsTreeTest =
    initWith(false).then(spawn("r", "a")).then(hello("a")).then(brokerSigterm)
      .then(all { assert(not(s.shutdownSent) and s.procAlive.get("a")), s' = s })
      .then(brokerRestart).then(hello("r")).then(hello("a"))
      .then(all { assert(status(s, "a") == Live and s.procAlive.get("a") and all_invariants), s' = s })

  // stop_tree: everything ends, then the finished broker tells the Keepers to leave.
  run stopTreeFinishesTest =
    initWith(false).then(spawn("r", "a")).then(hello("a")).then(stopTree)
      .then(all { assert(status(s, "a") == Killing and status(s, "r") == Down), s' = s })
      .then(processEnds("a")).then(procExitReported("a")).then(brokerFinish)
      .then(all { assert(s.shutdownSent and all_invariants), s' = s })

  run redeliveryAfterReloadTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(clientAccepted("r")).then(fetch("a")).then(inject("a")).then(persist("a")).then(reload("a"))
      .then(hello("a")).then(fetch("a"))
      .then(all { assert(s.redeliveries == 1 and s.batch.get("a").length() == 0 and all_invariants), s' = s })

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
      .then(all { assert(s.batch.get("a").length() == 1 and all_invariants), s' = s })
      .then(inject("a")).then(persist("a"))
      .then(all { assert(all_invariants), s' = s })

  // Fix F4: pi drops an injection; reclaim releases it; it is delivered and consumed exactly once.
  run droppedPushReclaimedTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(clientAccepted("r")).then(fetch("a")).then(inject("a")).then(piDrops("a"))
      .then(all { assert(s.fetched.get("a").length() == 0 and s.persisted.get("a").size() == 0), s' = s })
      .then(reclaim("a")).then(fetch("a")).then(inject("a")).then(persist("a")).then(ack("a"))
      .then(all { assert(s.persisted.get("a").size() == 1 and s.mailbox.get("a").length() == 0 and all_invariants), s' = s })

  // Fix N1: pi keeps an injection, reclaim redelivers it, then pi delivers its kept copy too.
  // The session holds both; the model consumes the message once.
  run keptPushNotSeenTwiceTest =
    init.then(spawn("r", "a")).then(hello("a")).then(send("r", "a")).then(brokerAccept("r"))
      .then(clientAccepted("r")).then(fetch("a")).then(inject("a")).then(piKeeps("a"))
      .then(reclaim("a")).then(fetch("a")).then(inject("a"))
      .then(all { assert(s.held.get("a").length() == 1 and s.fetched.get("a").length() == 1), s' = s })
      .then(piDeliversKept("a")).then(persist("a")).then(ack("a"))
      .then(all { assert(s.persisted.get("a").size() == 1 and s.mailbox.get("a").length() == 0 and all_invariants), s' = s })

  // The 0.2.8 incident: a sender's urgent message overtook its earlier, still queued one. Now the
  // first message waits in pi as the one injection; the urgent one stays in the broker until it
  // is consumed, and the two are consumed in send order.
  run urgentAfterQueuedMailTest =
    init.then(spawn("r", "a")).then(hello("a"))
      .then(sendWith("r", "a", false)).then(sendWith("r", "a", true))
      .then(brokerAccept("r")).then(clientAccepted("r")).then(brokerAccept("r")).then(clientAccepted("r"))
      .then(fetch("a")).then(injectAs("a", false))
      .then(all { assert(waiting(s, "a") and not(mayFetch(s, "a")) and s.mailbox.get("a").length() == 2), s' = s })
      .then(persist("a"))
      .then(all { assert(not(waiting(s, "a")) and mayFetch(s, "a")), s' = s })
      .then(fetch("a")).then(injectAs("a", false))
      .then(all { assert(s.steerLen.get("a") == 1 and s.fetched.get("a")[0].urgent), s' = s })
      .then(persist("a")).then(ack("a")).then(ack("a"))
      .then(all { assert(s.urgentConsumed and s.lastSeen.get("a").get("r") == 2 and s.mailbox.get("a").length() == 0 and all_invariants), s' = s })

  // Both messages arrived before the drain: one batch, in send order, as a steer.
  run urgentBatchInOrderTest =
    init.then(spawn("r", "a")).then(hello("a"))
      .then(sendWith("r", "a", false)).then(sendWith("r", "a", true))
      .then(brokerAccept("r")).then(clientAccepted("r")).then(brokerAccept("r")).then(clientAccepted("r"))
      .then(fetch("a")).then(fetch("a")).then(injectAs("a", false))
      .then(all { assert(s.steerLen.get("a") == 2 and s.fetched.get("a").length() == 2 and not(s.fetched.get("a")[0].urgent)), s' = s })
      .then(persist("a")).then(persist("a"))
      .then(all { assert(s.steerLen.get("a") == 0 and all_invariants), s' = s })

  // Forget: refused while a descendant is still ending; then the whole ended subtree goes, the
  // parent's DOWN notice stays, and the id can be neither spawned nor greeted again.
  run forgetSubtreeTest =
    init.then(spawn("r", "a")).then(hello("a")).then(spawn("a", "c")).then(hello("c"))
      .then(kill("r", "a")).then(processEnds("a")).then(procExitReported("a"))
      .then(all { assert(status(s, "a") == Down and status(s, "c") == Killing), s' = s })
      .then(all { assert(not(canForget(s, "r", "a"))), s' = s })
      .then(killingExpire("c")).then(forget("r", "a"))
      .then(all { assert(s.forgotten == Set("a", "c") and s.mailbox.get("r").length() == 1 and all_invariants), s' = s })
      .then(all { assert(not(canSpawn(s, "r", "a")) and not(canHello(s, "a"))), s' = s })

  // Parent-only clear: c ended while a runs, so the root may not forget it, a may; once a is
  // killed, the root may.
  run parentOnlyClearTest =
    init.then(spawn("r", "a")).then(hello("a")).then(spawn("a", "c")).then(hello("c"))
      .then(exit("c")).then(processEnds("c")).then(procExitReported("c"))
      .then(all { assert(status(s, "c") == Down and status(s, "a") == Live), s' = s })
      .then(all { assert(not(canForget(s, "r", "c")) and canForget(s, "a", "c") and all_invariants), s' = s })
      .then(kill("r", "a")).then(processEnds("a")).then(procExitReported("a"))
      .then(forget("r", "c"))
      .then(all { assert(s.forgotten == Set("c") and s.forgottenBy.get("c") == "r" and all_invariants), s' = s })
}
