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

    mkdir -p "$out/pi-subagents"
    cp -r src "$out/pi-subagents/"
    cp package.json "$out/pi-subagents/"

    # Root entry point expected by pi at $out/pi-subagents/index.ts
    cat > "$out/pi-subagents/index.ts" <<'EOF'
export { default } from "./src/index.ts";
EOF

    # Copy runtime dependencies into $out/pi-subagents/node_modules.
    # Use cp -rL to dereference pnpm virtual-store symlinks so the result is
    # a self-contained directory that works from any location in the store.
    mkdir -p "$out/pi-subagents/node_modules"
    cp -rL node_modules/@sinclair "$out/pi-subagents/node_modules/@sinclair"

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
