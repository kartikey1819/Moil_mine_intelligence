/* Small worker-thread pool for the Monte-Carlo engine: forecasts for different mines / scenarios run
 * in parallel on all cores and the HTTP event loop never blocks. */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';

const WORKER = path.join(import.meta.dirname, '..', 'workers', 'forecast-worker.mjs');

export class Pool {
  constructor(size = Math.max(2, Math.min(6, os.cpus().length - 1))) {
    this.size = size; this.workers = []; this.queue = []; this.nextId = 1; this.pending = new Map();
    for (let i = 0; i < size; i++) this.#spawn();
  }
  #spawn() {
    const w = new Worker(WORKER, { execArgv: ['--no-warnings'] });
    w.busy = false;
    w.on('message', (msg) => {
      const job = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      w.busy = false;
      if (job) msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg.result);
      this.#drain();
    });
    w.on('error', (e) => { console.error('[pool] worker error', e); });
    w.on('exit', (code) => {
      this.workers = this.workers.filter((x) => x !== w);
      for (const [id, job] of this.pending) if (job.worker === w) { job.reject(new Error(`worker exited (${code})`)); this.pending.delete(id); }
      if (!this.closing) this.#spawn();
    });
    this.workers.push(w);
  }
  run(task) {
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.#drain(); });
  }
  #drain() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift(), id = this.nextId++;
      w.busy = true; job.worker = w;
      this.pending.set(id, job);
      w.postMessage({ id, ...job.task });
    }
  }
  /** Broadcast (e.g. "model retrained") — reaches idle and busy workers alike. */
  broadcast(msg) { for (const w of this.workers) w.postMessage({ id: 0, broadcast: true, ...msg }); }
  async close() { this.closing = true; await Promise.all(this.workers.map((w) => w.terminate())); }
}

let pool;
export const getPool = () => (pool ||= new Pool());
