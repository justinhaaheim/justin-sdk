#!/usr/bin/env node
/**
 * The unscoped name `justin-sdk` is a NAME GUARD, not the SDK.
 *
 * Why it exists: fleet projects historically carried `bunx justin-sdk <cmd>`
 * aliases. bunx resolves a bare name from node_modules/.bin upward and, when
 * that walk finds nothing, fetches the name from the PUBLIC registry and runs
 * it — the standard dependency-confusion shape (home-base-2qhw). Owning the
 * name closes that hole.
 *
 * It FAILS rather than forwarding, deliberately: reaching this code means a
 * project is still misconfigured, and a silent forward would hide that
 * forever. Loud + actionable beats convenient.
 */
const cmd = process.argv.slice(2).join(' ') || '<command>';
process.stderr.write(
  '\n  justin-sdk (unscoped) is NOT the SDK — it is a name guard.\n\n' +
    '  The package is now:  @jhaa/justin-sdk\n\n' +
    `  Run instead:         bunx @jhaa/justin-sdk ${cmd}\n\n` +
    '  If a package.json script sent you here, that alias is stale.\n' +
    '  Fix every alias at once with:\n\n' +
    '      bunx @jhaa/justin-sdk add base-setup\n\n',
);
process.exit(1);
