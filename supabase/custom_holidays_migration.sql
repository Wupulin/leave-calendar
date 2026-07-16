-- 管理員自訂假日/非假日覆寫設定。
-- 請在 Supabase Dashboard > SQL Editor 貼上並執行。

alter table public.phase_settings
  add column if not exists custom_holidays jsonb not null default '{}'::jsonb;
