# pi-actors spike (real pi 1.0.3)

All experiments use `_lib/faux.ts` (pi-ai's built-in `fauxProvider` registered via `pi.registerProvider`, model `faux/faux-1`/`faux-2`, scripted, no network) and `_lib/rpc.mjs` (spawns `pi --mode rpc -ne … -e <ext>`).
Run each with `node <name>/run.mjs <scratch-dir>`. `smoke/` checks the harness.
