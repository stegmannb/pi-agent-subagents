{
  stdenv,
  lib,
  nodejs,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  jq,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenv.mkDerivation (finalAttrs: {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.cleanSource ../.;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 3;
    hash = "sha256-yoatSMuVrU+VuvIzL+3JvXCyUeyAqI2x1VBfXXMiuWo=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    jq
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

  postInstall = ''
    mkdir -p "$out/subagents"
    echo 'export { default } from "../src/index.ts";' > "$out/subagents/index.ts"

    tmp=$(mktemp)
    jq '.pi.extensions = ["./subagents/index.ts"]' "$out/package.json" > "$tmp"
    mv "$tmp" "$out/package.json"
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    maintainers = [ ];
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
