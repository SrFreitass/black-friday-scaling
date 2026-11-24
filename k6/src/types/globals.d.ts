// k6 has a global `console`, but @types/k6 does not declare it and the "dom"
// lib is not loaded (k6 has no browser APIs).
declare const console: {
    log(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
    debug(...args: unknown[]): void
}
