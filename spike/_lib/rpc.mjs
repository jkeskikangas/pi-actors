// Minimal RPC driver: spawn pi --mode rpc, send JSON lines, collect events.
import { spawn } from "node:child_process";
export function startPi(args, opts = {}) {
  const t0 = Date.now();
  const p = spawn("pi", ["--mode", "rpc", "-ne", "-ns", "-np", "-nc", "--no-themes", "--offline", "--model", "faux/faux-1", ...args], { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } });
  const events = []; let buf = ""; const waiters = [];
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let ev; try { ev = JSON.parse(line); } catch { ev = { raw: line }; } ev._t = Date.now() - t0; events.push(ev); if (opts.log) console.log("<", line.slice(0, 300)); for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.res(ev); } } });
  let stderr = ""; p.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((res) => p.on("exit", (code, sig) => res({ code, sig, t: Date.now() - t0 })));
  return {
    p, events, exited, get stderr() { return stderr; }, t0,
    send(obj) { p.stdin.write(JSON.stringify(obj) + "\n"); },
    waitFor(pred, ms = 15000) { const hit = events.find(pred); if (hit) return Promise.resolve(hit); return new Promise((res, rej) => { const w = { pred, res }; waiters.push(w); setTimeout(() => rej(new Error("timeout waiting; last events: " + JSON.stringify(events.slice(-5)).slice(0, 2000) + "\nstderr:" + stderr.slice(-2000))), ms); }); },
  };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
