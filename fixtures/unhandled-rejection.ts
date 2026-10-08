/**
 * FIXTURE 2 — unhandled promise rejection cascade.
 *
 * Expected CoT findings: floating promises, `void`-ed rejections with no
 * handler, and a teardown path where one rejection masks the next.
 */
interface Job {
  name: string;
}

const queue: Job[] = [{ name: 'index' }, { name: 'notify' }];
let failed = 0;

async function process(job: Job): Promise<void> {
  if (job.name === 'notify') {
    throw new Error('smtp unavailable');
  }
}

async function syncAll(): Promise<void> {
  for (const job of queue) {
    await process(job); // first rejection aborts the loop and propagates
  }
}

function report(err: unknown): void {
  failed += 1;
  console.error(err);
}

export function startWorker(): void {
  syncAll(); // BUG: floating promise — rejection reaches nothing

  setInterval(() => {
    void syncAll(); // BUG: void-ed rejection, no .catch
  }, 5_000);

  queue.forEach((job) => {
    process(job).then(() => {
      console.log('done', job.name);
      // BUG: .then without .catch — rejection still unhandled
    });
  });

  window.addEventListener('beforeunload', () => {
    // BUG: teardown fires another unhandled async chain
    void syncAll().then(report);
  });
}
