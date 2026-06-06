-- Миграция на авторизацию (один пациент = один аккаунт).
-- Выполните в Supabase → SQL Editor ПОСЛЕ включения Email в Authentication → Providers.

-- 1. Новая таблица с привязкой к auth.users
create table if not exists public.cst_user_data (
    user_id uuid primary key references auth.users(id) on delete cascade,
    entries jsonb not null default '{}'::jsonb,
    profile jsonb not null default '{"name":"","gender":"","age":""}'::jsonb,
    profile_updated_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create or replace function public.cst_user_data_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists cst_user_data_updated_at on public.cst_user_data;
create trigger cst_user_data_updated_at
    before update on public.cst_user_data
    for each row
    execute function public.cst_user_data_set_updated_at();

alter table public.cst_user_data enable row level security;

drop policy if exists "cst_user_select_own" on public.cst_user_data;
create policy "cst_user_select_own"
    on public.cst_user_data for select
    to authenticated
    using (auth.uid() = user_id);

drop policy if exists "cst_user_insert_own" on public.cst_user_data;
create policy "cst_user_insert_own"
    on public.cst_user_data for insert
    to authenticated
    with check (auth.uid() = user_id);

drop policy if exists "cst_user_update_own" on public.cst_user_data;
create policy "cst_user_update_own"
    on public.cst_user_data for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- 2. Убрать публичный доступ к старой таблице (если была)
drop policy if exists "cst_anon_read" on public.cst_app_data;
drop policy if exists "cst_anon_write" on public.cst_app_data;
drop policy if exists "cst_anon_update" on public.cst_app_data;

-- 3. (Опционально) перенос данных из cst_app_data id='main' в аккаунт пациента:
--    Supabase → Authentication → Users → скопируйте UUID пользователя, затем:
--
-- insert into public.cst_user_data (user_id, entries, profile, profile_updated_at)
-- select 'ВАШ_USER_UUID'::uuid, entries, profile, profile_updated_at
-- from public.cst_app_data where id = 'main'
-- on conflict (user_id) do update set
--   entries = excluded.entries,
--   profile = excluded.profile,
--   profile_updated_at = excluded.profile_updated_at;
