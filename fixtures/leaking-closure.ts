/**
 * FIXTURE 3 — long-lived closures retaining memory via event listeners.
 *
 * Expected CoT findings: listeners registered in a loop and never removed;
 * each closure pins the element plus a large captured buffer for the
 * lifetime of the document.
 */
interface Frame {
  pixels: Uint8ClampedArray;
}

export function attach(selector: string): void {
  const elements = document.querySelectorAll(selector);
  const lastFrame: Frame = { pixels: new Uint8ClampedArray(1_000_000) };
  const history: string[] = [];

  elements.forEach((el, index) => {
    const label = `cell-${index}`;
    const capturedHistory = history; // closure captures shared array

    const onClick = (ev: Event): void => {
      const mouse = ev as MouseEvent;
      // BUG: closure retains lastFrame (1 MB) + element + history forever.
      history.push(`${label}:${mouse.clientX}`);
      console.log(lastFrame.pixels[0], el, capturedHistory.length);
    };

    el.addEventListener('click', onClick);
    // BUG: no removeEventListener, no returned dispose — listener lives
    // as long as the element (document lifetime), leaking every attach().
  });

  setTimeout(() => {
    // BUG: interval closure keeps `elements` NodeList alive.
    setInterval(() => console.log(elements.length), 10_000);
  }, 0);
}
