# Repository Guidelines

## Project Structure & Module Organization
- `src/runtime.ts` contains the Redis-backed Astro cache provider implementation.
- `src/config.ts` exposes the `redisCache()` helper used from `astro.config`.
- `src/runtime.test.ts` contains integration-style tests for cache behavior.
- `src/schemas.bop` is the Bebop source schema.
- `src/schemas.ts` is generated from `src/schemas.bop`, ignored by Biome, and must never be edited manually.
- `dist/` is build output (published entrypoints and declarations).
- Root configs: `package.json`, `tsconfig.json`, `biome.json`, and `compose.yml` (local Valkey service).

## Build, Test, and Development Commands
- `pnpm build`: compile TypeScript from `src/` to `dist/` using `tsgo`.
- `pnpm check`: type-check only (`--noEmit`).
- `pnpm lint`: run Biome lints.
- `pnpm format`: check formatting; `pnpm format:fix` applies fixes.
- `pnpm test`: build first (`pretest`), then run Node tests with coverage over `dist/*.test.js`.
- `docker compose up -d valkey`: start local Redis-compatible backend at `127.0.0.1:6379`.
- `pnpm generate:schemas`: regenerate `src/schemas.ts` from `src/schemas.bop`.

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` mode, NodeNext modules, ESM).
- Development language policy: source code, documentation, and code comments must be written in English.
- Manage dependencies exclusively through `pnpm` commands (for example, `pnpm add`, `pnpm remove`, and `pnpm up`).
- Do not manually edit dependency sections in `package.json`; use `pnpm` to apply those changes.
- The package must strictly implement Astro's custom cache provider interface: https://docs.astro.build/en/reference/experimental-flags/route-caching/#writing-a-custom-cache-provider
- Formatting/linting: Biome (`spaces`, `double` quotes, organize imports).
- Keep exported API names explicit (`createRedisCacheProvider`, `redisCache`).
- Use descriptive camelCase for functions/locals, PascalCase for types/interfaces.
- Never hand-edit `src/schemas.ts`; regenerate it only with `pnpm generate:schemas`.

## Testing Guidelines
- Framework: Node built-in `node:test` with `node:assert/strict`.
- Test files: `*.test.ts` under `src/`.
- Prefer behavior-focused test names (e.g., `"returns STALE and revalidates in background"`).
- Tests require a reachable Redis/Valkey instance. Set `REDIS_URL` if not using local default.
- Test runs connect to local Redis/Valkey in Docker. In sandboxed environments, tests are expected to fail unless sandbox restrictions are lifted.
- Agents must explicitly request user approval before running test commands that need access outside the sandbox.

## Agent Communication Language
- The agent must reply to the user in the same language used by the user.
- Avoid anglicisms when a common equivalent exists in the conversation language.
- Exceptions: file names, variable names, function names, package names, commands, and terms without a practical equivalent.

## Ambiguity Handling
- If there are questions, missing details, or ambiguity, do not guess and do not force a workaround just to proceed.
- Stop and ask the user for clarification before continuing.

## Commit Guidelines
- Repository currently has no commit history; use Conventional Commits (`feat:`, `fix:`, `chore:`) for a clean baseline.
- Keep commits small and scoped to one concern.
- Follow the 50/72 rule: subject line up to 50 chars; wrap body at 72 chars.
