-- CST: одна строка данных для личного использования (без авторизации).
-- Выполните в Supabase → SQL Editor после создания проекта.

create table if not exists public.cst_app_data (
    id text primary key default 'main',
    entries jsonb not null default '{}'::jsonb,
    profile jsonb not null default '{"name":"","gender":"","age":""}'::jsonb,
    profile_updated_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

insert into public.cst_app_data (id, entries, profile)
values ('main', '{}'::jsonb, '{"name":"","gender":"","age":""}'::jsonb)
on conflict (id) do nothing;

create or replace function public.cst_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists cst_app_data_updated_at on public.cst_app_data;
create trigger cst_app_data_updated_at
    before update on public.cst_app_data
    for each row
    execute function public.cst_set_updated_at();

alter table public.cst_app_data enable row level security;

drop policy if exists "cst_anon_read" on public.cst_app_data;
create policy "cst_anon_read"
    on public.cst_app_data
    for select
    to anon
    using (true);

drop policy if exists "cst_anon_write" on public.cst_app_data;
create policy "cst_anon_write"
    on public.cst_app_data
    for insert
    to anon
    with check (id = 'main');

drop policy if exists "cst_anon_update" on public.cst_app_data;
create policy "cst_anon_update"
    on public.cst_app_data
    for update
    to anon
    using (id = 'main')
    with check (id = 'main');
