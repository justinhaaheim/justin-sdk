/**
 * hook-knobs — which registry handlers are switched on in one repo
 * (home-base-mbnjv.5).
 *
 * A handler with a `knob` (hook-registry.ts) gets a settings.json entry only
 * where that knob is on. Today that is the session guard, `thread guard`,
 * which waits on componentConfig.thread.handoff.successor (epic
 * home-base-mbnjv D10): a repo with successor off gets no PreToolUse entry
 * and pays nothing per Bash call.
 *
 * Read by the installers and by doctor's HOOK_ENTRIES check, so the two agree
 * on what a repo should carry. ALWAYS through `await import('./hook-knobs')`:
 * it reaches zod (thread/config -> sdk-config), and doctor and the installers
 * sit on cli-main's static import tree, which every hook loads
 * (health-notices-cli.test.ts "zod is NOT statically reachable"). The
 * zod-free pieces (HandlersByKnob, allKnobsOff, describeHookKnob) live in
 * hook-entries.ts. Not by the dispatcher: it runs whatever entry
 * exists, and the guard itself re-reads the knob at run time (session-guard.ts),
 * so an entry left behind after the knob went off does nothing.
 *
 * The knob resolves as `thread handoff` resolves it: resolveThreadConfig at the
 * project root, DEFAULT <- user file <- project file. So a successor switched
 * on in the user file turns the guard on in every repo that has the thread
 * hooks, which is where `thread handoff` would start successors.
 */

import type {HandlersByKnob} from './hook-entries';
import type {HookHandler, HookHandlerKnob} from './hook-registry';

import {HOOK_HANDLERS} from './hook-registry';
import {resolveThreadConfig} from './thread/config';

type Env = Record<string, string | undefined>;

/** Is one knob on in the repo at `projectRoot`? */
export function hookKnobOn(
  knob: HookHandlerKnob,
  projectRoot: string,
  env: Env = process.env,
): boolean {
  switch (knob) {
    case 'thread.handoff.successor':
      return resolveThreadConfig({cwd: projectRoot, env}).handoff.successor;
  }
}

export function handlersByKnob(
  projectRoot: string,
  env: Env = process.env,
  handlers: readonly HookHandler[] = HOOK_HANDLERS,
): HandlersByKnob {
  const cache = new Map<HookHandlerKnob, boolean>();
  const on = (knob: HookHandlerKnob): boolean => {
    const known = cache.get(knob);
    if (known != null) return known;
    const value = hookKnobOn(knob, projectRoot, env);
    cache.set(knob, value);
    return value;
  };
  const enabled: HookHandler[] = [];
  const disabled: HookHandler[] = [];
  for (const handler of handlers) {
    if (handler.knob == null || on(handler.knob)) enabled.push(handler);
    else disabled.push(handler);
  }
  return {disabled, enabled};
}
