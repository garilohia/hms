type PublicEnvironment = {
  url: string | undefined;
  publishableKey: string | undefined;
};

export function validatePublicEnvironment(input: PublicEnvironment) {
  if (!input.url || !input.publishableKey?.trim()) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTP(S) URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use HTTPS for Supabase, except for local development.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The public Supabase URL must not include credentials, query parameters, or a fragment.");
  }
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error("Use a Supabase publishable key in NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
  return { url: url.origin, publishableKey: input.publishableKey };
}

export function getPublicEnvironment() {
  // Literal lookups are required for Next.js to inline public build-time values.
  return validatePublicEnvironment({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
