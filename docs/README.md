# Documentation

Where each kind of document goes. The rules come from `workflow/doc-routing.md` in the shared workflow docs.

| Path                                  | Holds                                             | Lifespan                                                       |
| ------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Code map, invariants, request flow                | Permanent; update it in the pull request that changes the code |
| [decisions](decisions)                | One ADR per irreversible choice, `NNNN-<slug>.md` | Append-only; supersede, never edit                             |
| [dependencies.md](dependencies.md)    | Ledger of direct dependencies                     | Permanent; one row per dependency                              |
| specs                                 | Functional specs for a feature in flight          | Medium; fold into ARCHITECTURE.md or tests when done           |
| plans                                 | Task checklists                                   | Ephemeral; commit, then `git rm` on merge                      |
| archive                               | Retired specs and old lesson rows                 | Reference only                                                 |

Create the specs, plans and archive folders when you first need them.
