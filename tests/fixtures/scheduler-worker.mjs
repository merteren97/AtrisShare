import { workerData, parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../../dist/packages/storage/src/store.js";
import { ScheduleStore } from "../../dist/packages/storage/src/schedule-store.js";
const w = new WorkspaceStore(workerData.path), db = new DatabaseSync(workerData.path);
db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
try {
  const barrier = new Int32Array(workerData.barrier);
  Atomics.add(barrier, 0, 1);
  Atomics.wait(barrier, 1, 0, 10000);
  new ScheduleStore(db, c => w.resolveContext(c), () => {}, () => workerData.now).tick();
  parentPort.postMessage({ done: true });
} finally { db.close(); w.close(); }
