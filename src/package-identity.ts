/**
 * package-identity.ts — the ONE place that knows what this package is called
 * on npm, and what it used to be called.
 *
 * Renamed 2026-08-12 (home-base-j2n7): `@justinhaaheim/justin-sdk` →
 * `@jhaa/justin-sdk`, at the same time as the first npm publish. `@jhaa` is
 * Justin's npm USERNAME scope, so it needs no org and can never be squatted.
 *
 * THE GITHUB REPO IS UNCHANGED. It is still `justinhaaheim/justin-sdk`, so
 * every `github:justinhaaheim/justin-sdk#vX.Y.Z` spec stays valid — only the
 * npm package NAME moved. Do not "fix" those to say jhaa.
 *
 * LEGACY_SDK_SPECIFIERS is the migration surface: base-setup rewrites any
 * package.json script or dependency naming one of these to the current name.
 * Each entry is a name the SDK ITSELF emitted at some point, never something
 * a human would have hand-written to mean anything else:
 *   - `@justinhaaheim/justin-sdk` — the pre-2026-08-12 scoped name.
 *   - `justin-sdk` / `jsdk` / `j` — the bare bunx spellings banned by
 *     home-base-2qhw (they fall through to the public registry when local
 *     resolution fails, i.e. dependency confusion). `justin-sdk` is claimed
 *     defensively on npm as a deprecated stub that fails loudly.
 */

/** The npm package name. */
export const SDK_PKG = '@jhaa/justin-sdk';

/** The GitHub repo — unchanged by the npm rename. */
export const SDK_REPO = 'justinhaaheim/justin-sdk';

/** The canonical way to invoke the CLI in an enrolled project. */
export const SDK_BUNX = `bunx ${SDK_PKG}`;

/**
 * Package/bin names this SDK previously emitted, newest first. Used to
 * RECOGNIZE and rewrite stale references — never to resolve anything.
 */
export const LEGACY_SDK_PKGS = [
  '@justinhaaheim/justin-sdk',
  'justin-sdk',
  'jsdk',
  'j',
] as const;

/**
 * Matches a package.json script value that invokes the SDK under any legacy
 * name — `bunx @justinhaaheim/justin-sdk doctor`, `bunx justin-sdk signal`,
 * `bunx j fix`. Anchored and space-terminated so a lookalike package
 * (`bunx justin-sdk-other thing`) is NOT matched.
 */
export const LEGACY_BUNX_RE =
  /^bunx\s+(?:@justinhaaheim\/justin-sdk|justin-sdk|jsdk|j)\s/;
