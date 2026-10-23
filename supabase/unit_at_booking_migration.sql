-- 保存每筆預約建立當下的成員班別。
-- 用途：過去月份固定顯示預約當時班別；本月與未來月份仍依成員基本資料即時更新。
-- 請在 Supabase Dashboard > SQL Editor 貼上並執行。

alter table public.bookings
  add column if not exists unit_at_booking text not null default '';

update public.bookings b
set unit_at_booking = coalesce(nullif(b.unit_at_booking, ''), m.unit, '')
from public.members m
where b.member_id = m.id
  and coalesce(b.unit_at_booking, '') = '';
