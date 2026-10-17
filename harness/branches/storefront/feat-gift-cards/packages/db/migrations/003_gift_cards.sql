CREATE TABLE gift_cards (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  balance numeric(10, 2) NOT NULL,
  status text NOT NULL
);

INSERT INTO gift_cards (code, balance, status) VALUES
  ('GIFT-2026-A', 50.00, 'active'),
  ('GIFT-2026-B', 25.00, 'active'),
  ('GIFT-2026-C', 0.00, 'spent');
