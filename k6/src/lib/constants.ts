export const constants = {
    // k6 does not read .env files: pass it with `k6 run -e BASE_URL=...`
    API_URL: __ENV.BASE_URL || "http://localhost",
    // Rows inserted by server/src/db/migrations/03_seed_products.sql
    PRODUCT_COUNT: 64,
}
