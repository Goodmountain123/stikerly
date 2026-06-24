-- Stickerly asset delivery, products, and user entitlements.
-- Run the legacy web schema first, then run this migration.

create extension if not exists pgcrypto;

alter table public.sticker_packs
  add column if not exists published boolean not null default true,
  add column if not exists access_level text not null default 'free'
    check (access_level in ('free', 'paid')),
  add column if not exists content_version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.stickers
  add column if not exists published boolean not null default true,
  add column if not exists access_level text not null default 'free'
    check (access_level in ('free', 'paid')),
  add column if not exists content_version bigint not null default 1,
  add column if not exists file_size bigint,
  add column if not exists checksum_sha256 text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.backgrounds
  add column if not exists published boolean not null default true,
  add column if not exists access_level text not null default 'free'
    check (access_level in ('free', 'paid')),
  add column if not exists content_version bigint not null default 1,
  add column if not exists file_size bigint,
  add column if not exists checksum_sha256 text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.sticker_packs alter column published set default false;
alter table public.stickers alter column published set default false;
alter table public.backgrounds alter column published set default false;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  product_type text not null default 'pack'
    check (product_type in ('asset', 'pack', 'bundle')),
  price_amount integer not null default 0 check (price_amount >= 0),
  currency text not null default 'KRW',
  thumbnail_storage_path text,
  published boolean not null default false,
  position bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_assets (
  product_id uuid not null references public.products(id) on delete cascade,
  asset_type text not null check (asset_type in ('sticker', 'background')),
  asset_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (product_id, asset_type, asset_id)
);

create table if not exists public.product_packs (
  product_id uuid not null references public.products(id) on delete cascade,
  pack_id uuid not null references public.sticker_packs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, pack_id)
);

create table if not exists public.user_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id),
  provider text not null default 'manual',
  provider_transaction_id text,
  status text not null default 'completed'
    check (status in ('pending', 'completed', 'refunded', 'cancelled')),
  purchased_at timestamptz not null default now(),
  unique (provider, provider_transaction_id)
);

create table if not exists public.user_asset_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_type text not null check (asset_type in ('sticker', 'background')),
  asset_id uuid not null,
  source_type text not null
    check (source_type in ('free', 'purchase', 'admin', 'promotion')),
  source_id uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, asset_type, asset_id)
);

create table if not exists public.user_pack_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  pack_id uuid not null references public.sticker_packs(id) on delete cascade,
  source_type text not null
    check (source_type in ('free', 'purchase', 'admin', 'promotion')),
  source_id uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, pack_id)
);

alter table public.user_pack_entitlements
  drop constraint if exists user_pack_entitlements_source_type_check;
alter table public.user_pack_entitlements
  add constraint user_pack_entitlements_source_type_check
  check (source_type in ('free', 'purchase', 'admin', 'promotion'));

create table if not exists public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null,
  points bigint not null default 0 check (points >= 0),
  avatar_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_profiles
  add column if not exists email text,
  add column if not exists avatar_storage_path text;

create table if not exists public.point_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  points bigint not null check (points > 0),
  price_amount integer not null default 0 check (price_amount >= 0),
  currency text not null default 'KRW',
  provider text not null default 'manual',
  provider_transaction_id text,
  status text not null default 'completed'
    check (status in ('pending', 'completed', 'refunded', 'cancelled')),
  purchased_at timestamptz not null default now()
);

create table if not exists public.sticker_projects (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  title text not null,
  data jsonb not null,
  thumbnail_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.asset_catalog_releases (
  id bigint generated always as identity primary key,
  version bigint not null unique,
  note text not null default '',
  published_at timestamptz not null default now()
);

create index if not exists product_assets_asset_idx
  on public.product_assets (asset_type, asset_id);
create index if not exists product_packs_pack_idx
  on public.product_packs (pack_id);
create index if not exists user_entitlements_user_idx
  on public.user_asset_entitlements (user_id)
  where revoked_at is null;
create index if not exists user_pack_entitlements_user_idx
  on public.user_pack_entitlements (user_id)
  where revoked_at is null;
create index if not exists user_purchases_user_idx
  on public.user_purchases (user_id, purchased_at desc);
create index if not exists point_purchases_user_idx
  on public.point_purchases (user_id, purchased_at desc);
create index if not exists sticker_projects_user_idx
  on public.sticker_projects (user_id, updated_at desc);

create or replace function public.sync_account_metadata(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_email text;
begin
  select lower(email) into target_email
  from auth.users
  where id = target_user_id;

  if target_email is null then return; end if;

  insert into public.account_profiles (user_id, email, display_name, points)
  values (
    target_user_id,
    target_email,
    case
      when target_email = 'testaccount1@stickerly.app' then 'testaccount1'
      when target_email = 'testaccount2@stickerly.app' then 'testaccount2'
      else split_part(target_email, '@', 1)
    end,
    case when target_email = 'testaccount1@stickerly.app' then 1000000 else 0 end
  )
  on conflict (user_id) do update set
    email = excluded.email,
    display_name = excluded.display_name,
    points = case
      when target_email = 'testaccount1@stickerly.app' then 1000000
      when target_email = 'testaccount2@stickerly.app' then 0
      else account_profiles.points
    end,
    updated_at = now();

  insert into public.user_pack_entitlements (
    user_id, pack_id, source_type
  )
  select target_user_id, sticker_packs.id, 'free'
  from public.sticker_packs
  where sticker_packs.access_level = 'free'
  on conflict (user_id, pack_id) do update set
    revoked_at = null,
    source_type = case
      when user_pack_entitlements.source_type = 'purchase'
        then user_pack_entitlements.source_type
      else 'free'
    end;
end;
$$;

create or replace function public.handle_new_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_account_metadata(new.id);
  return new;
end;
$$;

drop trigger if exists account_created_metadata on auth.users;
create trigger account_created_metadata
after insert on auth.users
for each row execute function public.handle_new_account();

create or replace function public.sync_free_pack_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.access_level = 'free' then
    insert into public.user_pack_entitlements (
      user_id, pack_id, source_type
    )
    select users.id, new.id, 'free'
    from auth.users as users
    on conflict (user_id, pack_id) do update set
      revoked_at = null,
      source_type = case
        when user_pack_entitlements.source_type = 'purchase'
          then user_pack_entitlements.source_type
        else 'free'
      end;
  end if;
  return new;
end;
$$;

drop trigger if exists free_pack_entitlements on public.sticker_packs;
create trigger free_pack_entitlements
after insert or update of access_level on public.sticker_packs
for each row execute function public.sync_free_pack_entitlements();

do $$
declare account record;
begin
  for account in select id from auth.users loop
    perform public.sync_account_metadata(account.id);
  end loop;
end;
$$;


insert into public.app_settings (key, value)
values ('asset_catalog_version', '1'::jsonb)
on conflict (key) do nothing;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.update_account_display_name(display_name text)
returns public.account_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := nullif(btrim(display_name), '');
  profile public.account_profiles;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if normalized is null then
    raise exception 'Display name is required';
  end if;

  update public.account_profiles
  set display_name = left(normalized, 20),
      updated_at = now()
  where user_id = auth.uid()
  returning * into profile;

  if profile.user_id is null then
    raise exception 'Profile not found';
  end if;
  return profile;
end;
$$;

create or replace function public.update_account_avatar(avatar_path text)
returns public.account_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := nullif(btrim(avatar_path), '');
  profile public.account_profiles;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if normalized is null or split_part(normalized, '/', 1) <> auth.uid()::text then
    raise exception 'Invalid avatar path';
  end if;

  update public.account_profiles
  set avatar_storage_path = normalized,
      updated_at = now()
  where user_id = auth.uid()
  returning * into profile;

  if profile.user_id is null then
    raise exception 'Profile not found';
  end if;
  return profile;
end;
$$;

drop trigger if exists sticker_packs_touch_updated_at on public.sticker_packs;
create trigger sticker_packs_touch_updated_at
before update on public.sticker_packs
for each row execute function public.touch_updated_at();

drop trigger if exists stickers_touch_updated_at on public.stickers;
create trigger stickers_touch_updated_at
before update on public.stickers
for each row execute function public.touch_updated_at();

drop trigger if exists backgrounds_touch_updated_at on public.backgrounds;
create trigger backgrounds_touch_updated_at
before update on public.backgrounds
for each row execute function public.touch_updated_at();

drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at
before update on public.products
for each row execute function public.touch_updated_at();

drop trigger if exists account_profiles_touch_updated_at on public.account_profiles;
create trigger account_profiles_touch_updated_at
before update on public.account_profiles
for each row execute function public.touch_updated_at();

create or replace function public.bump_asset_catalog_version()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  next_version bigint;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  select coalesce((value #>> '{}')::bigint, 0) + 1
    into next_version
    from public.app_settings
    where key = 'asset_catalog_version'
    for update;

  insert into public.app_settings (key, value)
  values ('asset_catalog_version', to_jsonb(coalesce(next_version, 1)))
  on conflict (key) do update set value = excluded.value;

  insert into public.asset_catalog_releases (version)
  values (coalesce(next_version, 1))
  on conflict (version) do nothing;

  return coalesce(next_version, 1);
end;
$$;

create or replace function public.grant_product_assets(
  target_user_id uuid,
  target_product_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.user_pack_entitlements (
    user_id,
    pack_id,
    source_type,
    source_id
  )
  select target_user_id, product_packs.pack_id, 'purchase', target_product_id
  from public.product_packs
  where product_packs.product_id = target_product_id
  on conflict (user_id, pack_id)
  do update set
    source_type = excluded.source_type,
    source_id = excluded.source_id,
    revoked_at = null,
    granted_at = now();

  insert into public.user_asset_entitlements (
    user_id,
    asset_type,
    asset_id,
    source_type,
    source_id
  )
  select target_user_id, assets.asset_type, assets.asset_id, 'purchase',
    target_product_id
  from (
    select product_assets.asset_type, product_assets.asset_id
    from public.product_assets
    where product_assets.product_id = target_product_id
  ) as assets
  on conflict (user_id, asset_type, asset_id)
  do update set
    source_type = excluded.source_type,
    source_id = excluded.source_id,
    revoked_at = null,
    granted_at = now();
$$;

create or replace function public.can_access_pack(target_pack_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sticker_packs
    where sticker_packs.id = target_pack_id
      and (
        public.is_admin()
        or (
          sticker_packs.published
          and (
            sticker_packs.access_level = 'free'
            or exists (
              select 1
              from public.user_pack_entitlements
              where user_pack_entitlements.user_id = auth.uid()
                and user_pack_entitlements.pack_id = target_pack_id
                and user_pack_entitlements.revoked_at is null
            )
            or exists (
              select 1
              from public.user_asset_entitlements
              where user_asset_entitlements.user_id = auth.uid()
                and user_asset_entitlements.revoked_at is null
                and (
                  (
                    user_asset_entitlements.asset_type = 'sticker'
                    and exists (
                      select 1 from public.stickers
                      where stickers.id = user_asset_entitlements.asset_id
                        and stickers.pack_id = target_pack_id
                    )
                  )
                  or (
                    user_asset_entitlements.asset_type = 'background'
                    and exists (
                      select 1 from public.backgrounds
                      where backgrounds.id = user_asset_entitlements.asset_id
                        and backgrounds.pack_id = target_pack_id
                    )
                  )
                )
            )
          )
        )
      )
  );
$$;

create or replace function public.admin_grant_product(
  target_user_id uuid,
  target_product_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  purchase_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  insert into public.user_purchases (
    user_id,
    product_id,
    provider,
    provider_transaction_id,
    status
  )
  values (
    target_user_id,
    target_product_id,
    'manual',
    'admin-' || gen_random_uuid()::text,
    'completed'
  )
  returning id into purchase_id;

  perform public.grant_product_assets(target_user_id, target_product_id);
  return purchase_id;
end;
$$;

create or replace function public.purchase_product_with_points(
  target_product_id uuid
)
returns public.account_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  buyer_id uuid := auth.uid();
  product_price integer;
  profile public.account_profiles;
begin
  if buyer_id is null then
    raise exception 'Not signed in';
  end if;

  select price_amount into product_price
  from public.products
  where id = target_product_id
    and published = true;

  if product_price is null then
    raise exception 'Product not found';
  end if;

  select * into profile
  from public.account_profiles
  where user_id = buyer_id
  for update;

  if profile.user_id is null then
    raise exception 'Profile not found';
  end if;
  if profile.points < product_price then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  update public.account_profiles
  set points = points - product_price,
      updated_at = now()
  where user_id = buyer_id
  returning * into profile;

  insert into public.user_purchases (
    user_id,
    product_id,
    provider,
    provider_transaction_id,
    status
  )
  values (
    buyer_id,
    target_product_id,
    'points',
    'points-' || gen_random_uuid()::text,
    'completed'
  )
  on conflict (provider, provider_transaction_id) do nothing;

  perform public.grant_product_assets(buyer_id, target_product_id);
  return profile;
end;
$$;

create or replace view public.available_stickers
with (security_invoker = true)
as
select sticker.*
from public.stickers as sticker
where public.can_access_pack(sticker.pack_id);

create or replace view public.available_backgrounds
with (security_invoker = true)
as
select background.*
from public.backgrounds as background
where public.can_access_pack(background.pack_id);

alter table public.products enable row level security;
alter table public.product_assets enable row level security;
alter table public.product_packs enable row level security;
alter table public.user_purchases enable row level security;
alter table public.point_purchases enable row level security;
alter table public.user_asset_entitlements enable row level security;
alter table public.user_pack_entitlements enable row level security;
alter table public.asset_catalog_releases enable row level security;
alter table public.account_profiles enable row level security;
alter table public.sticker_projects enable row level security;

drop policy if exists "Public reads packs" on public.sticker_packs;
drop policy if exists "Users read available packs" on public.sticker_packs;
create policy "Users read available packs"
on public.sticker_packs for select
using (
  public.can_access_pack(id)
);

drop policy if exists "Public reads stickers" on public.stickers;
drop policy if exists "Users read available stickers" on public.stickers;
create policy "Users read available stickers"
on public.stickers for select
using (
  public.can_access_pack(pack_id)
  or exists (
    select 1
    from public.product_packs
    join public.products on products.id = product_packs.product_id
    where product_packs.pack_id = stickers.pack_id
      and products.published = true
  )
);

drop policy if exists "Public reads backgrounds" on public.backgrounds;
drop policy if exists "Users read available backgrounds" on public.backgrounds;
create policy "Users read available backgrounds"
on public.backgrounds for select
using (
  public.can_access_pack(pack_id)
  or exists (
    select 1
    from public.product_packs
    join public.products on products.id = product_packs.product_id
    where product_packs.pack_id = backgrounds.pack_id
      and products.published = true
  )
);

drop policy if exists "Users read published products" on public.products;
create policy "Users read published products"
on public.products for select
using (published or public.is_admin());

drop policy if exists "Admins manage products" on public.products;
create policy "Admins manage products"
on public.products for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read published product assets" on public.product_assets;
create policy "Users read published product assets"
on public.product_assets for select
using (
  exists (
    select 1 from public.products
    where products.id = product_assets.product_id
      and (products.published or public.is_admin())
  )
);

drop policy if exists "Admins manage product assets" on public.product_assets;
create policy "Admins manage product assets"
on public.product_assets for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read published product packs" on public.product_packs;
create policy "Users read published product packs"
on public.product_packs for select
using (
  exists (
    select 1 from public.products
    where products.id = product_packs.product_id
      and (products.published or public.is_admin())
  )
);

drop policy if exists "Admins manage product packs" on public.product_packs;
create policy "Admins manage product packs"
on public.product_packs for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read own purchases" on public.user_purchases;
create policy "Users read own purchases"
on public.user_purchases for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage purchases" on public.user_purchases;
create policy "Admins manage purchases"
on public.user_purchases for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read own point purchases" on public.point_purchases;
create policy "Users read own point purchases"
on public.point_purchases for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage point purchases" on public.point_purchases;
create policy "Admins manage point purchases"
on public.point_purchases for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read own entitlements" on public.user_asset_entitlements;
create policy "Users read own entitlements"
on public.user_asset_entitlements for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage entitlements" on public.user_asset_entitlements;
create policy "Admins manage entitlements"
on public.user_asset_entitlements for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read own pack entitlements" on public.user_pack_entitlements;
create policy "Users read own pack entitlements"
on public.user_pack_entitlements for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage pack entitlements" on public.user_pack_entitlements;
create policy "Admins manage pack entitlements"
on public.user_pack_entitlements for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read asset releases" on public.asset_catalog_releases;
create policy "Users read asset releases"
on public.asset_catalog_releases for select
using (true);

drop policy if exists "Users read own account profile" on public.account_profiles;
create policy "Users read own account profile"
on public.account_profiles for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage account profiles" on public.account_profiles;
create policy "Admins manage account profiles"
on public.account_profiles for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users manage own sticker projects" on public.sticker_projects;
create policy "Users manage own sticker projects"
on public.sticker_projects for all
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

grant select on public.available_stickers to anon, authenticated;
grant select on public.available_backgrounds to anon, authenticated;
revoke all on function public.grant_product_assets(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.bump_asset_catalog_version()
  from public, anon, authenticated;
revoke all on function public.admin_grant_product(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.bump_asset_catalog_version()
  to authenticated;
grant execute on function public.admin_grant_product(uuid, uuid)
  to authenticated;
revoke all on function public.purchase_product_with_points(uuid)
  from public, anon, authenticated;
grant execute on function public.purchase_product_with_points(uuid)
  to authenticated;
revoke all on function public.sync_account_metadata(uuid)
  from public, anon, authenticated;
grant execute on function public.sync_account_metadata(uuid)
  to service_role;
revoke all on function public.update_account_display_name(text)
  from public, anon, authenticated;
grant execute on function public.update_account_display_name(text)
  to authenticated;
revoke all on function public.update_account_avatar(text)
  from public, anon, authenticated;
grant execute on function public.update_account_avatar(text)
  to authenticated;

update storage.buckets
set public = false
where id = 'assets';

insert into storage.buckets (id, name, public)
values ('profile-images', 'profile-images', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('project-thumbnails', 'project-thumbnails', false)
on conflict (id) do update set public = false;

drop policy if exists "Public reads assets" on storage.objects;
drop policy if exists "Users read available assets" on storage.objects;
create policy "Users read available assets"
on storage.objects for select
using (
  bucket_id = 'assets'
  and (
    public.is_admin()
    or exists (
      select 1
      from public.stickers
      where stickers.storage_path = storage.objects.name
    )
    or exists (
      select 1
      from public.backgrounds
      where backgrounds.storage_path = storage.objects.name
    )
    or exists (
      select 1
      from public.products
      where products.thumbnail_storage_path = storage.objects.name
        and (products.published or public.is_admin())
    )
  )
);

drop policy if exists "Admins upload assets" on storage.objects;
create policy "Admins upload assets"
on storage.objects for insert
with check (bucket_id = 'assets' and public.is_admin());

drop policy if exists "Admins update assets" on storage.objects;
create policy "Admins update assets"
on storage.objects for update
using (bucket_id = 'assets' and public.is_admin())
with check (bucket_id = 'assets' and public.is_admin());

drop policy if exists "Users read profile images" on storage.objects;
create policy "Users read profile images"
on storage.objects for select
using (bucket_id = 'profile-images');

drop policy if exists "Users upload own profile image" on storage.objects;
create policy "Users upload own profile image"
on storage.objects for insert
with check (
  bucket_id = 'profile-images'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "Users update own profile image" on storage.objects;
create policy "Users update own profile image"
on storage.objects for update
using (
  bucket_id = 'profile-images'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'profile-images'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "Users read own project thumbnails" on storage.objects;
create policy "Users read own project thumbnails"
on storage.objects for select
using (
  bucket_id = 'project-thumbnails'
  and (split_part(name, '/', 1) = auth.uid()::text or public.is_admin())
);

drop policy if exists "Users upload own project thumbnails" on storage.objects;
create policy "Users upload own project thumbnails"
on storage.objects for insert
with check (
  bucket_id = 'project-thumbnails'
  and split_part(name, '/', 1) = auth.uid()::text
);

drop policy if exists "Users update own project thumbnails" on storage.objects;
create policy "Users update own project thumbnails"
on storage.objects for update
using (
  bucket_id = 'project-thumbnails'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'project-thumbnails'
  and split_part(name, '/', 1) = auth.uid()::text
);

-- Important:
-- Call bump_asset_catalog_version() once after an administrator publishes,
-- updates, or removes assets/products. Draft edits do not need to bump it.
-- Payment verification and grant_product_assets() must only run in a trusted
-- server/Edge Function with the service role. Never call them from the app.
