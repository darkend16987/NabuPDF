#!/usr/bin/env node
// Refuse to package an installer whose bundled sidecar predates the current
// Python source. Runs as the first step of `npm run build`.
//
// Cross-machine safety: the check is *commit-based*, not mtime-based. It compares
// the git commit recorded in dist/sidecar/SIDECAR_BUILD.json (written by
// write-sidecar-marker.js) against HEAD, and also flags uncommitted edits to any
// *.py / sidecar.spec. So pulling a teammate's api.py change and forgetting to
// rebuild the sidecar is caught here instead of silently shipping a stale binary.
//
// Override (e.g. an intentional renderer-only rebuild): SKIP_SIDECAR_CHECK=1.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Git pathspecs for everything the frozen sidecar is built FROM. Kept in one place
// because both the "changed since the build" and the "uncommitted" query must ask
// about the same set, and a mismatch between them is silent.
//
// models/vietocr/*.yml earns its place: sidecar.spec bundles those files into the app
// and src/ocr/engine.py builds VietOCR's config from them, so editing `vocab` or
// `image_max_width` there changes OCR OUTPUT while leaving every .py untouched. The
// 151.8 MB .pth beside them is not in git (tools/fetch_vietocr_model.py pins its
// SHA256 instead), so there is nothing to diff for it here.
//
// The root-level test runner and `test_*.py` are NOT sidecar inputs: PyInstaller starts
// from sidecar.py and nothing in the bundle imports them. They match "*.py" all the
// same, so without the excludes editing a test demanded a ~30-minute rebuild of a
// binary that could not have changed. (`*` crosses `/` in a pathspec, but an exclude
// pattern with no leading directory is anchored at the repo root, so only the root-level
// test files are skipped.)
const SIDECAR_INPUTS =
  '"*.py" sidecar.spec "models/vietocr/*.yml" ":(exclude)test_*.py" ":(exclude)run_tests.py"';

if (process.env.SKIP_SIDECAR_CHECK === "1") {
  console.log("[sidecar-check] skipped (SKIP_SIDECAR_CHECK=1)");
  process.exit(0);
}

const root = path.resolve(__dirname, "..", "..");
const desktop = path.resolve(__dirname, "..");
const markerPath = path.join(root, "dist", "sidecar", "SIDECAR_BUILD.json");

function fail(msg) {
  console.error("\n[sidecar-check] " + msg);
  console.error("  Fix: cd desktop && npm run build:sidecar   (rebuilds + re-stamps the marker)");
  console.error("  Or, if you are SURE the Python source is unchanged: SKIP_SIDECAR_CHECK=1 npm run build\n");
  process.exit(1);
}

// Runtime dependencies that MUST be present in node_modules or electron-builder
// silently ships an installer missing them. electron-updater in particular was
// declared in package.json but absent from a stale node_modules once, so the
// packaged app's require("electron-updater") threw and auto-update reported
// "unsupported". Catch that here instead of in a user's hands.
const REQUIRED_DEPS = [
  "electron-updater",
  "pdf-lib",
  "@signpdf/signpdf",
  "@signpdf/placeholder-pdf-lib",
  "@signpdf/utils",
];
for (const dep of REQUIRED_DEPS) {
  if (!fs.existsSync(path.join(desktop, "node_modules", dep))) {
    console.error("\n[deps-check] Missing runtime dependency: " + dep);
    console.error("  It is in package.json but not installed — the packaged app would ship without it.");
    console.error("  Fix: cd desktop && pnpm install   (then rebuild)\n");
    process.exit(1);
  }
}

if (!fs.existsSync(path.join(root, "dist", "sidecar", "sidecar.exe"))) {
  fail("No sidecar binary in dist/sidecar — build it before packaging.");
}
if (!fs.existsSync(markerPath)) {
  fail("dist/sidecar has no SIDECAR_BUILD.json marker — built by an old/unknown process. Rebuild to be safe.");
}

const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
const builtCommit = marker.commit;

let head, changed, dirty;
try {
  head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  changed = execSync(`git diff --name-only ${builtCommit} HEAD -- ${SIDECAR_INPUTS}`, { cwd: root })
    .toString()
    .trim();
  dirty = execSync(`git status --porcelain -- ${SIDECAR_INPUTS}`, { cwd: root }).toString().trim();
} catch (e) {
  fail("git check failed (" + e.message + "). Cannot verify sidecar freshness.");
}

if (changed) {
  fail(
    `Python source changed since the sidecar was built (${builtCommit.slice(0, 8)} → ${head.slice(0, 8)}):\n` +
      changed.split("\n").map((f) => "    " + f).join("\n")
  );
}
if (dirty) {
  fail(
    `Uncommitted changes to sidecar inputs (${SIDECAR_INPUTS}) — the built sidecar ` +
      "does not include them:\n" + dirty
  );
}

console.log(`[sidecar-check] OK — sidecar built from ${builtCommit.slice(0, 8)} matches current source.`);

// --- signing helper (.NET) — same commit-based freshness guard ---------------
// Override (e.g. a renderer-only rebuild on a machine without the .NET SDK):
// SKIP_HELPER_CHECK=1.
if (process.env.SKIP_HELPER_CHECK === "1") {
  console.log("[helper-check] skipped (SKIP_HELPER_CHECK=1)");
} else {
  const helperExe = path.join(desktop, "dist-helper", "nabu-sign.exe");
  const helperMarker = path.join(desktop, "dist-helper", "HELPER_BUILD.json");
  const helperFail = (msg) => {
    console.error("\n[helper-check] " + msg);
    console.error("  Fix: cd desktop && npm run build:helper   (needs the .NET 8 SDK)");
    console.error("  Or, if the C# source is unchanged: SKIP_HELPER_CHECK=1 npm run build\n");
    process.exit(1);
  };
  if (!fs.existsSync(helperExe)) {
    helperFail("No signing helper in dist-helper/nabu-sign.exe — build it before packaging.");
  }
  if (!fs.existsSync(helperMarker)) {
    helperFail("dist-helper has no HELPER_BUILD.json marker — rebuild to be safe.");
  }
  const hBuilt = JSON.parse(fs.readFileSync(helperMarker, "utf8")).commit;
  let hChanged, hDirty;
  try {
    hChanged = execSync(`git diff --name-only ${hBuilt} HEAD -- desktop/signing-helper`, { cwd: root })
      .toString()
      .trim();
    hDirty = execSync("git status --porcelain -- desktop/signing-helper", { cwd: root }).toString().trim();
  } catch (e) {
    helperFail("git check failed (" + e.message + "). Cannot verify helper freshness.");
  }
  if (hChanged) {
    helperFail(
      `Helper C# source changed since it was built (${hBuilt.slice(0, 8)} → ${head.slice(0, 8)}):\n` +
        hChanged.split("\n").map((f) => "    " + f).join("\n")
    );
  }
  if (hDirty) {
    helperFail("Uncommitted changes under desktop/signing-helper — the built helper omits them:\n" + hDirty);
  }
  console.log(`[helper-check] OK — signing helper built from ${hBuilt.slice(0, 8)} matches current source.`);
}
