// Every load number in the tests comes from this file: re-measure and update
// `measured` if the environment changes.

// Measured on 2026-11-23 with the API limited to 0.5 CPU / 256MB.
//   baselineSec: p95 latency with 1 VU (no queue)
//   maxRps:      http_reqs/s with 50 VUs and the CPU at the limit
export const measured = {
    read: { maxRps: 1100, baselineSec: 0.002 }, // GET /products
    buy: { maxRps: 600, baselineSec: 0.004 },   // POST /orders
}

// p95 < 500ms keeps a page with several API calls under ~1s (Nielsen's
// response time limits).
export const slo = {
    p95Ms: 500,
    maxErrorRate: 0.01,
}

// Premise, not measured: most visitors browse, few buy.
export const traffic = {
    readShare: 0.8,
    buyShare: 0.2,
}

// A mixed request costs the weighted sum of 1/readMax and 1/buyMax seconds of API time.
export const mixedMaxRps = Math.floor(
    1 / (traffic.readShare / measured.read.maxRps + traffic.buyShare / measured.buy.maxRps),
)

// Little's law: busy VUs = arrival rate × response time.
export function vusFor(ratePerSec: number, responseTimeSec: number): number {
    return Math.max(1, Math.ceil(ratePerSec * responseTimeSec))
}
