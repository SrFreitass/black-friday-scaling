import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { OrderModel } from "../model/order.model.js";

class OrdersController {
    private orderModel = new OrderModel();

    async create(req: FastifyRequest, reply: FastifyReply) {
        const body = req.body as { product_id: number, quantity: number }

        if(body.quantity <= 0) {
            reply.code(400)
            return {
                error: 'quantity must be a positive integer'
            }
        }

        if(isNaN(body.product_id)) {
            reply.code(400)
            return {
                error: 'product_id must be a positive integer'
            }
        }

        const output = await this.orderModel.create(body)
        if(output.error) reply.code(400);
        return output;
    }

    async list() {
        return this.orderModel.list()
    }
}

export { OrdersController }; { OrdersController };