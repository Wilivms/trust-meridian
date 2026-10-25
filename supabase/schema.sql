-- Trust Meridian · off-chain data (the chain stays the source of truth for money).
-- Run once in the Supabase SQL editor.

-- Guests who joined from the QR code: their island in the Harbor.
create table if not exists guests (
  wallet text primary key,            -- smart account contract id (C...)
  name text not null check (char_length(name) between 1 and 24),
  city text not null,
  berth int,
  created_at timestamptz default now()
);

-- Cover help requests (amounts and payee live here; the escrow and the
-- payment live on-chain; the bill photo is never stored, only its hash).
create table if not exists requests (
  id bigint generated always as identity primary key,
  by_wallet text not null,
  for_name text not null,
  city text not null,
  kind text not null,
  title text not null,
  payee text not null,
  amount numeric not null,
  currency text not null,
  usdc numeric,
  due date,
  reference text,
  message text,
  bill_hash text,
  escrow text,                          -- Trustless Work escrow contract id
  status text not null default 'open',  -- open | funded | paid
  paid_tx text,
  created_at timestamptz default now()
);

-- Labels for on-chain objects (circle/group names are on-chain too; this
-- keeps display data like cities and avatars).
create table if not exists members (
  wallet text primary key,
  name text not null,
  city text,
  color text,
  is_bot boolean default false
);

-- Transactions mirrored for the Live Ledger (written by the server after
-- confirmation; read by everyone in real time).
create table if not exists ledger (
  hash text primary key,
  what text not null,
  kind text not null,
  ledger int,
  created_at timestamptz default now()
);

alter table guests enable row level security;
alter table requests enable row level security;
alter table members enable row level security;
alter table ledger enable row level security;

create policy "read all guests" on guests for select using (true);
create policy "read all requests" on requests for select using (true);
create policy "read all members" on members for select using (true);
create policy "read all ledger" on ledger for select using (true);
-- Writes go through the server (service role), which checks the chain first.

alter publication supabase_realtime add table guests;
alter publication supabase_realtime add table requests;
alter publication supabase_realtime add table ledger;
