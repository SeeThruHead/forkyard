CREATE TABLE couriers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  zone text NOT NULL
);

INSERT INTO couriers (name, zone) VALUES
  ('Ada', 'north'),
  ('Grace', 'south'),
  ('Linus', 'east'),
  ('Margaret', 'west');

CREATE TABLE deliveries (
  id serial PRIMARY KEY,
  address text NOT NULL,
  courier_id integer REFERENCES couriers (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_events (
  id serial PRIMARY KEY,
  delivery_id integer NOT NULL REFERENCES deliveries (id),
  step text NOT NULL,
  namespace text NOT NULL,
  handled_by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliations (
  id serial PRIMARY KEY,
  deliveries integer NOT NULL,
  handled_by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
