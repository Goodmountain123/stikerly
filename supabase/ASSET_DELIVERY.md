# Asset delivery

Apply `schema.sql` from the web project first, then run
`asset_delivery_schema.sql`.

## App-visible states

- No entitlement: shop only.
- Entitled, not downloaded: drawer/gallery card with a download button.
- Downloading: progress state.
- Downloaded: usable in the editor.

Free published assets are automatically entitled. Paid assets become available
only after a verified purchase grants rows in `user_asset_entitlements`.

## Publishing

1. Upload the file to the private `assets` bucket.
2. Create or update its sticker/background metadata.
3. Mark it `published`.
4. Call `bump_asset_catalog_version()` once for the completed release.

The app compares `app_settings.asset_catalog_version` at launch. A changed
version refreshes metadata only; files are downloaded separately when the user
taps the download button.

## Purchases

Payment verification must run in a trusted server or Supabase Edge Function.
After verification, create `user_purchases` and call
`grant_product_assets(user_id, product_id)` with the service role. Neither
operation may be exposed directly to the Flutter client.
