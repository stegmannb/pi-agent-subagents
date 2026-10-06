{
  stdenv,
  lib,
  nodejs,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenv.mkDerivation (finalAttrs: {
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

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 3;
    # Fetcher v3 uses this timestamp in its tarball; keep it independent of
    # the source commit so unchanged dependencies retain their fixed hash.
    SOURCE_DATE_EPOCH = 1;
    hash =
      if stdenv.hostPlatform.isDarwin then
        "sha256-wq+dPxN9GKpsKkUvP7pi6TFGPAi6ekypqWFKZa3s4Jw="
      else
        "sha256-4ykMQgFB7faRL9wOb1AxYX+DYvRdAbmsnlpYbWv2fu4=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
  ];

  prePnpmInstall = ''
    pnpmInstallFlags+=(--prod)
  '';

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
})
