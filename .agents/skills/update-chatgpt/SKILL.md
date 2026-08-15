---
name: update-chatgpt
description: Use when updating codex-desktop-linux from origin/main, reconciling superseded Linux patches, or installing a signed-upstream native package on the update branch.
---

# Update ChatGPT

## Overview

Preserve local history and accept only when signed-upstream, patch-report, installed-RPM, and Git provenance evidence agree. Never suppress patch drift.

## Procedure

1. Read `AGENTS.md`. In a secondary worktree, locate the primary and read its `AGENTS.local.md` when present. Run `lcm search` for the package version and failing feature.
2. Inventory status, branch, remotes, worktrees, and unrelated dirty state. Local `fix/updates` pushes to `bcdonadio/fix/updates`.
3. Fetch and merge without discarding history:

   ```bash
   git fetch --prune origin
   git log --oneline HEAD..origin/main
   git log --oneline origin/main..HEAD
   git diff --stat origin/main...HEAD
   git merge --no-commit --no-ff origin/main
   ```

4. Resolve semantically. Prefer upstream only when it owns the same behavior or newer bundle contract; retain independent Linux behavior. Search descriptor, hook, test, README, and packaging consumers before deleting a patch.
5. Run `git diff --check` and focused tests for conflicted, retained-local, and changed-upstream features. Create a clean build identity:

   ```bash
   git commit -S --signoff --no-edit
   git show --show-signature --no-patch HEAD
   ```

6. Build and install from signed stable APT metadata:

   ```bash
   mkdir -p .tmp/native-update
   TMPDIR="$PWD/.tmp/native-update" make update-native
   ```

   Never use a `latest` URL or execute upstream maintainer scripts.
7. On failure or enabled-feature drift, inspect the newest transaction's `patch-report.json`, `upstream-linux-package.json`, and extracted current bundle. Add a current-shape failing fixture, verify RED, retarget the narrow semantic anchor, verify GREEN, commit with `-S --signoff`, and rerun clean. Require build exit zero, atomic candidate promotion, and:

   ```bash
   node scripts/ci/validate-patch-report.js dist-next/rebuild/patch-report.json --profile upstream-build
   ```

   Treat top-level legacy DMG decisions as stale unless the current workflow generated them.
8. Verify the exact new artifact and installation:

   ```bash
   jq . codex-app/.codex-linux/build-info.json
   sha256sum "$rpm_path"
   rpm -Kv "$rpm_path"
   rpm -q codex-desktop
   rpm -V codex-desktop
   sudo systemctl daemon-reload
   systemctl --user daemon-reload
   systemctl --user is-enabled codex-update-manager.service
   systemctl --user is-active codex-update-manager.service
   ```

   Set `rpm_path` to the exact new RPM. RPM shebang notices are corrective only when affected non-Unix files install non-executable and `rpm -V` is clean. For an unsigned local command-line RPM, record SHA-256 and require header/payload digests `OK`; never weaken DNF flags to hide the notice.
9. Review the exact diff and reports. Commit remaining source/skill changes with `git commit -S --signoff`, then:

   ```bash
   git push bcdonadio HEAD:fix/updates
   git ls-remote bcdonadio refs/heads/fix/updates
   ```

   Require remote SHA = local `HEAD`. Persist version-specific drift and accepted-package evidence with `lcm store`.

## Stop Conditions

- Never reset/discard local commits without explicit authorization.
- Never push a rejected or inconclusive candidate.
- Never disable an enabled feature merely to get green without explicit user choice.
- Repair source descriptors/hooks/tests, not generated output.
- Require installed-package and report evidence; `make` exit zero alone is insufficient.
- On `EDQUOT` or error `-122`, retain workspace `TMPDIR` and inspect bytes and inodes.
- Do not kill an open GUI during replacement unless a live restart was requested; verify installed files.
