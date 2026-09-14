---
name: update-chatgpt
description: Use when updating codex-desktop-linux from origin/main, repairing Fedora feature drift, or producing or installing the signed-upstream Fedora RPM on the update branch.
---

# Update ChatGPT

## Overview

Preserve local history and accept only when signed-upstream, Fedora patch-report,
RPM, and Git provenance evidence agree. The sole downstream target is an RPM for
the current Fedora host and architecture. Never suppress patch drift.

Do not build, inspect, validate, or update any non-RPM downstream artifact,
another distribution, another OS, or another architecture. The sole exception
is the signed upstream `.deb` trust chain: verify its repository metadata and
hash, extract only its data payload, and inspect that extracted payload when
patch drift requires it. Never produce a downstream `.deb` deliverable.

## Procedure

1. Read `AGENTS.md`. In a secondary worktree, locate the primary and read its `AGENTS.local.md` when present. Run `lcm search` for the package version and failing feature.
2. Inventory status, branch, remotes, worktrees, and unrelated dirty state. Local `fix/updates` pushes to `bcdonadio/fix/updates`. Require the build host itself to be Fedora and build only its current supported architecture:

   ```bash
   . /etc/os-release
   test "$ID" = fedora
   case "$(uname -m)" in x86_64|aarch64) ;; *) exit 1 ;; esac
   command -v rpmbuild rpm dnf >/dev/null
   ```
3. Fetch and merge without discarding history:

   ```bash
   git fetch --prune origin
   git log --oneline HEAD..origin/main
   git log --oneline origin/main..HEAD
   git diff --stat origin/main...HEAD
   git merge --no-commit --no-ff origin/main
   ```

4. Resolve semantically. Prefer upstream only when it owns the same behavior or newer bundle contract; retain independent Fedora behavior. Search the shared runtime contracts and Fedora RPM consumers before deleting a descriptor, hook, test, resource, or package input. Do not expand the review into format-specific consumers for other targets.
5. Run `git diff --check` and focused tests for conflicted, retained-local, and changed-upstream Fedora runtime or RPM paths. Do not substitute a broad cross-platform suite or distribution matrix. Create a clean build identity:

   ```bash
   git commit -S --signoff --no-edit
   git show --show-signature --no-patch HEAD
   ```

6. Build the Fedora RPM from signed stable APT metadata. Keep repository writes
   unprivileged and invoke the RPM target directly so package-format detection
   cannot widen the scope:

   ```bash
   mkdir -p .tmp/native-update
   case "$(uname -m)" in
     x86_64) expected_app_arch=x64; expected_rpm_arch=x86_64 ;;
     aarch64) expected_app_arch=arm64; expected_rpm_arch=aarch64 ;;
   esac
   package_version="$(date -u +%Y.%m.%d.%H%M%S)+$(git rev-parse --short=12 HEAD)"
   rpm_version="${package_version%%+*}"
   rpm_release="${package_version#*+}"
   rpm_path="$PWD/dist/codex-desktop-${rpm_version}-${rpm_release}.${expected_rpm_arch}.rpm"
   test ! -e "$rpm_path"
   TMPDIR="$PWD/.tmp/native-update" \
     PACKAGE_VERSION="$package_version" \
     make build-native-feature-helpers build-app rpm
   test -f "$rpm_path"
   ```

   Do not use `make package`, `make install-native`, or `make update-native` in
   this workflow because they dispatch by distribution and combine unrelated
   stages. Never use a `latest` URL or execute upstream maintainer scripts. Do
   not refresh Nix pins or any other format metadata when signed stable moves;
   the Fedora build resolves and verifies its source independently.
7. On failure or enabled-feature drift, inspect the newest transaction's `patch-report.json`, `upstream-linux-package.json`, and extracted current bundle. Add a current-shape failing fixture, verify RED, retarget the narrow semantic anchor, verify GREEN, commit with `-S --signoff`, and rerun clean. Require build exit zero, atomic candidate promotion, and:

   ```bash
   node scripts/ci/validate-patch-report.js dist-next/rebuild/patch-report.json --profile upstream-build
   ```

8. Use the `rpm_path` bound before the build; do not select an artifact by
   recency or glob. Canonicalize it, record its SHA-256 and exact NEVRA, require
   both RPM digests to be `OK`, and confirm the build report identifies Fedora,
   RPM, and the current architecture:

   ```bash
   jq . codex-app/.codex-linux/build-info.json
   rpm_path="$(/usr/bin/realpath "$rpm_path")"
   rpm_sha256="$(/usr/bin/sha256sum "$rpm_path" | /usr/bin/awk '{print $1}')"
   [[ "$rpm_sha256" =~ ^[0-9a-f]{64}$ ]]
   rpm_nevra="$(/usr/bin/rpm -qp --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}' "$rpm_path")"
   [[ "$rpm_nevra" == codex-desktop-* ]]
   test "$(/usr/bin/rpm -qp --qf '%{ARCH}' "$rpm_path")" = "$expected_rpm_arch"
   /usr/bin/sha256sum "$rpm_path"
   rpm_verification="$(/usr/bin/rpm -Kv "$rpm_path")"
   printf '%s\n' "$rpm_verification"
   /usr/bin/grep -Fq 'Header SHA256 digest: OK' <<<"$rpm_verification"
   /usr/bin/grep -Fq 'Payload SHA256 digest: OK' <<<"$rpm_verification"
   jq -e --arg arch "$expected_app_arch" \
     '.linuxTarget.distro.id == "fedora" and
      .linuxTarget.packageFormat == "rpm" and
      .linuxTarget.arch == $arch' \
     codex-app/.codex-linux/build-info.json
   ```

   If the task only requests the artifact, stop the delivery path after artifact
   verification and continue to the commit/push step. If installation is
   requested or already authorized, read `NoNewPrivs` from `/proc/self/status`
   before the privileged action. In intentional sandbox mode, request
   authorization exactly once. One
   fail-fast transient root unit must copy the user-writable artifact into a
   fresh root-owned directory, recheck and install only that staged copy,
   reload the system manager, and run root-context verification:

   ```bash
   set -o pipefail
   unit="codex-desktop-install-$(date -u +%Y%m%dT%H%M%S)-$$"
   unit_log="$PWD/.tmp/native-update/$unit.log"
   systemd-run --system --wait --pipe --collect --service-type=exec \
     --expand-environment=no --unit="$unit" \
     --setenv="RPM_PATH=$rpm_path" --setenv="RPM_SHA256=$rpm_sha256" \
     --setenv="RPM_NEVRA=$rpm_nevra" \
     /usr/bin/bash -ceu '
       stage=$(/usr/bin/mktemp -d /var/tmp/codex-desktop-install.XXXXXXXX)
       trap '\''/usr/bin/rm -rf -- "$stage"'\'' EXIT
       /usr/bin/chmod 0700 "$stage"
       /usr/bin/install -m 0600 -- "$RPM_PATH" "$stage/package.rpm"
       staged="$stage/package.rpm"
       actual=$(/usr/bin/sha256sum "$staged"); actual=${actual%% *}
       test "$actual" = "$RPM_SHA256"
       test "$(/usr/bin/rpm -qp --qf '\''%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}'\'' "$staged")" = "$RPM_NEVRA"
       verification=$(/usr/bin/rpm -Kv "$staged")
       printf "%s\n" "$verification"
       /usr/bin/grep -Fq "Header SHA256 digest: OK" <<<"$verification"
       /usr/bin/grep -Fq "Payload SHA256 digest: OK" <<<"$verification"
       /usr/bin/codex-update-manager install-rpm --path "$staged"
       /usr/bin/systemctl daemon-reload
       test "$(/usr/bin/rpm -q --qf '\''%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}'\'' codex-desktop)" = "$RPM_NEVRA"
       verify_output=$(/usr/bin/rpm -V codex-desktop)
       test -z "$verify_output"
     ' 2>&1 | /usr/bin/tee "$unit_log"
   test "${PIPESTATUS[0]}" -eq 0
   ```

   Do not put repository builds or direct `systemctl --user` commands in the
   root unit; package scriptlets may use `runuser` for their normal user-service
   maintenance. Do not split privileged work across multiple `systemd-run`
   invocations: every invocation can require another fingerprint authorization.
   Keep `--expand-environment=no` so systemd does not consume the embedded Bash
   variables before execution. Require the one `systemd-run --wait` result to
   be successful and inspect `unit_log` for the exact DNF transaction. The packaged
   updater's privileged `install-rpm` subcommand invokes DNF directly; do not
   use `install-ready`, which would start another authorization helper. Require
   the installed NEVRA to equal `RPM_NEVRA` and `rpm -V` to emit no differences.
   Then finish unprivileged readback, stopping on any failure:

   ```bash
   set -euo pipefail
   test "$(/usr/bin/rpm -q --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}' codex-desktop)" = "$rpm_nevra"
   /usr/bin/systemctl --user daemon-reload
   /usr/bin/systemctl --user is-enabled codex-update-manager.service
   /usr/bin/systemctl --user is-active codex-update-manager.service
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
- Require artifact and report evidence; `make` exit zero alone is insufficient.
  When installation is in scope, also require exact installed-package evidence.
- Keep the workflow on the current Fedora architecture and the RPM output. Do
  not run distro matrices or inspect, build, validate, refresh, or publish a
  non-RPM downstream artifact, other-distro metadata, or other-architecture
  metadata. The signed upstream `.deb` trust input remains the sole exception.
- In intentional sandbox mode, never fall back to `sudo` or `pkexec`, never run
  more than one privileged `systemd-run`, and reject a nonzero unit result,
  unexpected DNF transaction, digest mismatch, or any root-context `rpm -V`
  output.
- On `EDQUOT` or error `-122`, retain workspace `TMPDIR` and inspect bytes and inodes.
- Do not kill an open GUI during replacement unless a live restart was requested; verify installed files.
