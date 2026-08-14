# Repository Guidelines

## Project Structure & Module Organization

SpotShell is an npm-workspaces TypeScript monorepo. Shared SSH and AI-agent logic lives in `packages/core/src/`; the command-line client is in `packages/cli/src/`. The Electron application is split into `packages/desktop/src/main/`, `preload/`, `renderer/`, and `shared/`; keep IPC contracts and Zod schemas in `shared/`. Tests are colocated as `*.test.ts`. Product plans belong in `docs/`. Do not commit generated `dist/`, `out/`, `release/`, or `node_modules/` directories.

## Code Intelligence & Repository Exploration

Use the repository's CodeGraph index before broad text searches or whole-file reads when understanding existing code, planning a change, tracing a flow, debugging, or assessing refactor impact. This requirement applies to the primary agent and all subagents.

- Start with one focused `codegraph_explore` query naming the relevant symbols, files, and expected flow. Prefer it over delegating codebase exploration or combining multiple `rg` and `Get-Content` calls.
- Use `codegraph_search` only to locate a symbol, `codegraph_node` for one specific symbol body, and `codegraph_callers`, `codegraph_callees`, or `codegraph_impact` for dependency analysis.
- Do not re-read or grep source already returned by CodeGraph merely to verify it. Fall back to targeted `rg` or bounded file reads only when results are incomplete, the file is unindexed or marked stale, the target is non-code text, or exact literal matching is required.
- After edits, inspect the changed diff and rely on the TypeScript build and focused tests for correctness because the index may lag file writes.
- If CodeGraph reports `Transport closed`, an unavailable server, or an uninitialized project, report the issue once and continue with targeted shell tools. Do not repeatedly retry it or initialize/rebuild the index unless the user requests that action.
- Keep fallback output bounded: request relevant line ranges and file-specific diffs instead of dumping complete large files or repository-wide diffs into the session.

## Build, Test, and Development Commands

Use Node.js 18 or newer and install from the repository root:

```bash
npm install
npm run build
npm test
npm run dev:desktop
npm run dev:cli -- user@example.com -p 22
```

`npm run build` compiles all workspaces in dependency order. `npm test` runs the core and desktop suites. The `dev` commands start Electron or the CLI. Target one package with workspace syntax, for example `npm test -w @spotshell/core`. Create Windows artifacts with `npm run pack -w @spotshell/desktop`.

## Coding Style & Naming Conventions

TypeScript runs in strict mode and targets ES2022. Follow local style: two-space indentation, single quotes, trailing commas in multiline structures, and existing semicolon usage (core uses semicolons; desktop generally does not). Use `PascalCase` for classes and React components and `camelCase` for functions and variables. NodeNext imports in core and CLI must include `.js` extensions. No repository-wide formatter or linter is configured; run the build for type checking.

## Testing Guidelines

Tests use Node's built-in `node:test` API, executed through `tsx`. Place regression tests beside the affected module and name them `<module>.test.ts`. Cover success, failure, validation, and cleanup paths where relevant. There is no formal coverage threshold; prioritize SSH safety, command-risk classification, IPC validation, credential handling, and session lifecycle behavior.

## Commit & Pull Request Guidelines

History uses short Chinese summaries and Conventional Commit-style subjects such as `feat(core): ...` and `feat(desktop): ...`. Prefer an imperative, scoped subject describing one logical change. Pull requests should explain user-visible behavior, identify affected workspace(s), list tests run, and link the relevant issue or plan. Include screenshots for renderer UI changes and call out configuration, credential, or SSH security implications.

## Security & Configuration

Copy `.env.example` to `.env` for local OpenAI settings. Never commit API keys, passwords, private keys, host data, logs, or generated installers. Preserve schema validation and Electron main/preload/renderer boundaries when adding IPC operations.

## Agent skills

### Issue tracker

Issues and PRDs use local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without renaming. See `docs/agents/triage-labels.md`.

### Domain docs

SpotShell uses one shared domain context: `docs/domain/glossary.md` and ADRs under `docs/decisions/`. See `docs/agents/domain.md`.
