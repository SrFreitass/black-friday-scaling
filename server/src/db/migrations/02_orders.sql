CREATE TABLE IF NOT EXISTS orders(
    id SERIAL PRIMARY KEY,
    product_id SERIAL,
    quantity INTEGER NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_product
    FOREIGN KEY(product_id) REFERENCES products(id)
);