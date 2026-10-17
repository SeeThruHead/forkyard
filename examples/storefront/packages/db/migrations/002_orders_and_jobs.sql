CREATE TABLE orders (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products (id),
  quantity integer NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  done_by text
);
