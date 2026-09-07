import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicEnvironment } from "@/src/lib/config/public-env";

export async function createClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getPublicEnvironment();

  return createServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot write cookies. A proxy can refresh sessions.
          }
        },
      },
    },
  );
}
