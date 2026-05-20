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
    src = lib.cleanSource ../.;
    filter =
      path: _type:
      !(lib.hasInfix "/node_modules/" path) && !(lib.hasSuffix "/node_modules" path);
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 2;
    hash = "sha256-StHQW2O2OoiOpWwfsxzZw78GtkPJkiu43O1OLp4uGUA=";
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

    mkdir -p "$out"
    cp -r src "$out/"
    cp package.json "$out/"

    # Copy runtime dependencies into $out/node_modules.
    # Use cp -rL to dereference pnpm virtual-store symlinks so the result is
    # a self-contained directory that works from any location in the store.
    mkdir -p "$out/node_modules"
    cp -rL node_modules/@sinclair "$out/node_modules/@sinclair"

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
