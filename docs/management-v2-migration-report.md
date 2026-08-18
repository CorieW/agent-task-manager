# Management v2 migration report

Applied in place on 2026-08-17 with no backup export or duplicate databases.

## Observed IDs

| Record family | Data-source ID                         |
| ------------- | -------------------------------------- |
| Tasks         | `d9e9a6ef-cd58-82d3-a726-87a4691ba9bf` |
| Agents        | `ad39a6ef-cd58-8303-8ac4-876b007e359f` |
| Active Agents | `fc836d14-d8c0-4da3-8960-d24c345f280e` |
| Errors        | `ed29a6ef-cd58-8219-9623-0787fdee9b22` |
| Resources     | `7919a6ef-cd58-8311-b121-87e8e2d7db5b` |

Parent: `3bf9a6ef-cd58-80ee-af0e-def3125a1534`

Retired Operations data source: `6759a6ef-cd58-8314-9c7c-0707b7f90e0f`

## Final live counts

| Record family | Count |
| ------------- | ----: |
| Tasks         |     0 |
| Agents        |     8 |
| Active Agents |     0 |
| Errors        |     0 |
| Resources     |    18 |

The 5 legacy Errors, 9 machine-control Resources, and retired `policy/perfect-project` Resource were moved into Operations before that database was trashed. No Active Agent was created for the stale Code Reviewer projection.

All 8 Agent pages and all 18 retained Resource pages were refetched after conversion. Agent Keys, Reasoning, canonical Transitions JSON, Prompt/Policy relations, concise Agent descriptions, and the simplified harness contract were present. The retained Resource audit found no references to the retired execution concepts.

Canonical required schema digest: `c7313295073bdf11f36bf81d578fb90d354c5e9c6db7674cbbc58fd1a3551f45`

Views verified: updated Tasks, Agents, Errors, and Resources tables; Active Agents `Active` and `Failures` views.
