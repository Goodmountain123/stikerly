# Test accounts

The app uses these temporary accounts:

- `testaccount1@stickerly.app` — 1,000,000 points
- `testaccount2@stickerly.app` — 0 points
- Shared temporary password: `StickerlyTest!2026`

Apply `asset_delivery_schema.sql` first. Then deploy and invoke the one-time
`seed-test-accounts` Edge Function with the Supabase service role:

```sh
supabase secrets set TEST_ACCOUNT_SETUP_SECRET=CHOOSE_A_RANDOM_SECRET
supabase functions deploy seed-test-accounts --no-verify-jwt
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/seed-test-accounts" \
  -H "x-setup-secret: CHOOSE_A_RANDOM_SECRET"
```

After both accounts are created, delete or undeploy the seed function. Free
packs are automatically added to both accounts through
`user_pack_entitlements`.
