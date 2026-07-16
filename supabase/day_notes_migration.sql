-- 管理員每日文字備註設定。
-- 請在 Supabase Dashboard > SQL Editor 貼上並執行。

alter table public.phase_settings
  add column if not exists day_notes jsonb not null default '{}'::jsonb;
