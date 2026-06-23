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

create table if not exists public.asset_catalog_releases (
  id bigint generated always as identity primary key,
  version bigint not null unique,
  note text not null default '',
  published_at timestamptz not null default now()
);

create index if not exists product_assets_asset_idx
  on public.product_assets (asset_type, asset_id);
create index if not exists user_entitlements_user_idx
  on public.user_asset_entitlements (user_id)
  where revoked_at is null;
create index if not exists user_purchases_user_idx
  on public.user_purchases (user_id, purchased_at desc);

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
  insert into public.user_asset_entitlements (
    user_id,
    asset_type,
    asset_id,
    source_type,
    source_id
  )
  select
    target_user_id,
    product_assets.asset_type,
    product_assets.asset_id,
    'purchase',
    target_product_id
  from public.product_assets
  where product_assets.product_id = target_product_id
  on conflict (user_id, asset_type, asset_id)
  do update set
    source_type = excluded.source_type,
    source_id = excluded.source_id,
    revoked_at = null,
    granted_at = now();
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

create or replace view public.available_stickers
with (security_invoker = true)
as
select sticker.*
from public.stickers as sticker
where sticker.published
  and (
    sticker.access_level = 'free'
    or exists (
      select 1
      from public.user_asset_entitlements as entitlement
      where entitlement.user_id = auth.uid()
        and entitlement.asset_type = 'sticker'
        and entitlement.asset_id = sticker.id
        and entitlement.revoked_at is null
    )
  );

create or replace view public.available_backgrounds
with (security_invoker = true)
as
select background.*
from public.backgrounds as background
where background.published
  and (
    background.access_level = 'free'
    or exists (
      select 1
      from public.user_asset_entitlements as entitlement
      where entitlement.user_id = auth.uid()
        and entitlement.asset_type = 'background'
        and entitlement.asset_id = background.id
        and entitlement.revoked_at is null
    )
  );

alter table public.products enable row level security;
alter table public.product_assets enable row level security;
alter table public.user_purchases enable row level security;
alter table public.user_asset_entitlements enable row level security;
alter table public.asset_catalog_releases enable row level security;

drop policy if exists "Public reads packs" on public.sticker_packs;
create policy "Users read available packs"
on public.sticker_packs for select
using (
  public.is_admin()
  or (
    published
    and exists (
      select 1
      from public.stickers
      where stickers.pack_id = sticker_packs.id
        and stickers.published
        and (
          stickers.access_level = 'free'
          or exists (
            select 1
            from public.user_asset_entitlements
            where user_asset_entitlements.user_id = auth.uid()
              and user_asset_entitlements.asset_type = 'sticker'
              and user_asset_entitlements.asset_id = stickers.id
              and user_asset_entitlements.revoked_at is null
          )
        )
    )
  )
);

drop policy if exists "Public reads stickers" on public.stickers;
create policy "Users read available stickers"
on public.stickers for select
using (
  public.is_admin()
  or (
    published
    and (
      access_level = 'free'
      or exists (
        select 1
        from public.user_asset_entitlements
        where user_asset_entitlements.user_id = auth.uid()
          and user_asset_entitlements.asset_type = 'sticker'
          and user_asset_entitlements.asset_id = stickers.id
          and user_asset_entitlements.revoked_at is null
      )
    )
  )
);

drop policy if exists "Public reads backgrounds" on public.backgrounds;
create policy "Users read available backgrounds"
on public.backgrounds for select
using (
  public.is_admin()
  or (
    published
    and (
      access_level = 'free'
      or exists (
        select 1
        from public.user_asset_entitlements
        where user_asset_entitlements.user_id = auth.uid()
          and user_asset_entitlements.asset_type = 'background'
          and user_asset_entitlements.asset_id = backgrounds.id
          and user_asset_entitlements.revoked_at is null
      )
    )
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

drop policy if exists "Users read own purchases" on public.user_purchases;
create policy "Users read own purchases"
on public.user_purchases for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage purchases" on public.user_purchases;
create policy "Admins manage purchases"
on public.user_purchases for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read own entitlements" on public.user_asset_entitlements;
create policy "Users read own entitlements"
on public.user_asset_entitlements for select
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage entitlements" on public.user_asset_entitlements;
create policy "Admins manage entitlements"
on public.user_asset_entitlements for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Users read asset releases" on public.asset_catalog_releases;
create policy "Users read asset releases"
on public.asset_catalog_releases for select
using (true);

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

update storage.buckets
set public = false
where id = 'assets';

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
  )
);

-- Important:
-- Call bump_asset_catalog_version() once after an administrator publishes,
-- updates, or removes assets/products. Draft edits do not need to bump it.
-- Payment verification and grant_product_assets() must only run in a trusted
-- server/Edge Function with the service role. Never call them from the app.
