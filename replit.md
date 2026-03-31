# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **AI**: Anthropic Claude via Replit AI Integrations

## Applications

### TikTok診断ツール (SIN JAPAN)

A TikTok account diagnostic tool. Users upload a screenshot of their TikTok profile, Claude Vision AI analyzes it, and the app returns a rank (GOD/S/A/B/C) with scores and advice.

- **Frontend**: `artifacts/api-server/static/index.html` — diagnosis tool
- **Admin**: `artifacts/api-server/static/admin.html` — admin dashboard (password: sinjapan2025)
- **API Routes**: `artifacts/api-server/src/routes/diagnose.ts`, `admin.ts`
- **DB schema**: `lib/db/src/schema/users.ts` — `tiktok_users` table
- **Paths**: `/` (frontend), `/admin` (admin panel), `/api/*` (API)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server + static HTML frontend
│       ├── src/             # Server source
│       └── static/          # Static HTML (index.html, admin.html, uploads/)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   └── integrations-anthropic-ai/ # Anthropic AI integration
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — only emit `.d.ts` files during typecheck
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server + static frontend. Routes live in `src/routes/`.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes, static files
- Routes: `diagnose.ts` (POST /api/diagnose, POST /api/save-result, POST /api/line-register), `admin.ts` (GET /api/admin/stats, GET /api/admin/users), `health.ts` (GET /api/healthz)
- Static: serves `/` → `static/index.html`, `/admin` → `static/admin.html`, `/api/static/uploads` → uploaded images
- Depends on: `@workspace/db`, `@workspace/api-zod`

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/schema/users.ts` — `tiktok_users` table (TikTok user diagnosis records)

### Admin Panel

URL: `/admin`
Password: `sinjapan2025` (defined in static/admin.html)
