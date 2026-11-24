INSERT INTO products(name, price)
SELECT v.name, v.price
FROM (VALUES
    -- Electronics
    ('Galaxy A55 Smartphone 128GB', 2199.90),
    ('Ultrathin 14" Laptop i5 16GB', 4599.00),
    ('Bluetooth Headphones', 189.90),
    ('50" 4K Smart TV', 2799.00),
    ('Ergonomic Wireless Mouse', 99.90),
    ('RGB Mechanical Keyboard', 349.90),
    ('27" IPS Monitor 144Hz', 1499.00),
    ('65W USB-C Charger', 129.90),
    ('Portable Speaker', 279.90),
    ('Fitness Smartwatch', 599.00),
    ('1TB NVMe SSD', 459.90),
    ('Full HD Webcam', 219.90),

    -- Home & kitchen
    ('30-Cup Electric Coffee Maker', 149.90),
    ('4L Air Fryer', 399.90),
    ('1200W Blender', 229.90),
    ('5-Piece Nonstick Cookware Set', 349.00),
    ('30L Microwave Oven', 649.00),
    ('Stick Vacuum Cleaner', 499.90),
    ('Queen Sheet Set 400 Thread Count', 189.90),
    ('Memory Foam Pillow', 89.90),
    ('1L Thermos Bottle', 79.90),
    ('6-Piece Stainless Steel Knife Set', 159.90),

    -- Clothing & shoes
    ('Basic Cotton T-Shirt', 49.90),
    ('Slim Fit Jeans', 159.90),
    ('Running Shoes', 399.90),
    ('Windbreaker Jacket', 229.90),
    ('Hooded Sweatshirt', 179.90),
    ('Athletic Socks (3-Pack)', 39.90),
    ('Curved Brim Cap', 69.90),
    ('Rubber Flip-Flops', 34.90),

    -- Sports & outdoors
    ('29" Mountain Bike 21-Speed', 1899.00),
    ('5kg Rubber Dumbbell', 89.90),
    ('Yoga Mat', 99.90),
    ('Official Soccer Ball', 149.90),
    ('Ball Bearing Jump Rope', 44.90),
    ('4-Person Camping Tent', 449.00),
    ('750ml Sports Bottle', 29.90),

    -- Books & stationery
    ('Book: Algorithms and Data Structures', 129.90),
    ('Book: Kubernetes in Practice', 99.90),
    ('10-Subject Spiral Notebook', 32.90),
    ('Ballpoint Pens (Box of 50)', 59.90),
    ('15" Laptop Backpack', 189.90),
    ('2027 Planner', 44.90),

    -- Grocery
    ('Whole Bean Coffee 1kg', 69.90),
    ('Extra Virgin Olive Oil 500ml', 42.90),
    ('White Rice 5kg', 27.90),
    ('Pinto Beans 1kg', 8.49),
    ('Milk Chocolate Bar 90g', 7.99),
    ('Mineral Water 1.5L', 3.29),
    ('Sandwich Cookies 130g', 3.99),

    -- Beauty & personal care
    ('Shampoo 400ml', 24.90),
    ('Sunscreen SPF 50', 59.90),
    ('Soft Toothbrush', 12.90),
    ('Eau de Parfum 100ml', 279.00),
    ('2000W Hair Dryer', 199.90),

    -- Pets
    ('Adult Dog Food 15kg', 219.90),
    ('Cat Litter 4kg', 24.90),
    ('Cat Scratching Post', 129.90),
    ('Adjustable Pet Collar', 39.90),

    -- Toys & games
    ('Video Game Console', 3999.00),
    ('Wireless Controller', 449.90),
    ('1000-Piece Jigsaw Puzzle', 79.90),
    ('500-Piece Building Blocks', 199.90),
    ('Board Game', 149.90)
) AS v(name, price)
WHERE NOT EXISTS (SELECT 1 FROM products);
