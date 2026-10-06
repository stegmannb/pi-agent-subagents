# Protected repository synchronization

Forgejo is canonical and uses Tier 1 with release profile `none`. Main accepts
reviewed PR merges only, including administrator changes. Current CI and one
independent approval from Reviewers are required; only Owners merge.

An external coordinator publishes selected Forgejo branches hourly. Incoming
GitHub commits create or update Forgejo import PRs and receive the same gates.
Use fast-forward-only merging for imports to preserve commit identities.
The coordinator never merges a PR or overwrites pending GitHub changes.
Divergence needs explicit reconciliation. Ref deletion and tag changes require
Owner action. Synchronization credentials live outside target repository CI.

The required checks and workflow inventory are in `.forgejo/tier1.json`.
All PR CI checks out the exact PR head without persisted credentials or
publishing access. CODEOWNERS covers workflows, source, and packaging.
