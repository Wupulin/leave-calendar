-- 新增小夜、大夜與空白工作類別。既有資料不受影響。
alter table public.members drop constraint if exists members_unit_check;
alter table public.members alter column unit set default '';
alter table public.members add constraint members_unit_check
  check (unit in ('ICU', '病房', '小夜', '大夜', ''));
