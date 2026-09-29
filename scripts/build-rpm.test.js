"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const isFedora = /^ID=(?:"fedora"|fedora)$/m.test(fs.readFileSync("/etc/os-release", "utf8"));
const nativeArch = { x64: "x86_64", arm64: "aarch64" }[process.arch];

test("Fedora RPM preserves stripped and debug ELF payloads byte-for-byte", {
  skip: !isFedora || nativeArch == null,
  timeout: 120_000,
}, (t) => {
  const temporaryRoot = path.join(repoRoot, ".tmp", "native-update");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(temporaryRoot, "rpm-preserve-elf-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const run = (command, args, options = {}) => execFileSync(command, args, {
    cwd: workspace,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TMPDIR: workspace },
    ...options,
  });
  const staging = path.join(workspace, "staging");
  const app = path.join(staging, "opt", "codex-desktop");
  fs.mkdirSync(path.join(app, "resources"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "fixture.c"), "int main(void) { return 0; }\n");
  const debugElf = path.join(app, "ChatGPT");
  const strippedElf = path.join(app, "resources", "codex");
  run("cc", ["-g", "-O0", "fixture.c", "-o", debugElf]);
  fs.copyFileSync(debugElf, strippedElf);
  run("strip", ["--strip-all", strippedElf]);
  const expected = new Map([debugElf, strippedElf].map((file) => [file, fs.readFileSync(file)]));
  assert.match(run("readelf", ["-S", debugElf], { encoding: "utf8" }), /\.debug_info/);
  assert.match(run("readelf", ["-S", strippedElf], { encoding: "utf8" }), /\.comment/);

  for (const [relativePath, content, mode] of [
    ["etc/apparmor.d/codex-desktop", "# fixture\n", 0o644],
    ["usr/bin/codex-desktop", "#!/usr/bin/env bash\nexit 0\n", 0o755],
    ["usr/share/applications/codex-desktop.desktop", "[Desktop Entry]\nType=Application\nName=Fixture\nExec=codex-desktop\n", 0o644],
    ["usr/share/icons/hicolor/256x256/apps/codex-desktop.png", "fixture icon\n", 0o644],
  ]) {
    const file = path.join(staging, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
  }
  const substitutions = {
    __PACKAGE_NAME__: "codex-desktop",
    __RPM_VERSION__: "1.0",
    __RPM_RELEASE__: "1",
    __ARCH__: nativeArch,
    __PACKAGE_WITH_UPDATER__: "0",
    __RPM_STAGING_DIR__: staging,
    ", __LINUX_FEATURE_DEPENDENCIES__": "",
    __LINUX_FEATURE_FILES__: "",
  };
  let spec = fs.readFileSync(path.join(repoRoot, "packaging/linux/codex-desktop.spec"), "utf8");
  for (const [token, replacement] of Object.entries(substitutions)) spec = spec.replaceAll(token, replacement);
  assert.doesNotMatch(spec, /__[A-Z][A-Z_]+__/);
  const specFile = path.join(workspace, "codex-desktop.spec");
  fs.writeFileSync(specFile, spec);
  run("rpmbuild", [
    "-bb", "--define", `_topdir ${workspace}/rpmbuild`,
    "--define", "_smp_ncpus_max 1", "--define", "_binary_payload w1T1.zstdio",
    specFile,
  ], { encoding: "utf8" });
  const rpmDirectory = path.join(workspace, "rpmbuild", "RPMS", nativeArch);
  const packages = fs.readdirSync(rpmDirectory).filter((file) => file.endsWith(".rpm"));
  assert.equal(packages.length, 1, "debug extraction must not produce a second RPM");
  const archive = run("rpm2cpio", [path.join(rpmDirectory, packages[0])]);
  const extracted = path.join(workspace, "extracted");
  fs.mkdirSync(extracted);
  run("cpio", ["--extract", "--make-directories", "--quiet", "--no-absolute-filenames"], {
    cwd: extracted,
    input: archive,
  });
  for (const [original, bytes] of expected) {
    const payload = path.join(extracted, path.relative(staging, original));
    assert.deepEqual(fs.readFileSync(payload), bytes, `${path.relative(staging, original)} changed during RPM packaging`);
  }
  assert.match(
    fs.readFileSync(path.join(extracted, "usr/bin/codex-desktop"), "utf8"),
    /^#!\/usr\/bin\/bash\n/,
    "Fedora shebang postprocessing remains active",
  );
});
