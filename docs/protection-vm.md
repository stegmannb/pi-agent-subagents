# Offline protection test VM

`nix/protection-vm.nix` runs a prepared test tree in a disposable NixOS guest.
It uses `testers.runNixOSTest` from the repository's `flake.lock`. The current
Nixpkgs revision is `d233902339c02a9c334e7e593de68855ad26c4cb`; the factory adds
no unlocked imports. The exported `lib.mkProtectionVM` selects x86_64 Linux
packages from that lock.

## Factory interface

```nix
let
  pkgs = nixpkgs.legacyPackages.x86_64-linux;
  mkProtectionVM = import ./nix/protection-vm.nix {
    inherit pkgs;
    inherit (nixpkgs) lib;
  };
in
mkProtectionVM {
  name = "process-protections-vm";
  preparedBundle = preparedOfflineBundle;
  command = [ "node" "--test" "tests/process/protections-real.test.ts" ];
  runtimePackages = [ pkgs.pnpm_10 ];
  timeoutSeconds = 1200;
  memorySize = 4096;
  cores = 2;
}
```

The example's `preparedOfflineBundle` is a consumer-owned derivation, not an
input supplied by this factory. A flake consumer can instead call
`self.lib.mkProtectionVM` with the same attributes.

| Attribute | Contract |
| --- | --- |
| `name` | Required NixOS test name. |
| `preparedBundle` | Required directory derivation or Nix path. Paths are copied into the store. Mutable path strings are rejected. |
| `command` | Required nonempty list of string arguments, escaped individually. For shell syntax, explicitly pass `bash -euc` and a script. |
| `runtimePackages` | Additional packages, default `[]`. Use the same locked Linux package set. |
| `timeoutSeconds` | Boot, test and cleanup budget in seconds, default 1200, range 1–3600. The service also has this timeout. |
| `memorySize` | Guest RAM in MiB, default 4096. |
| `diskSize` | Writable guest disk in MiB, default 8192, separate from the read-only store image. Must fit the copied bundle and test output. |
| `cores` | Guest virtual CPUs, default 2. |

The guest already provides Node 22, Bash, Git, coreutils, GNU tar, gzip,
Bubblewrap, socat and ripgrep. The bundle owner must prepare and verify the
complete frozen dependency tree before boot, including Linux native addons
and any source archive provenance. No package installation runs in the guest.
The factory does not supply protection implementations or expected digests.

The service copies the immutable bundle to `/home/test/work`, preserves
symlinks, makes the copied files writable and runs the command there. Symlinks
into the Nix store remain immutable. Their referenced packages must be in the
bundle's Nix closure; links to host workspace paths cannot work in the guest.
Avoid preparation that relies on the original absolute build directory.

The test process runs as `test`, UID 1000, group `users`, without sudo or extra
groups. Its environment starts empty and receives only `HOME=/home/test`,
`USER=test`, `LOGNAME=test`, `LANG=C.UTF-8` and the declared package PATH.
Configuration should be part of the bundle or explicit command. Never put
credentials in either: Nix derivations and store paths are not secret storage.

## Isolation and failure behavior

QEMU uses software TCG even when KVM exists. Both the KVM requirement and the
conventional `nixos-test` builder scheduling feature are disabled, because this
test requires neither device access nor host user namespaces. Guest user
namespaces remain enabled so the ordinary guest user can run Bubblewrap.

The VM has no network adapters or test VLANs. `restrictNetwork` is enabled and
`forwardPorts` is empty. The test driver uses its local VM control channel.
There is no SSH service, host certificate import, shared directory, mounted
host Nix store, or host workspace. A read-only store image contains only the
guest system and referenced bundle closure. Guest loopback remains available
for local tests.

Boot failure, missing commands, unavailable Bubblewrap, nonzero test exit and
timeout all fail the derivation. No unsupported-capability result is accepted
as success. The NixOS driver owns the VM and cleans up its QEMU process and
temporary disks on completion or failure; its global timeout also bounds hung
boots. The test service uses a systemd control group to contain its children.

After all assertions pass and logs are saved, the driver calls its public
`machine.crash()` method. In the locked driver this sends `quit` to this VM's
QEMU monitor and waits for the QEMU process to exit. Guest OS shutdown is not
part of the protection test contract. The original `machine.shutdown()` path
intermittently stalled after successful assertions in both CI and a separate
Nix remote-builder run. The final guest-service cause was not established;
the change explicitly stops the disposable QEMU process instead. It does not
catch test failures, shorten a test timeout, or claim a successful graceful
guest shutdown. Failure paths still use the driver's cleanup and global timeout.
The exact API behavior is in the locked
[QEMU machine implementation](https://github.com/NixOS/nixpkgs/blob/d233902339c02a9c334e7e593de68855ad26c4cb/nixos/lib/test-driver/src/test_driver/machine/__init__.py#L1304-L1324).

Test stdout and stderr go to the guest system journal and serial console.
The driver writes `protection-test.log` and `protection-test-journal.log` into
the derivation output after a completed command, including a nonzero exit.
The Nix build log retains console output if the guest hangs or boot fails.
Successful outputs contain these two journal extracts; driver and serial
output remains in the streamed build log. Failed Nix outputs are not published
as successful store results.

## Smoke check and CI

On an x86_64 Linux Nix builder:

```sh
nix build --no-update-lock-file --print-build-logs \
  .#checks.x86_64-linux.protection-vm-smoke
```

The separate `.forgejo/workflows/protection-vm.yml` job has a 45-minute limit
for fetching/building and running the VM. Its VM execution limit is 20 minutes.
It uploads `test-results/protection-vm/`, including the streamed build log even
when the build fails. It uses the existing runner class and no private token.

`tests/vm/smoke.mjs` asserts Linux and UID 1000, starts a separate Node child
and checks the child's PID and parent PID. That child invokes the real
Bubblewrap executable without a setuid wrapper. A nested Node process writes
successfully to a writable bind mount and receives `EROFS` when trying to
overwrite a sentinel on a read-only mount. The same user first creates the
sentinel outside Bubblewrap, ruling out an ownership-based denial. The child
checks the persisted allowed write and unchanged sentinel afterward.

This smoke proves only the VM's ability to execute that scenario after an
actual successful Linux run. It does not qualify the process runner, Guard or
Sandbox integration. Consumers must pass their real offline protection suites
through the factory and require those checks independently. Nix evaluation
on macOS cannot establish a successful Linux boot or kernel enforcement.

The [NixOS VM testing introduction](https://nix.dev/tutorials/nixos/integration-testing-using-virtual-machines)
describes the underlying test driver. The factory's options were checked
against the exact locked Nixpkgs source, including
[`run.nix`](https://github.com/NixOS/nixpkgs/blob/d233902339c02a9c334e7e593de68855ad26c4cb/nixos/lib/testing/run.nix)
and [`qemu-vm.nix`](https://github.com/NixOS/nixpkgs/blob/d233902339c02a9c334e7e593de68855ad26c4cb/nixos/modules/virtualisation/qemu-vm.nix).
