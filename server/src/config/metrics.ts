import type { FastifyInstance } from "fastify";
import client from "prom-client"

client.collectDefaultMetrics();

const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ["method", "route", "status_code"],
})

function registerMetrics(app: FastifyInstance) {
    app.addHook('onResponse', async (req, reply) => {
        const route = req.routeOptions.url ?? 'unmatched';
        if(route === '/metrics') return;

        httpRequestDuration
            .labels(req.method, route, String(reply.statusCode))
            .observe(reply.elapsedTime / 1000)
    });

    app.get(
        '/metrics',
        async (_req, reply) => {
            reply.header("content-type", client.register.contentType);
            return client.register.metrics();
        }
    )
}

export { registerMetrics };
