// CI-only synchronization. A rendered loading state is not evidence that the
// browser's request has reached the route observer in the test process.
export function createBrowserRequestBarrier(timeoutMs = 15000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError("invalid_request_barrier_timeout");
  let observed;
  const event = new Promise(resolve => { observed = resolve; });
  return Object.freeze({
    observe: () => observed(),
    async wait() {
      let timer;
      try {
        await Promise.race([event, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("browser_request_not_observed")), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
  });
}
