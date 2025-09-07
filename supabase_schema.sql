-- Tables for collaborative sync
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(), -- equals auth.uid()
  email text unique
);

create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  color text,
  mode text not null default 'once',
  reset_hour int default 5,
  reset_minute int default 0,
  reset_weekday int default 1,
  reset_day_of_month int default 1,
  carry_over boolean default true,
  last_reset_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references public.lists(id) on delete cascade,
  title text not null,
  checked boolean default false,
  priority text default 'med',
  tags text[] default '{}',
  created_at timestamptz default now(),
  order_index int default 0
);

create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references public.lists(id) on delete cascade,
  list_name text,
  started_at timestamptz,
  ended_at timestamptz,
  total int,
  completed int,
  percent int,
  snapshot_json jsonb
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  endpoint text unique,
  p256dh text,
  auth text,
  created_at timestamptz default now()
);

-- RLS (simple: owner can read/write)
alter table public.lists enable row level security;
alter table public.tasks enable row level security;
alter table public.snapshots enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "owner_can_all_lists" on public.lists
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "owner_can_all_tasks" on public.tasks
  using (auth.uid() in (select user_id from public.lists where id = list_id))
  with check (auth.uid() in (select user_id from public.lists where id = list_id));

create policy "owner_can_all_snapshots" on public.snapshots
  using (auth.uid() in (select user_id from public.lists where id = list_id))
  with check (auth.uid() in (select user_id from public.lists where id = list_id));

create policy "owner_can_all_push" on public.push_subscriptions
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
