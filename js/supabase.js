import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

export const supabaseConfigured =
  SUPABASE_URL.startsWith("https://")
  && !SUPABASE_URL.includes("YOUR_")
  && !SUPABASE_ANON_KEY.includes("YOUR_");

let client = null;
if (supabaseConfigured) {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
export const supabase = client;

export function publicAssetUrl(path) {
  return supabase.storage.from("assets").getPublicUrl(path).data.publicUrl;
}

export async function signedAssetUrl(path, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from("assets")
    .createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
