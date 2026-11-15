/**
 * The sentence a mayor session's successor is given, in its kickoff and in its
 * handoff block (handoff-number.ts, `mayorSuccessorSentence`, epic
 * home-base-mbnjv D8).
 *
 * A leaf with no imports, so the first-prompt hook can recognise a mayor
 * successor by it (home-base-lv87w.2 D1) without loading handoff-number.ts,
 * whose imports reach sdk-config and zod: first-prompt.ts is in the command
 * tree every hook loads (tests/health-notices-cli.test.ts, "the CLI hot path").
 */
export const MAYOR_SUCCESSOR_SENTENCE =
  'This session continues a mayor session, so load the mayor skill with the Skill tool.';
