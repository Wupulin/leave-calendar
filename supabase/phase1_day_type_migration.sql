-- 第一階段分成「假日前後」與「其他」兩種可預約天數。
-- 請在 Supabase Dashboard > SQL Editor 貼上並執行。

alter table public.phase_settings
  add column if not exists phase1_other_limit integer not null default 2
  check (phase1_other_limit > 0);
