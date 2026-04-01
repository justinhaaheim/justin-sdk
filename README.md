# justin-sdk

Cross-project SDK for Justin's projects: shared scripts, configs, and setup prompts.

## Installation

```bash
bun add github:justinhaaheim/justin-sdk#0.1.0
```

## What's included

### Importable modules

- **check-runner** — Generic engine for running checks in parallel/serial with colored output and timing

```typescript
import type { Check } from '@justinhaaheim/justin-sdk/check-runner';
import { runChecks } from '@justinhaaheim/justin-sdk/check-runner';
```

### Template scripts

Copy and adapt these for each project:

- `templates/scripts/signal.ts` — Lint/TS/Prettier checks
- `templates/scripts/doctor.ts` — Environment validation with `--fix` mode
- `templates/scripts/setup-env.ts` — SessionStart hook (installs tools in remote, validates locally)

### Setup prompt docs

Claude Code-executable guides for setting up tooling:

- `docs/base-setup.md` — Foundation layer (check-runner, signal, doctor, setup-env)
- `docs/beads-setup.md` — beads_rust issue tracker via mise

## Consumer config

Projects track their SDK version in `justin-sdk.json`:

```json
{
  "version": "0.1.0",
  "components": ["base-setup", "beads-setup"],
  "lastSynced": "2026-03-31"
}
```
