/**
 * Stub for the `server-only` package.
 *
 * The real module throws when imported outside a React Server Component so
 * that server code cannot leak into the browser bundle. Vitest has no such
 * boundary, and the modules under test import it only as a guard, so an empty
 * module is the honest stand-in.
 */
export {};