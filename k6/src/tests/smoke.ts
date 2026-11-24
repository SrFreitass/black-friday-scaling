// Does everything work with minimal load? Run it before any other test.
//   k6 run src/tests/smoke.ts

import http from "k6/http"
import { check, group } from "k6"
import type { Options } from "k6/options"
import { constants } from "../lib/constants.ts"

export const options: Options = {
    scenarios: {
        smoke: {
            executor: "per-vu-iterations",
            vus: 1,
            iterations: 5,
        },
    },
    thresholds: {
        checks: ["rate==1"],
        http_req_failed: ["rate==0"],
    },
}

type Product = { id: number, name: string, price: string }
type Order = { id: number, product_id: number, quantity: number, price: number }

const JSON_HEADERS = { "Content-Type": "application/json" }

export default function () {
    let product: Product | undefined

    group("browse catalog", () => {
        const res = http.get(`${constants.API_URL}/products`, { tags: { name: "GET /products" } })
        const products = res.json() as Product[]

        check(res, {
            "products: status 200": (r) => r.status === 200,
            // A 200 with an empty list is not a success: it means the seed did not run
            "products: seeded catalog": () => products.length === constants.PRODUCT_COUNT,
        })

        product = products[Math.floor(Math.random() * products.length)]
    })

    group("buy a product", () => {
        if (!product) return

        const quantity = 2
        const res = http.post(
            `${constants.API_URL}/orders`,
            JSON.stringify({ product_id: product.id, quantity }),
            { headers: JSON_HEADERS, tags: { name: "POST /orders" } },
        )
        const order = res.json() as Order

        check(res, {
            "order: status 2xx": (r) => r.status >= 200 && r.status < 300,
            "order: has an id": () => typeof order.id === "number",
            "order: price = product price × quantity": () =>
                Math.abs(Number(order.price) - Number(product!.price) * quantity) < 0.01,
        })
    })

    group("invalid order is rejected", () => {
        const res = http.post(
            `${constants.API_URL}/orders`,
            JSON.stringify({ product_id: 99999, quantity: 1 }),
            {
                headers: JSON_HEADERS,
                tags: { name: "POST /orders (invalid)" },
                // The 400 is expected here, so it must not count in http_req_failed
                responseCallback: http.expectedStatuses(400),
            },
        )

        check(res, {
            "invalid order: status 400": (r) => r.status === 400,
        })
    })

    group("list orders", () => {
        const res = http.get(`${constants.API_URL}/orders`, { tags: { name: "GET /orders" } })

        check(res, {
            "orders: status 200": (r) => r.status === 200,
        })
    })
}
