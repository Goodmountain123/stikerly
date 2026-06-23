import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const accounts = [
  {
    email: "testaccount1@stickerly.app",
    password: "StickerlyTest!2026",
    displayName: "testaccount1",
  },
  {
    email: "testaccount2@stickerly.app",
    password: "StickerlyTest!2026",
    displayName: "testaccount2",
  },
];

Deno.serve(async (request) => {
  const expected = Deno.env.get("TEST_ACCOUNT_SETUP_SECRET");
  if (!expected || request.headers.get("x-setup-secret") !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: listed, error: listError } =
    await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw listError;

  for (const account of accounts) {
    const existing = listed.users.find(
      (user) => user.email?.toLowerCase() === account.email,
    );
    const result = existing
      ? await client.auth.admin.updateUserById(existing.id, {
          password: account.password,
          email_confirm: true,
          user_metadata: { display_name: account.displayName },
        })
      : await client.auth.admin.createUser({
          email: account.email,
          password: account.password,
          email_confirm: true,
          user_metadata: { display_name: account.displayName },
        });
    if (result.error) throw result.error;
    await client.rpc("sync_account_metadata", {
      target_user_id: result.data.user.id,
    });
  }

  return Response.json({ created: accounts.map((account) => account.email) });
});
