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

## WashPilot theme tokens

`src/theme.css` is the shared Tailwind v4 palette and semantic light/dark token
set. The app imports it from `src/index.css`, and consumers can import the
package export `@lavauto/shared-ui/theme.css`.

- Brand utilities: `bg-brand-500`, `text-brand-700`, etc.
- Semantic surfaces and text: `bg-bg`, `bg-bg-elevated`, `bg-bg-subtle`,
  `text-text`, `text-text-muted`, `text-text-subtle`.
- Primary action: `bg-primary text-primary-foreground`.
- Accessible orange action: `bg-action-accent text-action-accent-foreground`.
  The bright `accent-500` is available for decorative use, but white text on it
  does not meet WCAG AA; use `accent-700` or the semantic action token instead.
- `bg-accent` remains a neutral interaction surface for shadcn/Base UI menus;
  it is distinct from the orange `accent-500` palette.

Light is the first-visit default; dark is a user choice, and “Système” remains
available explicitly. `tests/washpilot-theme.test.ts` checks text/action contrast
for the chosen light and dark foreground/background pairings.
