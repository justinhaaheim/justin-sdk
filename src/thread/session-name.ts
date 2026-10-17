/**
 * The one spelling of a session's name: "[TAG] <title>" (home-base-j8q3e.5
 * D1). Plain text, no markdown escaping and no truncation: callers that render
 * markdown wrap it in tildeText themselves, and the cmux workspace name uses it
 * as it is.
 *
 * `repoTag` is the RESOLVED tag (home-base-bomy5.7.1): the repo's declared
 * `projectTag`, else its folder name uppercased — `resolveRepoTag` in
 * config.ts decides it, from the session's own checkout, and the session model
 * and the inbox card carry it as `repoTag`. Never pass a plain repo name here.
 * Null means the repo itself is unknown. `text` is the title, or, for the
 * untracked one-liner, his first message.
 */
export function sessionDisplayName(
  repoTag: string | null,
  text: string,
): string {
  return `[${repoTag ?? 'UNKNOWN REPO'}] ${text}`;
}
