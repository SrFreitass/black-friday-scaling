import { pool } from "../db/database.js";

class OrderModel {
    async create({ product_id, quantity }: { product_id: number, quantity: number }) {
        const productQuery = await pool.query("SELECT id, price FROM products WHERE id = $1", [product_id]);
        if(!productQuery.rowCount) {
            return {
                error: `Product ${product_id} not found`
            };
        }
        const product = productQuery.rows[0]
        const price = product.price * quantity
        const q = await pool.query(
            'INSERT INTO orders(product_id, quantity, price) VALUES ($1, $2, $3) RETURNING id, created_at', 
            [product_id, quantity, price]
        )
        const orderCreated = q.rows[0]
        return {
            id: orderCreated.id,
            product_id,
            quantity,
            price,
            created_at: orderCreated.created_at
        };
    }

    async list() {
        const q = await pool.query(
            'SELECT id, product_id, quantity, price, created_at FROM orders'
        );
        return q.rows;
    }    
}

export { OrderModel }