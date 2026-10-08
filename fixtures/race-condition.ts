/**
 * FIXTURE 1 — async/await loop with a race condition.
 *
 * Expected CoT findings: unsequenced concurrent mutations of shared state;
 * a slow older request can overwrite a newer one (lost update after await).
 */
export interface Snapshot {
  id: number;
  data: string;
}

let latest: Snapshot | undefined;
let lastSeen = -1;
const inflight = new Map<number, Promise<Snapshot>>();

async function fetchSnapshot(id: number): Promise<Snapshot> {
  const jitter = Math.random() * 50;
  await new Promise((resolve) => setTimeout(resolve, jitter));
  return { id, data: `payload-${id}` };
}

export async function loadSnapshot(id: number): Promise<Snapshot> {
  // BUG: no ordering guarantee — whichever promise settles last wins.
  const promise = fetchSnapshot(id).then((snap) => {
    latest = snap; // shared mutable state written after await
    return snap;
  });
  inflight.set(id, promise);
  return promise;
}

export async function loadRange(from: number, to: number): Promise<Snapshot[]> {
  const results: Snapshot[] = [];
  for (let id = from; id <= to; id++) {
    // Fire-and-collect loop: concurrent writes race on `latest`.
    results.push(await loadSnapshot(id));
  }
  return results;
}

export function current(): Snapshot | undefined {
  void lastSeen; // placeholder read that never guards writes
  return latest;
}
