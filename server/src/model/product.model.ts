import { pool } from "../db/database.js";

class ProductModel {
    async create({ name, price }: { name: string, price: number }) {
        const q = await pool.query(
            'INSERT INTO products(name, price) VALUES ($1, $2) RETURNING id;', 
            [name, price]
        )
        const id = q.rows[0].id

        return id;
    }

    async list() {
        const q = await pool.query(
            'SELECT id, name, price FROM products;'
        );
        return q.rows;
    }
}

export { ProductModel }