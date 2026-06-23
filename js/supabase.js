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
  const storage = supabase.storage.from("assets");
  const { data, error } = await storage.createSignedUrl(path, expiresIn);
  if (!error && data?.signedUrl) return data.signedUrl;

  const downloaded = await storage.download(path);
  if (downloaded.error) throw downloaded.error;
  return URL.createObjectURL(downloaded.data);
}
