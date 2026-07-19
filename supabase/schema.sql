-- TIDEPOOL schema. Run in the Supabase SQL editor.

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  avatar_emoji text default '🐚',
  xp int default 0,
  created_at timestamptz default now()
);

create table if not exists scores (
  id bigserial primary key,
  user_id uuid references profiles on delete cascade,
  game_id text not null,
  level int not null check (level between 1 and 50),
  result_type text not null check (result_type in ('time','score')),
  value numeric not null,
  stars int default 1,
  created_at timestamptz default now(),
  unique (user_id, game_id, level)
);
create index if not exists scores_board on scores (game_id, level, value);

create table if not exists friendships (
  requester_id uuid references profiles on delete cascade,
  addressee_id uuid references profiles on delete cascade,
  status text default 'pending' check (status in ('pending','accepted','declined','blocked')),
  created_at timestamptz default now(),
  primary key (requester_id, addressee_id)
);

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid references profiles on delete cascade,
  to_user   uuid references profiles on delete cascade,
  game_id text not null,
  level int not null,
  seed text not null,
  from_result numeric,
  to_result numeric,
  status text default 'open',
  winner_id uuid,
  turn_of uuid,
  created_at timestamptz default now()
);

create table if not exists reactions (
  challenge_id uuid references challenges on delete cascade,
  user_id uuid references profiles on delete cascade,
  emoji text not null,
  created_at timestamptz default now(),
  primary key (challenge_id, user_id)
);

create table if not exists notifications (
  id bigserial primary key,
  user_id uuid references profiles on delete cascade,
  type text not null,
  payload jsonb default '{}',
  read_at timestamptz,
  created_at timestamptz default now()
);

-- aggregate board: total time (or score) across cleared levels of a game
create or replace view leaderboard_totals as
select s.user_id, s.game_id, p.username, p.avatar_emoji,
       count(*)::int as levels_cleared,
       sum(s.stars)::int as stars,
       sum(s.value) as total,
       max(s.created_at)::date as day
from scores s join profiles p on p.id = s.user_id
group by s.user_id, s.game_id, p.username, p.avatar_emoji
order by levels_cleared desc, total asc;

-- Create the profile row on signup.
-- This runs inside the auth transaction: if it raises, the whole account
-- creation fails and the app sees an empty error. So it defends itself —
-- it de-duplicates usernames and never lets a failure block signup.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), '');
  if base is null then
    base := 'player_' || left(new.id::text, 6);
  end if;
  base := left(base, 18);
  candidate := base;

  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := left(base, 15) || n::text;
  end loop;

  insert into public.profiles (id, username)
  values (new.id, candidate)
  on conflict (id) do nothing;

  return new;
exception when others then
  -- the app creates the row on first sign-in if this ever falls through
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

create or replace function add_xp(p_user uuid, p_xp int) returns void
language sql security definer as $$
  update profiles set xp = xp + p_xp where id = p_user;
$$;

-- RLS: everything readable for boards, writes go through the service role only
alter table profiles      enable row level security;
alter table scores        enable row level security;
alter table friendships   enable row level security;
alter table challenges    enable row level security;
alter table reactions     enable row level security;
alter table notifications enable row level security;

drop policy if exists "read profiles"  on profiles;
drop policy if exists "own profile"    on profiles;
drop policy if exists "insert own profile" on profiles;
create policy "read profiles"      on profiles for select using (true);
create policy "own profile"        on profiles for update using (auth.uid() = id);
create policy "insert own profile" on profiles for insert with check (auth.uid() = id);
create policy "read scores"    on scores        for select using (true);
create policy "own edges"      on friendships   for select using (auth.uid() in (requester_id, addressee_id));
create policy "own challenges" on challenges    for select using (auth.uid() in (from_user, to_user));
create policy "read reactions" on reactions     for select using (true);
create policy "own notifs"     on notifications for select using (auth.uid() = user_id);

-- realtime: the app subscribes to its own notifications for live turn alerts
alter publication supabase_realtime add table notifications;
