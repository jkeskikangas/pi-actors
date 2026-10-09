#!/bin/sh
# Simulate every invariant, require every witness to be reachable, and require every
# injected bug (model/mutants.py) to be caught. Exhaustive checking (quint verify) needs Java.
set -e
cd "$(dirname "$0")"
Q="npx quint run pi_actors.qnt --max-samples=${SAMPLES:-20000} --max-steps=${STEPS:-40}"
echo "== scenarios"; npx quint test pi_actors.qnt | tail -2
echo "== invariants"; $Q --invariant=all_invariants | grep -E "^\[ok\]"
for w in witnessConsumed witnessRetransmitPending witnessTwoAccepted witnessChildDown witnessGrandchildKilledByLink witnessForgotten witnessClearedAfterParentKilled; do
  if $Q --invariant=$w >/dev/null 2>&1; then echo "UNREACHED witness $w"; exit 1; else echo "reached  $w"; fi
done
echo "== identity (pi_actors_identity.qnt)"
C="npx quint run pi_actors_identity.qnt --max-samples=${IDENTITY_SAMPLES:-5000} --max-steps=${STEPS:-40}"
npx quint test pi_actors_identity.qnt | tail -2
$C --invariant=all_invariants | grep -E "^\[ok\]"
for w in witnessResumed witnessTakeover; do
  if $C --invariant=$w >/dev/null 2>&1; then echo "UNREACHED witness $w"; exit 1; else echo "reached  $w"; fi
done
python3 mutants.py
