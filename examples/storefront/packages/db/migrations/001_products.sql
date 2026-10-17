CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  price numeric(10, 2) NOT NULL,
  stock integer NOT NULL
);

INSERT INTO products (sku, name, price, stock) VALUES
  ('MUG-01', 'Ceramic mug', 14.00, 120),
  ('NOTE-02', 'Dot grid notebook', 9.50, 300),
  ('LAMP-03', 'Desk lamp', 48.00, 35),
  ('BOTL-04', 'Water bottle', 22.00, 80),
  ('TOTE-05', 'Canvas tote', 18.00, 150);
