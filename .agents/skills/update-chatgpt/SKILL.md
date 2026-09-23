---
name: update-chatgpt
description: Use when updating codex-desktop-linux from origin/main, repairing Fedora feature drift, or producing or installing the signed-upstream Fedora RPM on the update branch.
---

# Update ChatGPT

## Overview

Preserve local history and accept only when signed-upstream, Fedora patch-report,
RPM, and Git provenance evidence agree. The sole downstream target is an RPM for
the current Fedora host and architecture. Never suppress patch drift.

**Host privilege route:** this workspace can have `NoNewPrivs: 1`. For an
authorized RPM installation, use `ssh localhost` to reach the host and
`sudo -n` there. Check that route before starting an install. Do not try a
root `systemd-run` or Polkit prompt from the contained process.

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

   If the task only requests the artifact, continue to the commit/push step.
   When installation is requested or already authorized, record the user
   updater unit's enabled/active state, then preflight the host privilege route:

   ```bash
   updater_enabled_before="$(systemctl --user is-enabled codex-update-manager.service || true)"
   updater_active_before="$(systemctl --user is-active codex-update-manager.service || true)"
   awk '/^NoNewPrivs:/ {print}' /proc/self/status
   test "$(ssh -o BatchMode=yes localhost /usr/bin/hostname)" = "$(/usr/bin/hostname)"
   ssh -o BatchMode=yes localhost 'sudo -n /usr/bin/bash -se --' <<'PREFLIGHT'
   test "$(id -u)" = 0
   PREFLIGHT
   ```

   The SSH preflight must succeed before installation. A contained shell's
   `NoNewPrivs: 1` does not prevent host-side `sudo` over SSH. If host-side
   `sudo -n` fails, stop and report that privilege blocker; do not start a
   Polkit or `systemd-run` authorization chain. Pass the already verified
   artifact path, hash, and NEVRA as shell-quoted arguments to one SSH root
   shell. It copies the user-writable RPM into a fresh root-owned directory,
   rechecks the staged copy, installs only that copy, and verifies the result:

   ```bash
   set -o pipefail
   install_log="$PWD/.tmp/native-update/ssh-sudo-install-$(date -u +%Y%m%dT%H%M%S).log"
   printf -v remote_args '%q ' "$rpm_path" "$rpm_sha256" "$rpm_nevra"
   ssh -o BatchMode=yes localhost "sudo -n /usr/bin/bash -se -- $remote_args" <<'ROOT' 2>&1 | /usr/bin/tee "$install_log"
   set -euo pipefail
   rpm_path=$1
   rpm_sha256=$2
   rpm_nevra=$3
   stage=$(/usr/bin/mktemp -d /var/tmp/codex-desktop-install.XXXXXXXX)
   trap 'if test -f "$stage/package.rpm"; then /usr/bin/unlink "$stage/package.rpm"; fi; /usr/bin/rmdir "$stage"' EXIT
   /usr/bin/chmod 0700 "$stage"
   /usr/bin/install -m 0600 -- "$rpm_path" "$stage/package.rpm"
   staged="$stage/package.rpm"
   actual=$(/usr/bin/sha256sum "$staged"); actual=${actual%% *}
   test "$actual" = "$rpm_sha256"
   test "$(/usr/bin/rpm -qp --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}' "$staged")" = "$rpm_nevra"
   verification=$(/usr/bin/rpm -Kv "$staged")
   printf '%s\n' "$verification"
   /usr/bin/grep -Fq 'Header SHA256 digest: OK' <<<"$verification"
   /usr/bin/grep -Fq 'Payload SHA256 digest: OK' <<<"$verification"
   /usr/bin/codex-update-manager install-rpm --path "$staged"
   /usr/bin/systemctl daemon-reload
   test "$(/usr/bin/rpm -q --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}' codex-desktop)" = "$rpm_nevra"
   verify_output=$(/usr/bin/rpm -V codex-desktop)
   test -z "$verify_output"
   printf 'ROOT_INSTALL_VERIFIED %s\n' "$rpm_nevra"
   ROOT
   test "${PIPESTATUS[0]}" -eq 0
   ```

   Inspect `install_log`: DNF must replace exactly the intended
   `codex-desktop` package, with no additional package changes. The packaged
   updater's privileged `install-rpm` subcommand invokes DNF directly; do not
   use `install-ready`, which starts another authorization helper. Root-context
   `rpm -V` must emit no differences. Finish with unprivileged readback of the
   exact installed NEVRA, installed build and patch reports, and launcher
   diagnosis. Reload the user manager outside the root shell. Read back the
   updater unit's enabled/active state. A preexisting mask must remain masked
   and inactive; do not unmask it. If the unit was enabled and active before
   installation, require that state afterward. Do not present a user-chosen
   mask as an installation failure when the package evidence is clean.

   ```bash
   systemctl --user daemon-reload
   updater_enabled_after="$(systemctl --user is-enabled codex-update-manager.service || true)"
   updater_active_after="$(systemctl --user is-active codex-update-manager.service || true)"
   if [[ "$updater_enabled_before" == masked ]]; then
     test "$updater_enabled_after" = masked
     test "$updater_active_after" = inactive
   elif [[ "$updater_enabled_before" == enabled && "$updater_active_before" == active ]]; then
     test "$updater_enabled_after" = enabled
     test "$updater_active_after" = active
   fi
   ```

   If the SSH/root shell or readback fails, inspect the installed NEVRA and
   transaction log before considering a retry: installation may have completed
   even if a later check or connection failed. Treat a changed updater mask as
   a failed postcondition and report it without silently changing that setting.

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
- In intentional sandbox mode, use the host `ssh localhost` + `sudo -n` route
  for an authorized install. Stop if its read-only preflight fails. Reject a
  nonzero SSH/root-shell result, unexpected DNF transaction, digest mismatch,
  or any root-context `rpm -V` output. Never run a competing install route.
- On `EDQUOT` or error `-122`, retain workspace `TMPDIR` and inspect bytes and inodes.
- Do not kill an open GUI during replacement unless a live restart was requested; verify installed files.
