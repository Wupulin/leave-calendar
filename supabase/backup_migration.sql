-- 在 Supabase SQL Editor 執行一次；僅服務端可存取含 PIN 雜湊的備份。
create table if not exists public.system_backups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid references public.members(id),
  reason text not null,
  payload jsonb not null
);
alter table public.system_backups enable row level security;
revoke all on public.system_backups from public, anon, authenticated;
grant all on public.system_backups to service_role;

create or replace function public.export_leave_backup()
returns jsonb language sql security invoker set search_path = public as $$
  select jsonb_build_object(
    'members', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from members m),
    'settings', (select to_jsonb(s) from phase_settings s where id = 1),
    'bookings', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from bookings b)
  );
$$;
revoke all on function public.export_leave_backup() from public, anon, authenticated;
grant execute on function public.export_leave_backup() to service_role;

create or replace function public.restore_leave_backup(p_data jsonb, p_actor uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  -- 整段還原在同一交易內；任何錯誤均回復原狀。
  lock table members, phase_settings, bookings in exclusive mode;
  if not exists (select 1 from members where id=p_actor and is_admin and is_active) then
    raise exception 'forbidden';
  end if;
  if not exists (select 1 from jsonb_populate_recordset(null::members, p_data->'members') m
                 where m.id=p_actor and m.is_admin and m.is_active)
     or (select count(*) from jsonb_populate_recordset(null::members, p_data->'members') m where m.is_admin) <> 1 then
    raise exception 'backup_admin_mismatch';
  end if;
  insert into system_backups(actor_id,reason,payload) values(p_actor,'before_restore',export_leave_backup());
  update members set is_admin=false where is_admin;
  insert into members select * from jsonb_populate_recordset(null::members, p_data->'members')
    on conflict(id) do update set name=excluded.name, unit=excluded.unit, pin_hash=excluded.pin_hash,
      is_admin=excluded.is_admin, is_active=excluded.is_active;
  delete from bookings;
  delete from phase_settings where id=1;
  insert into phase_settings select * from jsonb_populate_record(null::phase_settings,p_data->'settings');
  insert into bookings select * from jsonb_populate_recordset(null::bookings,p_data->'bookings');
  insert into audit_logs(actor_member_id,action,entity_type,after_data)
    values(p_actor,'restore_backup','system',jsonb_build_object('bookings',jsonb_array_length(p_data->'bookings')));
end;
$$;
revoke all on function public.restore_leave_backup(jsonb,uuid) from public, anon, authenticated;
grant execute on function public.restore_leave_backup(jsonb,uuid) to service_role;
