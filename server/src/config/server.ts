import fastify from "fastify";
import { env } from "./env.js";
import { ProductsController } from "../controller/products.controller.js";
import { OrdersController } from "../controller/orders.controller.js";
import { ProductModel } from "../model/product.model.js";
import { OrderModel } from "../model/order.model.js";
import client from "prom-client"
import { registerMetrics } from "./metrics.js";

const app = fastify();
registerMetrics(app);

const productsController = new ProductsController();
const ordersController = new OrdersController();

app.get(
    '/products',
    () => productsController.list()
);
app.get(
    '/orders',
    () => ordersController.list()
);
app.post(
    '/orders',
    (req, reply) => ordersController.create(req, reply)
);

app.listen({
    port: env.PORT,
    ...(env.HOST ? { host: env.HOST } : null)
}, () => {
    console.log(`Server already listen on ${env.PORT}`)
    console.log(app.printRoutes())
});
