// How many req/s can ONE replica take before breaking the SLO? The rate grows
// until the SLO fails; the test aborts and teardown() prints the rate reached.
// One endpoint per run, so they don't share the CPU:
//   k6 run -e TARGET=read src/tests/breakpoint.ts   (GET /products, default)
//   k6 run -e TARGET=buy  src/tests/breakpoint.ts   (POST /orders)

import http from "k6/http"
import { check } from "k6"
import type { Options, Scenario } from "k6/options"
import { constants } from "../lib/constants.ts"
import { measured, slo, vusFor } from "../lib/capacity.ts"

// Up to 3× the measured max throughput, so the ramp surely passes the limit
const OVERSHOOT = 3
// Slow ramp for precision: the rate grows ~0.5% of the capacity per second
const RAMP = { duration: "10m", seconds: 600 }
const START_FRACTION = 0.1

const TARGETS = {
    read: { scenario: "list_products_breakpoint", exec: "listProducts", capacity: measured.read },
    buy: { scenario: "create_order_breakpoint", exec: "createOrder", capacity: measured.buy },
}
const TARGET = TARGETS[(__ENV.TARGET || "read") as keyof typeof TARGETS]
if (!TARGET) throw new Error("TARGET must be 'read' or 'buy'")

const startRate = Math.ceil(TARGET.capacity.maxRps * START_FRACTION)
const targetRate = TARGET.capacity.maxRps * OVERSHOOT

function breakpointScenario(exec: string, capacity: { maxRps: number, baselineSec: number }): Scenario {
    const target = targetRate

    return {
        executor: "ramping-arrival-rate",
        exec,
        startRate,
        timeUnit: "1s",
        stages: [{ target, duration: RAMP.duration }],
        // Healthy latency (×2 margin) to pre-allocate; SLO latency as the ceiling:
        // needing more VUs means responses are already slower than the SLO, and
        // more VUs only add pressure (20k VUs got the API OOMKilled at 256MB)
        preAllocatedVUs: vusFor(target, capacity.baselineSec) * 2,
        maxVUs: vusFor(target, slo.p95Ms / 1000),
    }
}

export const options: Options = {
    scenarios: {
        [TARGET.scenario]: breakpointScenario(TARGET.exec, TARGET.capacity),
    },
    // The SLO defines the break; delayAbortEval ignores the warm-up seconds
    thresholds: {
        http_req_duration: [{ threshold: `p(95)<${slo.p95Ms}`, abortOnFail: true, delayAbortEval: "10s" }],
        http_req_failed: [{ threshold: `rate<${slo.maxErrorRate}`, abortOnFail: true, delayAbortEval: "10s" }],
    },
}

export function setup() {
    return { startedAt: Date.now() }
}

export function listProducts() {
    const res = http.get(`${constants.API_URL}/products`, { tags: { name: "GET /products" } })
    check(res, { "products: status 200": (r) => r.status === 200 })
}

export function createOrder() {
    const res = http.post(
        `${constants.API_URL}/orders`,
        JSON.stringify({
            product_id: Math.floor(Math.random() * constants.PRODUCT_COUNT) + 1,
            quantity: 1,
        }),
        { headers: { "Content-Type": "application/json" }, tags: { name: "POST /orders" } },
    )
    check(res, { "order: status 2xx": (r) => r.status >= 200 && r.status < 300 })
}

// Also runs after an abort: converts the elapsed time into the rate reached.
// Thresholds are cumulative, so this is an upper estimate of the breakpoint.
export function teardown(data: ReturnType<typeof setup>) {
    const elapsedSec = (Date.now() - data.startedAt) / 1000
    const progress = Math.min(elapsedSec / RAMP.seconds, 1)
    const rateAtEnd = Math.round(startRate + (targetRate - startRate) * progress)

    console.log(`Elapsed ${elapsedSec.toFixed(0)}s of ${RAMP.seconds}s -> arrival rate ≈ ${rateAtEnd} req/s`)
    console.log(progress < 1
        ? `Aborted by the SLO: breakpoint ≈ ${rateAtEnd} req/s (measured max throughput: ${TARGET.capacity.maxRps})`
        : "Reached the end of the ramp without breaking the SLO: raise OVERSHOOT")
}
