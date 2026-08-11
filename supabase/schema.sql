-- The Recoverer — case persistence schema
-- Run this once in the Supabase SQL Editor for the new "recoverer" project.

create table if not exists cases (
  token uuid primary key,
  case_title text,
  case_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Row Level Security is enabled with NO policies attached below. In Supabase,
-- that means the anon/authenticated client roles have ZERO access — no read,
-- no write, nothing — regardless of what key ends up in a browser. Only the
-- service role key (used exclusively, server-side, inside api/case.js) can
-- touch this table. The browser never talks to Supabase directly.
alter table cases enable row level security;

-- Keep updated_at accurate on every write, without the app having to remember to set it.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists cases_set_updated_at on cases;
create trigger cases_set_updated_at
before update on cases
for each row execute function set_updated_at();
