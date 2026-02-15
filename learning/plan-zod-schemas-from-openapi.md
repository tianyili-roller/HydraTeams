# Plan: Auto-Generate Zod Schemas from OpenAPI Specs

## Context

HydraTeams is a translation proxy between Anthropic and OpenAI API formats. The project currently uses hand-written TypeScript interfaces (`src/translators/types.ts`) with **no runtime validation**. Zod is installed (`4.3.6`, devDep) but unused. The user wants to generate Zod schemas from official OpenAPI specs so that runtime type checking (e.g. `safeParse`) can be used in tests and shared across modules.

## Approach

Use `@hey-api/openapi-ts` with its Zod plugin. Two OpenAPI specs:
- **OpenAI:** official spec from `github.com/openai/openai-openapi`
- **Anthropic:** community spec from `github.com/laszukdawid/anthropic-openapi-spec`

## Files to Create/Modify

| File | Action |
|------|--------|
| `package.json` | Add `@hey-api/openapi-ts` devDep + 3 npm scripts |
| `.gitignore` | Add `specs/*` with negation for `specs/README.md` |
| `openapi-ts.config.ts` | Create — codegen config for both specs |
| `specs/README.md` | Create — document spec sources |
| `src/schemas/index.ts` | Create — curated re-export barrel |
| `src/schemas/generated/**` | Generated — Zod schemas + TS types |

## Steps

### 1. Install `@hey-api/openapi-ts`
```bash
npm install -D @hey-api/openapi-ts
```

### 2. Create `specs/` directory + `specs/README.md`
Document the two spec sources and how to update them.

### 3. Add npm scripts to `package.json`
```json
"specs:download": "curl -sL -o specs/anthropic.json <anthropic-url> && curl -sL -o specs/openai.yaml <openai-url>",
"schemas:generate": "openapi-ts",
"schemas:update": "npm run specs:download && npm run schemas:generate"
```

### 4. Create `openapi-ts.config.ts`
Array-syntax `defineConfig` with two jobs (Anthropic + OpenAI). Plugins: `@hey-api/typescript` + `zod` only — no SDK/client generation. Keep zero-runtime-dep for codegen itself.

### 5. Download specs & run codegen
```bash
npm run schemas:update
```

### 6. Create `src/schemas/index.ts`
Hand-curated barrel that re-exports the most relevant schemas (Messages API, Chat Completions, content blocks, tools). Exact export names determined after first generation run.

### 7. Verify `npm run build` passes

## Design Decisions

- **Generated files committed to git** — avoids forcing codegen before build
- **Spec files gitignored** — large, change often upstream, re-downloadable
- **Existing `types.ts` kept as-is** — generated schemas supplement, not replace (yet)
- **Curated barrel** — OpenAI spec has ~284 schemas; only re-export what HydraTeams needs
- **No runtime dep change yet** — zod stays devDep until proxy.ts actually uses safeParse at runtime

## Verification
1. `npm run schemas:update` succeeds
2. `npm run build` compiles cleanly
3. Generated `zod.gen.ts` files contain expected schemas (Message, ContentBlock, ChatCompletion, etc.)
4. Quick test: `import { ... } from './schemas/index.js'` works in a scratch file

## Research Background

This plan was informed by a 10-agent parallel research sweep that analyzed:
- Both official SDKs (@anthropic-ai/sdk, openai) for runtime type guards and Zod exports
- Community packages (@open-schemas/zod, zod-gpt, openai-zod-functions)
- OpenAPI-to-Zod codegen tools (openapi-zod-client, @hey-api/openapi-ts, orval, @flatfile/openapi-to-zod)

**Key finding:** Neither SDK provides runtime type guards or Zod schemas for API types. Both only offer Zod helpers for user-defined schemas (structured outputs / tool definitions). `@hey-api/openapi-ts` was chosen as the most production-ready codegen tool (used by Vercel, PayPal).
