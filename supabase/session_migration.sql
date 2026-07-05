-- 正式版登入 session。請在 schema.sql 成功後，於 SQL Editor 執行本檔。
create table if not exists public.member_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists member_sessions_member_idx on public.member_sessions(member_id);
create index if not exists member_sessions_expiry_idx on public.member_sessions(expires_at);
alter table public.member_sessions enable row level security;
revoke all on public.member_sessions from anon, authenticated;

-- 使用 PostgreSQL 原生 crypt 驗證與更新 PIN，避免將雜湊傳回前端。
create or replace function public.verify_member_pin(p_member_id uuid, p_pin text)
returns table(id uuid, name text, unit text, is_admin boolean, is_active boolean)
language sql
security definer
set search_path = public
as $$
  select m.id, m.name, m.unit, m.is_admin, m.is_active
  from public.members m
  where m.id = p_member_id
    and m.is_active = true
    and m.pin_hash = extensions.crypt(p_pin, m.pin_hash);
$$;

create or replace function public.set_member_pin(p_member_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_new_pin !~ '^[0-9]{5}$' then
    raise exception 'PIN must contain exactly five digits';
  end if;
  update public.members
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 12))
  where id = p_member_id;
end;
$$;

create or replace function public.hash_pin(p_pin text)
returns text
language sql
security definer
set search_path = public
as $$
  select extensions.crypt(p_pin, extensions.gen_salt('bf', 12));
$$;

revoke all on function public.verify_member_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.set_member_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.verify_member_pin(uuid, text) to service_role;
grant execute on function public.set_member_pin(uuid, text) to service_role;
revoke all on function public.hash_pin(text) from public, anon, authenticated;
grant execute on function public.hash_pin(text) to service_role;
