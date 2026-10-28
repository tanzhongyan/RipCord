# 3. Frontend dependency policy

Date: 2026-10-27

## Context

The central dependency rule applies to every repository. It does not name the frontend capabilities where a library is usually premature, or say when one becomes justified. Without a table, each contributor and each agent decides alone, and the bundle grows by habit.

This ADR adds the frontend specifics. It does not restate the universal rule.

## Decision

### Trigger table

Start with the default. Add the preferred library only when its trigger is true, and record it in `docs/dependencies.md`.

| Capability                      | Default with no new dependency                                   | Trigger that justifies a library                                                              | Preferred library                            |
| ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Server state                    | tRPC with TanStack Query (already installed)                     | None; do not add a second fetching layer                                                      | `@tanstack/react-query`                      |
| Client or global state          | `useState`, `useReducer`, context for one subtree                | Three or more distant components read and write the same state, or updates re-render too much | `zustand`                                    |
| URL state (filters, pagination) | `useSearchParams` and `router.replace`                           | More than three params, or typed parsing is repeated in two places                            | `nuqs`                                       |
| Forms                           | Controlled inputs with the feature's Zod schema                  | Five or more fields, dependent fields, or field arrays                                        | `react-hook-form` with `@hookform/resolvers` |
| Dates and times                 | `Intl.DateTimeFormat`, then `Temporal` when the runtime ships it | Time zone arithmetic that `Intl` cannot do                                                    | `date-fns`                                   |
| Tables                          | A semantic `<table>` with `map`                                  | Sorting, column resizing or virtualised rows above roughly 500 rows                           | `@tanstack/react-table`                      |
| Charts                          | A table or inline SVG                                            | Two or more chart types, or interactive tooltips                                              | `recharts`                                   |
| Animation                       | CSS transitions and `tw-animate-css`                             | Layout or gesture animation CSS cannot express                                                | `motion`                                     |
| Icons                           | `lucide-react` only                                              | None; a second icon set is not allowed                                                        | `lucide-react`                               |
| Toasts                          | An inline status region                                          | Two or more features raise transient messages                                                 | `sonner` through `shadcn add sonner`         |
| Rich text                       | `<textarea>`                                                     | Users need formatting, mentions or embeds                                                     | `@tiptap/react`                              |
| i18n                            | Plain strings in one locale                                      | A second locale is a product requirement                                                      | `next-intl`                                  |
| Validation                      | `zod` only                                                       | None; do not add a second validator                                                           | `zod`                                        |

### When to split into a workspace package

Stay a single package until a second deployable needs the same code. Then move that code into a Bun workspace at `packages/<name>` with an explicit `exports` map in its `package.json`. Consumers import the package name and never a deep path into it.

shadcn primitives stay app-owned in `src/shared/components/ui`. Features compose them and do not edit them to hold feature logic.

## Consequences

- A pull request that adds a library cites a trigger from the table, or amends this ADR with a new row.
- The ledger shows what each library replaced, so removals are easy to find.
- Splitting into packages is deferred, so the template carries no workspace configuration.
