# Repository mirror

`scripts/sync-mirror.mjs` synchronizes selected Git branches and tags between
two named remotes. `.forgejo/workflows/mirror.yml` runs it hourly at the top of
the hour and on manual dispatch. The workflow always checks out
`main`, serializes its runs and authenticates with a repository-scoped SSH
deploy key stored in the `TWO_WAY_MIRROR_SSH_KEY` Actions secret.

The default selection is `main` and `release/*`, matching the previous push
mirror. Tags are excluded by default. Use repeated `--branch` and `--tag`
arguments to select other refs. A `*` matches any sequence of characters,
including `/`. A dry run fetches objects and prints the proposed synchronized
refs without writing to either remote:

```sh
node scripts/sync-mirror.mjs --dry-run
node scripts/sync-mirror.mjs --branch '*' --tag '*' --dry-run
```

Branches advance only when one commit is an ancestor of the other. Divergent
branches, rewritten history, changed tag objects and simultaneous modification
and deletion stop synchronization. Resolve the affected refs explicitly and
rerun the workflow. The script does not create merges or discard commits.

The first run copies selected refs that exist on only one side. After a
successful run, `refs/mirror/checkpoint` on the left remote records their common
object IDs. Later runs propagate a deletion only if the remaining ref still
matches that checkpoint. Changes use atomic pushes and explicit leases, so a
concurrent destination update rejects the push. The checkpoint advances only
after a fresh comparison confirms both remotes match. If a run stops after
updating one remote, its next run reconciles from the previous checkpoint.

The checkpoint binds the remote URLs and ref selection. Changing those requires
reviewing and migrating or removing that internal checkpoint first. Keep remote
URLs free of embedded passwords or tokens. SSH host keys are pinned in the
workflow and the deploy key grants access only to the two mirrored repositories.

## Parameterized deployments

The same algorithm can run from `.forgejo/scripts/sync-mirror.mjs` in other
repositories. Parameterized workflows keep deployment values in repository
Actions variables instead of embedding site-specific configuration in source:

- `MIRROR_LEFT_URL` and `MIRROR_RIGHT_URL` contain Git remote URLs without passwords.
- `MIRROR_KNOWN_HOSTS` contains independently verified SSH host keys.
- `MIRROR_BRANCHES` and `MIRROR_TAGS` contain JSON arrays of wildcard patterns.
  An empty tag array excludes tags. Branch patterns must contain at least one
  nonempty pattern. Workflows pass these patterns through the script's repeated
  `--branch` and `--tag` options.
- The `TWO_WAY_MIRROR_SSH_KEY` Actions secret holds a dedicated deploy key with
  write access to the selected repository pair. Use a separate key per pair.

Copy the integration tests alongside the script and adjust their script import
path. Run them with `node --test .forgejo/scripts/sync-mirror.test.mjs`. Preserve
the source provider's branch protections when selecting a deployment method;
direct synchronization cannot update branches that reject deploy-key pushes.

An existing provider push mirror must be removed before enabling this workflow,
because it can overwrite changes that have not yet been imported. Issues,
pull requests, Actions runs and release assets are provider metadata and are
outside this Git synchronization.

Run the real-Git integration tests with `pnpm run test:mirror` or
`devenv tasks run test:mirror`.
