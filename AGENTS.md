# Repository Guidelines

## Project Structure & Module Organization
The Homey app entrypoint sits in `app.js`, orchestrating SSE subscriptions and scheduled refresh logic. `app.json` defines the app manifest and capabilities; mirror any schema updates there. Device-specific code lives in `drivers/vma/`, where `driver.js` wires pairing flows and `device.js` manages alert delivery. Assets such as icons reside in `assets/`, translations in `locales/`, and developer-facing siren audio in the top-level `mp3/`. Configuration blueprints (`driver.*.compose.json`) should remain source of truth for Homey Compose exports.

## Build, Test, and Development Commands
- `npm install` — install dependencies before any local run.
- `npm run lint` — run ESLint (`eslint-config-athom`) across JS/TS sources.
- `homey app run` — sideload the app to a development Homey bridge or Pro.
- `homey app test` — execute automated Homey CLI tests against a mocked environment.
- `homey app validate` — ensure manifest, drivers, and assets pass Homey preflight checks.

## Coding Style & Naming Conventions
Use modern JavaScript targeting Node 12 (see `tsconfig.json`). Indent with two spaces, prefer single quotes, and keep modules module-scoped rather than global. Name modules and files with lowercase words separated by hyphens where relevant; use `camelCase` for functions and variables, `PascalCase` only for classes, and `SCREAMING_SNAKE_CASE` for immutable configuration. Rely on ESLint autofix before committing to avoid formatting drift.

## Testing Guidelines
No formal unit suite exists yet; add tests alongside the functionality they exercise under a `tests/` directory or adjacent to the module. Use `homey app test` as the canonical execution path, and document any manual regression steps (e.g., SSE reconnect scenarios) in the PR. When altering alert delivery logic, verify both production and test endpoints and attach relevant Homey CLI logs.

## Commit & Pull Request Guidelines
Follow the concise, imperative message style already present (e.g., `Refactor to centralized SSE with nationwide device support`). Scope each commit to one concern and squash noisy work-in-progress commits before review. PRs should describe the user-facing change, reference associated issues or flows, and include screenshots or logs for UI/device updates. Ensure linting and Homey validation succeed prior to requesting review, and note any migration steps for drivers or settings.
