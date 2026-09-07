import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnvironment } from "@/src/lib/config/public-env";

export function createClient() {
  const { url, publishableKey } = getPublicEnvironment();
  return createBrowserClient(
    url,
    publishableKey,
  );
}
