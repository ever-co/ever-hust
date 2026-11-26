import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/**
 * Reads an environment variable when it is called, never at build time.
 *
 * Next.js replaces every `process.env.NEXT_PUBLIC_*` it finds in the source with the value
 * the variable had during `next build`, in server bundles too. The web image is built without
 * the Supabase values (the pods get them from their secret at runtime), so
 * `process.env.NEXT_PUBLIC_SUPABASE_URL` compiled to `undefined`, the bundler folded the
 * check below into an unconditional throw, and every storage call (CV and avatar uploads,
 * file cleanup) failed in every environment. A lookup through a variable is not inlined.
 */
function runtimeEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

/**
 * Lazy-initialized Supabase server client (avoids throwing at module import time during build).
 *
 * The URL comes from `SUPABASE_URL` or, when that is unset, `NEXT_PUBLIC_SUPABASE_URL`, both
 * read at runtime.
 */
export function getSupabaseServer(): SupabaseClient {
  if (!_client) {
    const url = runtimeEnv("SUPABASE_URL") ?? runtimeEnv("NEXT_PUBLIC_SUPABASE_URL");
    const key = runtimeEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
      throw new Error(
        "Missing Supabase server environment variables: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY must be set"
      );
    }
    _client = createClient(url, key);
  }
  return _client;
}

/** Test hook: forget the cached client so the next call reads the environment again. */
export function resetSupabaseServerForTests(): void {
  _client = null;
}
