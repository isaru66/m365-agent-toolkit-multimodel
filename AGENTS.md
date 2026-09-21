# Agent guidance

## Project
- TypeScript/Node.js 22 (`>=22.12.0 <23`), ESM, Microsoft Teams SDK.
- Personal, single-tenant Teams chat using Claude, Gemini Developer API, or Azure OpenAI.
- `src/`: runtime; `tests/`: Vitest; `infra/`: Terraform; `appPackage/`: Teams manifest.
- Read `README.md` for setup and `infra/README.md` before infrastructure work.

## Development
- Keep changes focused, follow existing patterns, and update related docs/tests.
- Local mock workflow: `npm run dev`, then `npm run playground` in another terminal.
- Run targeted tests first: `npm test -- <test-file>`.
- For broader code changes: `npm run check` and `npm run build`.
- Documentation-only changes need link/command checks, not an application build.

## Safety
- Preserve production authentication, tenant/personal-chat checks, and provider isolation.
- Playground authentication bypass is loopback-only; never expose it publicly.
- Live inference is billable; require explicit approval for paid calls or cloud mutations.
- Never commit or log credentials, prompt bodies, `.env` files, or Terraform state.
- Root `.env` is local runtime config; `env/.env.dev` is package metadata.
- Production uses ACA settings, Key Vault, managed identity, and Cosmos state.
- Run Terraform through Ubuntu WSL for this Windows workflow; preserve backend settings.
- Do not provision, deploy, publish, commit, or push without explicit user authorization.
- Healthy ACA probes do not prove model inference or end-to-end Teams delivery.
