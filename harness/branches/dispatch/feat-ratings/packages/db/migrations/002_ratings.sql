CREATE TABLE ratings (
  id serial PRIMARY KEY,
  delivery_id integer NOT NULL REFERENCES deliveries (id),
  stars integer NOT NULL
);
