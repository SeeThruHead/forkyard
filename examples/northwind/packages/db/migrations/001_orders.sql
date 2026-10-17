CREATE TABLE orders (
  id serial PRIMARY KEY,
  sku text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'placed',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_events (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders (id),
  step text NOT NULL,
  handled_by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id serial PRIMARY KEY,
  subject text NOT NULL,
  payload jsonb NOT NULL,
  sent_at timestamptz
);

CREATE TABLE kyc_events (
  id serial PRIMARY KEY,
  status text NOT NULL,
  handled_by text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE digests (
  id serial PRIMARY KEY,
  orders integer NOT NULL,
  handled_by text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
