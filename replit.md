# Vision2Mesh AI

An image-to-3D reconstruction studio for blueprints, sketches, character and animal images, and four-view captures.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server on port 8080
- `pnpm --filter @workspace/vision2mesh run dev` — Vision2Mesh web app
- `pnpm run typecheck` — typecheck all packages
- `pnpm run build` — typecheck and build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client and Zod schemas after editing OpenAPI
- `pnpm --filter @workspace/db run push` — apply development database schema changes

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web: React, Vite, Wouter, TanStack Query
- API: Express 5, esbuild (ESM output), Pino
- API contract and validation: OpenAPI, Orval, Zod v4
- Database package: PostgreSQL and Drizzle ORM
- 3D generation: the server-side Replit Tripo3D connector

## Where Things Live

- `artifacts/vision2mesh/` — single-page reconstruction workspace and its themes
- `artifacts/api-server/src/routes/reconstruction.ts` — server-side image upload, task, status, conversion, and model download handlers
- `lib/api-spec/openapi.yaml` — source-of-truth HTTP contract
- `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/` — generated types, hooks, and validators
- `attached_assets/` — user-provided UI and image references; these are design/input references, not pre-generated model outputs

## Product

- The workspace focuses on one selected mode and one result at a time: Blueprint, Sketch, Character, Animal, or 3D Scan.
- The 3D Scan mode uses four manually captured or uploaded views (front, left, back, right). It does not use LiDAR or claim true depth scanning.
- Users can inspect the provider's real returned model and request a file-format conversion. Format conversion does not validate mesh repair, manifold geometry, units, or print readiness.
- Users can switch between dark and light themes; the choice persists in local storage.
- Uploaded images are forwarded to Tripo3D for generation. Do not imply they stay local or are used only for this application.

## Architecture Decisions

- Tripo credentials remain behind the API server. Never call the connected provider directly from browser code.
- Image uploads use raw binary requests. The server validates PNG/JPEG/WebP bytes because the generated client sends `application/octet-stream`.
- Tripo's generated-model links expire quickly; refresh task status before proxying a model download.
- Blueprint, sketch, character, and animal use single-image reconstruction. A four-view scan uses the provider's multiview route; neither path guarantees the subject's exact geometry.

## Gotchas

- The installed Tripo connector is configured for `/v2/openapi`. Tripo's official documentation says V2 stopped receiving maintenance on October 1, 2026 and will stop serving requests on November 1, 2026. Treat a supported-provider migration as an urgent prerequisite for continued operation.
- Reconstruction task metadata is currently process-local on the API server. The UI preserves the current task ID in the same browser's local storage, but tasks are not yet durable across server restarts or shared across user accounts.
- The generation endpoints have no sign-in or per-user credit limits. Do not publish this API openly until access controls and provider-usage limits are added.
- The research PDFs' referenced dataset and checkpoints were not present in the workspace. Do not describe provider-generated results as results from the prototype research model or as a trained Vision2Mesh model.

## User Preferences

- Keep the app focused on the selected mode and a single current result; do not show a mixed gallery of generated examples.
- Preserve dark and light theme options and the four-view-only camera workflow for 3D Scan.
- Do not present fabricated outputs as AI-generated models or promise blueprint fidelity or print readiness.