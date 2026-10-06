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
    hash =
      if stdenv.hostPlatform.isDarwin then
        "sha256-8y5xqQHkwCUQVR86rFaAh0S9bmUWQSjAdsvJF1jpQ2g="
      else
        "sha256-Fupz6XqfABKdm2mNJ5qKD0YN5CQ5wqgybJoakvznNsY=";
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
