CREATE TABLE charges (
  id serial PRIMARY KEY,
  order_id integer NOT NULL,
  amount numeric(10, 2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  handled_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
