{ pkgs, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
    pnpm.enable = true;
  };

  packages = with pkgs; [
    git
  ];

  enterShell = ''
    echo "pi-agent-subagents devenv ready"
    echo "Use: pnpm install && pnpm run check"
  '';

  tasks = {
    "deps:install" = {
      description = "Install the locked pnpm dependencies.";
      exec = "pnpm install --frozen-lockfile";
    };

    "check:fmt" = {
      description = "Check source and test formatting.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run ci:fmt";
    };

    "check:lint" = {
      description = "Lint source and tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run ci:lint";
    };

    "check:types" = {
      description = "Type-check source and tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run ci:check";
    };

    "test:unit" = {
      description = "Run the unit and worktree tests.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm test";
      showOutput = true;
    };

    "test:snapshots" = {
      description = "Run real Git snapshot and integration tests.";
      after = [ "deps:install" ];
      exec = "pnpm run test:snapshots";
      showOutput = true;
    };

    "test:tui" = {
      description = "Run the real pi TUI test suite.";
      after = [ "deps:install" ];
      before = [ "devenv:enterTest" ];
      exec = "pnpm run test:tui";
      showOutput = true;
    };

    "test:tui:repeat" = {
      description = "Run three full TUI suites to check timing stability.";
      after = [ "deps:install" ];
      exec = "pnpm run test:tui:repeat";
      showOutput = true;
    };
  };
}
