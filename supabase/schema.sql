create extension if not exists pgcrypto;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.sticker_packs (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  name text not null,
  position bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.stickers (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.sticker_packs(id) on delete cascade,
  legacy_asset_id text,
  name text not null,
  storage_path text not null unique,
  position bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.backgrounds (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  name text not null,
  storage_path text not null unique,
  position bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.sticker_packs add column if not exists legacy_id text;
alter table public.backgrounds add column if not exists legacy_id text;
alter table public.stickers add column if not exists legacy_asset_id text;
create unique index if not exists sticker_packs_legacy_id_key
  on public.sticker_packs (legacy_id);
create unique index if not exists backgrounds_legacy_id_key
  on public.backgrounds (legacy_id);
create unique index if not exists stickers_pack_legacy_asset_key
  on public.stickers (pack_id, legacy_asset_id);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null
);

alter table public.admin_users enable row level security;
alter table public.sticker_packs enable row level security;
alter table public.stickers enable row level security;
alter table public.backgrounds enable row level security;
alter table public.app_settings enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

drop policy if exists "Public reads packs" on public.sticker_packs;
create policy "Public reads packs" on public.sticker_packs for select using (true);
drop policy if exists "Admins manage packs" on public.sticker_packs;
create policy "Admins manage packs" on public.sticker_packs for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public reads stickers" on public.stickers;
create policy "Public reads stickers" on public.stickers for select using (true);
drop policy if exists "Admins manage stickers" on public.stickers;
create policy "Admins manage stickers" on public.stickers for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public reads backgrounds" on public.backgrounds;
create policy "Public reads backgrounds" on public.backgrounds for select using (true);
drop policy if exists "Admins manage backgrounds" on public.backgrounds;
create policy "Admins manage backgrounds" on public.backgrounds for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Public reads settings" on public.app_settings;
create policy "Public reads settings" on public.app_settings for select using (true);
drop policy if exists "Admins manage settings" on public.app_settings;
create policy "Admins manage settings" on public.app_settings for all
using (public.is_admin()) with check (public.is_admin());

insert into public.app_settings (key, value)
values (
  'welcome_messages',
  '["오늘은 뭘 하고 놀까요?", "어서오세요, 반가워요!", "예쁘게 꾸며봐요!"]'::jsonb
)
on conflict (key) do nothing;

drop policy if exists "Admins see own membership" on public.admin_users;
create policy "Admins see own membership" on public.admin_users for select
using (user_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('assets', 'assets', true)
on conflict (id) do update set public = true;

drop policy if exists "Public reads assets" on storage.objects;
create policy "Public reads assets" on storage.objects for select
using (bucket_id = 'assets');
drop policy if exists "Admins upload assets" on storage.objects;
create policy "Admins upload assets" on storage.objects for insert
with check (bucket_id = 'assets' and public.is_admin());
drop policy if exists "Admins update assets" on storage.objects;
create policy "Admins update assets" on storage.objects for update
using (bucket_id = 'assets' and public.is_admin());
drop policy if exists "Admins delete assets" on storage.objects;
create policy "Admins delete assets" on storage.objects for delete
using (bucket_id = 'assets' and public.is_admin());

-- Authentication > Users에서 관리자를 만든 뒤 UUID를 아래처럼 등록하세요.
-- insert into public.admin_users (user_id) values ('USER_UUID');
