{
  stdenv,
  lib,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
  # pi supplies its host packages (pi-ai, pi-coding-agent, pi-tui, typebox) to
  # extensions at runtime through its virtual module map, so the extension must
  # not bundle them. Anything left in `dependencies` or `optionalDependencies`
  # would be a genuine runtime dependency that this build does not install.
  runtimeDependencies = lib.unique (
    lib.attrNames (packageJson.dependencies or { })
    ++ lib.attrNames (packageJson.optionalDependencies or { })
  );
in
assert lib.assertMsg (runtimeDependencies == [ ]) ''
  pi-agent-subagents declares runtime dependencies: ${lib.concatStringsSep ", " runtimeDependencies}.
  This package intentionally ships no bundled node_modules; every runtime import must be
  provided by pi as a host module or be a Node builtin. If a real runtime dependency is
  needed, restore the pnpm/fetchPnpmDeps install in nix/package.nix (see git history) and
  make sure the channel is deterministic again.
'';
stdenv.mkDerivation {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      lib.cleanSourceFilter path type
      && !(type == "directory" && builtins.elem (builtins.baseNameOf path) [
        ".devenv"
        ".direnv"
        "node_modules"
        "test-results"
      ]);
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/subagents"
    cp -r . "$out/subagents/"

    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    maintainers = [ ];
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
