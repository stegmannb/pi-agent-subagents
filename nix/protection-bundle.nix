# Offline input for the isolated Linux protection qualification VM.
{ pkgs }:
let
  inherit (pkgs) lib;
  nodejs = pkgs.nodejs_22;
  pnpm = pkgs.pnpm_10;
  manifest = builtins.fromJSON (builtins.readFile ../tests/process/protection-sources.json);
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../tests
      ../patches
      ../index.ts
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../.npmrc
    ];
  };
  archiveSource =
    name:
    pkgs.runCommand "pasa-${name}-${manifest.${name}.revision}-source"
      {
        nativeBuildInputs = [ pkgs.gnutar ];
      }
      ''
        mkdir -p "$out"
        tar --no-same-owner -xf ${../tests/process}/${manifest.${name}.archive} -C "$out"
      '';
  dependencyStores = {
    runner = pkgs.fetchPnpmDeps {
      pname = "pasa-runner-test";
      src = source;
      inherit pnpm;
      fetcherVersion = 3;
      hash = "sha256-m9MM3VTpeYAeRZRT7k3buCxOBLPdETmR8oq/FTha/U0=";
    };
    guard = pkgs.fetchPnpmDeps {
      pname = "pasa-guard-test";
      src = archiveSource "guard";
      inherit pnpm;
      fetcherVersion = 3;
      pnpmInstallFlags = [ "--prod" ];
      hash = "sha256-uDrzMNJts0gXErT5gq1J5Ap+aOjlm2Zp3HdJJ7pGSwc=";
    };
    sandbox = pkgs.fetchPnpmDeps {
      pname = "pasa-sandbox-test";
      src = archiveSource "sandbox";
      inherit pnpm;
      fetcherVersion = 3;
      pnpmInstallFlags = [ "--prod" ];
      hash = "sha256-NfeQ8EZSU4P5v3pULB78ygU8pVgL/B0uHGKKx0KWSpI=";
    };
  };
  bundle =
    pkgs.runCommand "pasa-protection-test-bundle"
      {
        nativeBuildInputs = [
          nodejs
          pnpm
          pkgs.git
          pkgs.gnutar
          pkgs.zstd
        ];
      }
      ''
        export HOME="$TMPDIR/home"
        mkdir -p "$HOME" "$out/repo" "$TMPDIR/offline-stores" "$TMPDIR/runner-store"
        cp -R ${source}/. "$out/repo/"
        chmod -R u+w "$out/repo"
        ln -s ${dependencyStores.guard} "$TMPDIR/offline-stores/guard"
        ln -s ${dependencyStores.sandbox} "$TMPDIR/offline-stores/sandbox"
        tar --zstd -xf ${dependencyStores.runner}/pnpm-store.tar.zst -C "$TMPDIR/runner-store"
        chmod -R u+w "$TMPDIR/runner-store"
        cd "$out/repo"
        pnpm --config.manage-package-manager-versions=false install --offline --frozen-lockfile --ignore-scripts --store-dir "$TMPDIR/runner-store"
        PASA_PROTECTION_OFFLINE_STORES="$TMPDIR/offline-stores" node tests/process/protection-sources.ts
        node tests/process/record-bundle.ts
        PASA_PROTECTION_PREPARED=1 node tests/process/protection-sources.ts
      '';
  # The VM factory accepts a derivation, not a store-path string with a suffix.
  preparedBundle = pkgs.runCommand "pasa-protection-prepared-tree" { } ''
    ln -s ${bundle}/repo "$out"
  '';
in
{
  inherit bundle preparedBundle dependencyStores;
}
