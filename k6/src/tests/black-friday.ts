// What happens when traffic jumps far above capacity all at once? It does not
// abort: the whole event is recorded, including the recovery.
//   k6 run src/tests/black-friday.ts
//   k6 run -e PEAK=5 src/tests/black-friday.ts   (peak 5× one replica)

import http from "k6/http"
import { check } from "k6"
import type { Options, Scenario } from "k6/options"
import { constants } from "../lib/constants.ts"
import { mixedMaxRps, measured, slo, traffic, vusFor } from "../lib/capacity.ts"

// Rates are multiples of the capacity of one replica, so the test means the
// same in any environment
const NORMAL = 0.3
const PEAK = Number(__ENV.PEAK || 3)

const normalRps = Math.round(mixedMaxRps * NORMAL)
const peakRps = Math.round(mixedMaxRps * PEAK)

const timeline = [
    { duration: "1m", rate: normalRps },
    { duration: "10s", rate: peakRps },     // midnight: the promotion opens
    { duration: "3m", rate: peakRps },
    { duration: "10s", rate: normalRps },
    { duration: "1m", rate: normalRps },    // recovery
]

function share(exec: string, fraction: number, capacity: { baselineSec: number }): Scenario {
    const peak = peakRps * fraction
    return {
        executor: "ramping-arrival-rate",
        exec,
        startRate: Math.round(normalRps * fraction),
        timeUnit: "1s",
        stages: timeline.map((s) => ({ duration: s.duration, target: Math.round(s.rate * fraction) })),
        // Same VU sizing as the breakpoint. Requests k6 cannot send once maxVUs
        // is reached become dropped_iterations: visitors who could not get in
        preAllocatedVUs: vusFor(peak, capacity.baselineSec) * 2,
        maxVUs: vusFor(peak, slo.p95Ms / 1000),
    }
}

export const options: Options = {
    scenarios: {
        browse: share("browse", traffic.readShare, measured.read),
        buy: share("buy", traffic.buyShare, measured.buy),
    },
    // No abortOnFail: they only report whether the event met the SLO
    thresholds: {
        "http_req_duration{scenario:browse}": [`p(95)<${slo.p95Ms}`],
        "http_req_duration{scenario:buy}": [`p(95)<${slo.p95Ms}`],
        http_req_failed: [`rate<${slo.maxErrorRate}`],
        dropped_iterations: ["count==0"],
    },
}

export function setup() {
    console.log(`One replica takes ≈ ${mixedMaxRps} req/s of mixed traffic`)
    console.log(`Normal: ${normalRps} req/s | Peak: ${peakRps} req/s (${PEAK}× one replica)`)
}

export function browse() {
    const res = http.get(`${constants.API_URL}/products`, { tags: { name: "GET /products" } })
    check(res, { "products: status 200": (r) => r.status === 200 })
}

export function buy() {
    const res = http.post(
        `${constants.API_URL}/orders`,
        JSON.stringify({
            product_id: Math.floor(Math.random() * constants.PRODUCT_COUNT) + 1,
            quantity: Math.floor(Math.random() * 3) + 1,
        }),
        { headers: { "Content-Type": "application/json" }, tags: { name: "POST /orders" } },
    )
    check(res, { "order: status 2xx": (r) => r.status >= 200 && r.status < 300 })
}
