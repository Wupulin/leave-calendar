-- 專科護理師排假系統：Supabase 初始資料庫結構
-- 在 Supabase Dashboard > SQL Editor > New query 貼上並執行。

create extension if not exists pgcrypto;

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  unit text not null default '' check (unit in ('ICU', '病房', '小夜', '大夜', '')),
  pin_hash text not null,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 全系統最多只能有一位管理員。
create unique index if not exists members_single_admin
  on public.members (is_admin)
  where is_admin = true;

create table if not exists public.phase_settings (
  id smallint primary key default 1 check (id = 1),
  booking_month date not null check (booking_month = date_trunc('month', booking_month)::date),
  phase1_end date not null,
  phase2_start date not null,
  phase2_end date not null,
  phase3_start date not null,
  phase3_end date not null,
  long_leave_start_month date not null check (long_leave_start_month = date_trunc('month', long_leave_start_month)::date),
  long_leave_end_month date not null check (long_leave_end_month = date_trunc('month', long_leave_end_month)::date),
  custom_holidays jsonb not null default '{}'::jsonb,
  day_notes jsonb not null default '{}'::jsonb,
  phase1_member_limit integer not null default 2 check (phase1_member_limit > 0),
  phase1_other_limit integer not null default 2 check (phase1_other_limit > 0),
  phase2_member_limit integer not null default 31 check (phase2_member_limit > 0),
  icu_daily_limit integer not null default 1 check (icu_daily_limit > 0),
  ward_daily_limit integer not null default 3 check (ward_daily_limit > 0),
  long_leave_daily_limit integer not null default 1 check (long_leave_daily_limit = 1),
  updated_by uuid references public.members(id),
  updated_at timestamptz not null default now(),
  check (phase2_start <= phase2_end),
  check (phase3_start <= phase3_end),
  check (long_leave_start_month <= long_leave_end_month)
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id),
  booking_date date not null,
  phase smallint not null check (phase in (1, 2, 3)),
  long_leave_block_id uuid,
  status text not null default 'reserved' check (status in ('reserved', 'confirmed', 'cancelled')),
  created_by uuid not null references public.members(id),
  admin_adjusted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (phase = 3 and long_leave_block_id is not null)
    or (phase in (1, 2) and long_leave_block_id is null)
  )
);

-- 同一成員同一天只能有一筆有效預約。
create unique index if not exists bookings_member_date_active
  on public.bookings (member_id, booking_date)
  where status <> 'cancelled';
create index if not exists bookings_date_idx on public.bookings (booking_date);
create index if not exists bookings_long_block_idx on public.bookings (long_leave_block_id)
  where long_leave_block_id is not null;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_member_id uuid references public.members(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists members_set_updated_at on public.members;
create trigger members_set_updated_at
before update on public.members
for each row execute function public.set_updated_at();

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
before update on public.bookings
for each row execute function public.set_updated_at();

-- 前端不可直接讀寫資料表；後續統一經由 Edge Functions 驗證 PIN 與權限。
alter table public.members enable row level security;
alter table public.phase_settings enable row level security;
alter table public.bookings enable row level security;
alter table public.audit_logs enable row level security;
revoke all on public.members from anon, authenticated;
revoke all on public.phase_settings from anon, authenticated;
revoke all on public.bookings from anon, authenticated;
revoke all on public.audit_logs from anon, authenticated;

-- 預設成員；所有 PIN 都是 00000 的 bcrypt 雜湊，不儲存明碼。
insert into public.members (name, unit, pin_hash, is_admin) values
  ('林怡君', 'ICU', crypt('00000', gen_salt('bf', 12)), true),
  ('林武甫', 'ICU', crypt('00000', gen_salt('bf', 12)), false),
  ('林曉楓', 'ICU', crypt('00000', gen_salt('bf', 12)), false),
  ('王彩蘋', 'ICU', crypt('00000', gen_salt('bf', 12)), false),
  ('葉靜婷', 'ICU', crypt('00000', gen_salt('bf', 12)), false),
  ('郭珮銜', '病房', crypt('00000', gen_salt('bf', 12)), false),
  ('張慧玲', '病房', crypt('00000', gen_salt('bf', 12)), false),
  ('李慧娟', '病房', crypt('00000', gen_salt('bf', 12)), false)
on conflict (name) do nothing;

insert into public.phase_settings (
  id, booking_month, phase1_end, phase2_start, phase2_end,
  phase3_start, phase3_end, long_leave_start_month, long_leave_end_month,
  updated_by
)
select
  1,
  date_trunc('month', current_date)::date,
  current_date,
  current_date,
  current_date,
  current_date,
  current_date,
  date_trunc('month', current_date)::date,
  date_trunc('month', current_date)::date,
  id
from public.members
where name = '林怡君'
on conflict (id) do nothing;
