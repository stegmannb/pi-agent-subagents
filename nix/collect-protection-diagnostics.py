"""Export diagnostics over the existing control channel before VM cleanup.

Only test-owned guest data is read. Failed assertions retain their exception;
the compressed artifact also travels in the failure build log because Nix
cannot publish a failed derivation output.
"""
import base64
import hashlib
import io
import json
import shlex
import subprocess
import tarfile
from pathlib import Path


def collect(machine, output, node, systemd, gdb, zstd, failed):
    output = Path(output)
    target = output / "diagnostics"
    target.mkdir()
    observations = []

    def execute(command):
        status, text = machine.execute(command, timeout=30)
        observations.append({"command": command, "exit_code": status})
        return status, text

    # Stop the driver observer through its own marker, without signalling any PID.
    execute("touch /root/pasa-diagnostics/stop")
    execute("timeout 5 bash -c 'until test -e /root/pasa-diagnostics/stopped; do sleep 0.1; done'")
    status, _ = execute("mkdir -p /root/pasa-diagnostics/cores")
    if status:
        raise RuntimeError("core diagnostic directory unavailable")
    # Let normal systemd core storage finish; do not change limits or core policy.
    status, _ = execute("timeout 30 bash -c 'while test -n \"$(systemctl list-units "
                        "--type=service --state=running --no-legend \"systemd-coredump@*\")\"; "
                        "do sleep 0.2; done'")
    if status:
        raise RuntimeError("normal core storage did not finish before artifact export")
    for name, command in [
        ("guest-journal.jsonl", "journalctl --no-pager -o json"),
        ("core-journal.jsonl", "journalctl -t systemd-coredump --no-pager -o json"),
        ("core-info.txt", shlex.quote(systemd + "/bin/coredumpctl") + " --no-pager info"),
    ]:
        _, text = execute(command)
        (target / name).write_text(text)
    # Normal systemd core storage is retained as-is, including compression.
    status, _ = execute("for core in /var/lib/systemd/coredump/core.node.*; do "
                        "test ! -f \"$core\" || cp -- \"$core\" /root/pasa-diagnostics/cores/ || exit; done")
    if status:
        raise RuntimeError("stored core diagnostic copy failed")
    status, _ = execute("find /tmp -maxdepth 1 -type d -name 'pasa-nested-*' -printf '%f\\0' | "
                        "tar -C /tmp --null -T - -czf /root/pasa-diagnostics/fixtures.tar.gz")
    if status:
        raise RuntimeError("fixture diagnostic export failed")
    execute("cp /root/pasa-observer.log /root/pasa-diagnostics/observer.log")
    status, _ = execute("tar -C /root/pasa-diagnostics -cf /root/pasa-diagnostics.tar .")
    if status:
        raise RuntimeError("guest diagnostic archive failed")
    status, encoded = execute("base64 -w0 /root/pasa-diagnostics.tar")
    if status:
        raise RuntimeError("guest diagnostic transfer failed")
    guest_bytes = base64.b64decode(encoded, validate=True)
    (target / "guest.tar").write_bytes(guest_bytes)
    cores = []
    # No shared directory or network is added. Only core regular files are read
    # from the archive; guest paths and permissions are never applied on the host.
    with tarfile.open(fileobj=io.BytesIO(guest_bytes)) as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith("./cores/core.node."):
                continue
            compressed = target / Path(member.name).name
            compressed.write_bytes(archive.extractfile(member).read())
            raw = target / (compressed.name + ".raw")
            record = {"file": member.name, "sha256": hashlib.sha256(compressed.read_bytes()).hexdigest()}
            try:
                if compressed.suffix == ".zst":
                    with raw.open("wb") as stream:
                        subprocess.run([zstd, "-d", "-c", str(compressed)], stdout=stream,
                                       stderr=subprocess.PIPE, timeout=30, check=True)
                else:
                    raw.write_bytes(compressed.read_bytes())
                with (target / (compressed.name + ".gdb.txt")).open("wb") as stream:
                    result = subprocess.run([gdb, "--nx", "--batch", "-iex", "set auto-load off",
                                             "-ex", "info registers", "-ex", "p $_siginfo",
                                             "-ex", "info proc mappings", "-ex", "thread apply all bt",
                                             node, str(raw)], stdout=stream, stderr=subprocess.STDOUT,
                                            timeout=30)
                record["gdb_exit_code"] = result.returncode
            except Exception as error:
                record["analysis_error"] = str(error)
            finally:
                raw.unlink(missing_ok=True)
                compressed.unlink()
            cores.append(record)
    (target / "collection.json").write_text(json.dumps({"failed": failed, "cores": cores,
                                                        "observations": observations}, indent=2) + "\n")
    artifact = output / "diagnostics.tar.gz"
    with tarfile.open(artifact, "w:gz") as archive:
        archive.add(target, arcname="diagnostics")
    data = artifact.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    print(f"PASA_DIAGNOSTIC_ARCHIVE bytes={len(data)} sha256={digest}", flush=True)
    if failed:
        # Numbered bounded lines allow recovery even after failed Nix output cleanup.
        chunks = [data[offset:offset + 3072] for offset in range(0, len(data), 3072)]
        for index, chunk in enumerate(chunks):
            print(f"PASA_DIAGNOSTIC_DATA {index}/{len(chunks)} {base64.b64encode(chunk).decode()}", flush=True)
        print("PASA_DIAGNOSTIC_END " + digest, flush=True)
