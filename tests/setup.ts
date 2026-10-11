/**
 * Global test setup.
 *
 * Environment variables are set here rather than in a `.env` file so the suite
 * is hermetic: it must behave identically on a developer machine that has
 * `.env.local` and in CI that does not.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://bpmoafdikilbpcxbbmyi.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

// Deliberately NOT set: SUPABASE_SERVICE_ROLE_KEY. Most tests exercise the
// "not configured" path, and having it absent by default means a test that
// accidentally depends on admin access fails loudly instead of passing because
// the developer's shell had it exported.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// `src/lib/env.ts` reads these at module load, so they must be settled before
// any test file imports it.
process.env.CITRUSGUARD_MIN_CONFIDENCE ??= "0.55";