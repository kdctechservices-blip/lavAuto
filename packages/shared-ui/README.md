# `@lavauto/shared-ui`

Private npm-workspace package for interaction and form patterns shared by the
station application and the editor console.

## Current exports

- `FormField`: consistent label, control, helper text and validation message;
  wires control IDs, `aria-describedby`, `aria-invalid` and `aria-required`.
- `Table` family: accessible native table structure with responsive overflow and
  shared design-token styling.
- `Dialog` family: Base UI-powered modal primitives shared across both app areas.

The package is intentionally small and consumed directly from TypeScript source
by the root Vite app. It is not a separately published or independently
deployed application package.

## Adoption so far

- Station onboarding: worker data-entry fields.
- Editor console: operator create/edit/reset/revoke form.
- The console operator screen uses the package `Dialog` and `Table` exports,
  rather than CoreUI modal/table components.
- It also uses the station's shared `useDataTable` behavior for search, sorting,
  pagination, empty states and persisted display preferences.
- Existing `src/components/ui/dialog.tsx` and `table.tsx` files are compatibility
  re-exports, so other screens can migrate without a large import rewrite.

The station app and console are still routes in one React SPA. This package is
an internal workspace, not a separately deployed application. Add patterns here
when at least two screens can use the same behavior and accessibility contract;
keep feature-specific table state and business logic with the consuming screen.
