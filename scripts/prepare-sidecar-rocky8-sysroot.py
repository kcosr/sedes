"""Resolve reviewed Rocky 8 RPMs once, then materialize only that locked input.

Requires Python 3 and system libarchive. Does not invoke rpm/dnf installation
scripts, a shell, a container, or privileged filesystem operations.
"""

import argparse
import ctypes
import ctypes.util
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET

ORIGIN = "https://download.rockylinux.org/pub/rocky/8/"
PACKAGES = frozenset(("filesystem", "glibc", "glibc-devel", "glibc-headers", "kernel-headers",
                      "libstdc++", "libstdc++-devel", "libgcc", "gcc"))
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def checked_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (not url.startswith(ORIGIN) or parsed.query or parsed.fragment or
            ".." in parsed.path.split("/") or "%" in parsed.path):
        raise ValueError("sidecar_sysroot_url_invalid")
    return url


def download(url, digest=None):
    # Use the platform TLS trust configuration without changing verification
    # flags. Do not follow redirects outside the pinned repository authority.
    result = subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--proto", "=https",
        "--max-time", "60", "--max-filesize", "134217728", checked_url(url),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    contents = result.stdout
    if len(contents) > 128 * 1024 * 1024:
        raise ValueError("sidecar_sysroot_download_too_large")
    actual = hashlib.sha256(contents).hexdigest()
    if digest is not None and actual != digest:
        raise ValueError("sidecar_sysroot_checksum_mismatch")
    return contents, actual


def resolve_lock():
    packages = {}
    repositories = []
    namespace = {"repo": "http://linux.duke.edu/metadata/repo"}
    common = "{http://linux.duke.edu/metadata/common}"
    for repository in ("BaseOS", "AppStream"):
        base = ORIGIN + repository + "/x86_64/os/"
        repomd_url = base + "repodata/repomd.xml"
        repomd, repomd_sha = download(repomd_url)
        entry = ET.fromstring(repomd).find("repo:data[@type='primary']", namespace)
        checksum = entry.find("repo:checksum", namespace)
        if checksum.attrib["type"] != "sha256":
            raise ValueError("sidecar_sysroot_checksum_type_invalid")
        primary_url = urllib.parse.urljoin(base, entry.find("repo:location", namespace).attrib["href"])
        primary, primary_sha = download(primary_url, checksum.text)
        if not primary_url.endswith(".xml.gz"):
            raise ValueError("sidecar_sysroot_metadata_format_unsupported")
        repositories.append({"url": repomd_url, "sha256": repomd_sha,
                             "primaryUrl": primary_url, "primarySha256": primary_sha})
        for package in ET.fromstring(gzip.decompress(primary)):
            name = package.findtext(common + "name")
            if name not in PACKAGES or package.findtext(common + "arch") != "x86_64":
                continue
            checksum = package.find(common + "checksum")
            if checksum.attrib["type"] != "sha256":
                raise ValueError("sidecar_sysroot_checksum_type_invalid")
            version = package.find(common + "version").attrib
            build = int(package.find(common + "time").attrib["build"])
            candidate = {"name": name, "epoch": version["epoch"], "version": version["ver"],
                         "release": version["rel"], "sha256": checksum.text,
                         "url": urllib.parse.urljoin(base, package.find(common + "location").attrib["href"])}
            if name not in packages or build > packages[name][0]:
                packages[name] = (build, candidate)
    if set(packages) != PACKAGES:
        raise ValueError("sidecar_sysroot_packages_missing")
    # A repository mid-publication must not yield mismatched compiler/runtime
    # or libc header versions. Retry resolution after its update is complete.
    for family in (("glibc", "glibc-devel", "glibc-headers"),
                   ("gcc", "libgcc", "libstdc++", "libstdc++-devel")):
        versions = {(packages[name][1]["epoch"], packages[name][1]["version"],
                     packages[name][1]["release"]) for name in family}
        if len(versions) != 1:
            raise ValueError("sidecar_sysroot_package_versions_mismatch")
    result = {"schemaVersion": 1, "architecture": "x64", "distribution": "rocky8",
              "repositories": repositories, "packages": [packages[name][1] for name in sorted(packages)]}
    validate_lock(result)
    return result


def validate_lock(lock):
    if (lock.get("schemaVersion") != 1 or lock.get("architecture") != "x64" or
            lock.get("distribution") != "rocky8"):
        raise ValueError("sidecar_sysroot_lock_invalid")
    packages = lock.get("packages", [])
    if len(packages) != len(PACKAGES) or {p.get("name") for p in packages} != PACKAGES:
        raise ValueError("sidecar_sysroot_lock_packages_invalid")
    for package in packages:
        checked_url(package["url"])
        if not SHA256.fullmatch(package.get("sha256", "")) or not package["url"].endswith(".x86_64.rpm"):
            raise ValueError("sidecar_sysroot_lock_package_invalid")


def checked_relative(filename):
    path = PurePosixPath(filename)
    if path.is_absolute() or ".." in path.parts or "\x00" in filename or not path.parts:
        raise ValueError("sidecar_sysroot_archive_path_invalid")
    return Path(*path.parts)


def within(root, filename):
    candidate = root / checked_relative(filename)
    if not candidate.resolve().is_relative_to(root):
        raise ValueError("sidecar_sysroot_archive_escape")
    return candidate


def extract_payload(archive_path, root):
    library = ctypes.util.find_library("archive")
    if not library:
        raise RuntimeError("sidecar_sysroot_libarchive_missing")
    lib = ctypes.CDLL(library)
    signatures = {
        "archive_read_new": (ctypes.c_void_p, []),
        "archive_read_support_filter_all": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_support_format_all": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_open_filename": (ctypes.c_int, [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]),
        "archive_read_next_header": (ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]),
        "archive_entry_pathname": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_entry_symlink": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_entry_hardlink": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_entry_mode": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_data": (ctypes.c_ssize_t, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]),
        "archive_read_free": (ctypes.c_int, [ctypes.c_void_p]),
    }
    for name, (result, arguments) in signatures.items():
        function = getattr(lib, name)
        function.restype = result
        function.argtypes = arguments
    reader = lib.archive_read_new()
    hardlinks = []
    try:
        lib.archive_read_support_filter_all(reader)
        lib.archive_read_support_format_all(reader)
        if lib.archive_read_open_filename(reader, os.fsencode(archive_path), 65536) != 0:
            raise ValueError("sidecar_sysroot_archive_open_failed")
        entry = ctypes.c_void_p()
        while True:
            status = lib.archive_read_next_header(reader, ctypes.byref(entry))
            if status == 1:
                break
            if status != 0:
                raise ValueError("sidecar_sysroot_archive_read_failed")
            filename = os.fsdecode(lib.archive_entry_pathname(entry))
            mode = lib.archive_entry_mode(entry)
            if filename in (".", "./", "/") and stat.S_ISDIR(mode):
                continue
            destination = within(root, filename)
            relative = checked_relative(filename).as_posix()
            if not (relative in ("usr", "usr/lib", "usr/include", "usr/lib64", "usr/lib/gcc", "lib64") or
                    relative.startswith(("usr/include/", "usr/lib64/", "usr/lib/gcc/", "lib64/"))):
                continue
            symlink = lib.archive_entry_symlink(entry)
            hardlink = lib.archive_entry_hardlink(entry)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if hardlink:
                hardlinks.append((destination, within(root, os.fsdecode(hardlink))))
            elif stat.S_ISDIR(mode):
                destination.mkdir(exist_ok=True)
            elif stat.S_ISLNK(mode):
                target = os.fsdecode(symlink)
                # Absolute RPM links name paths in the target root, not this
                # host. Rebase them to relative links before creating them.
                target_path = root / target.lstrip("/") if target.startswith("/") else destination.parent / target
                if not target_path.resolve().is_relative_to(root):
                    raise ValueError("sidecar_sysroot_archive_link_escape")
                relative = os.path.relpath(target_path, destination.parent)
                if destination.is_symlink() and os.readlink(destination) == relative:
                    continue
                destination.symlink_to(relative)
            elif stat.S_ISREG(mode):
                if destination.is_symlink() or (destination.exists() and not destination.is_file()):
                    raise ValueError("sidecar_sysroot_archive_file_collision")
                chunks = []
                total = 0
                buffer = ctypes.create_string_buffer(65536)
                while True:
                    count = lib.archive_read_data(reader, buffer, len(buffer))
                    if count == 0:
                        break
                    if count < 0:
                        raise ValueError("sidecar_sysroot_archive_payload_invalid")
                    total += count
                    if total > 64 * 1024 * 1024:
                        raise ValueError("sidecar_sysroot_archive_file_too_large")
                    chunks.append(buffer.raw[:count])
                contents = b"".join(chunks)
                if destination.exists():
                    if destination.read_bytes() != contents:
                        raise ValueError("sidecar_sysroot_archive_file_collision")
                    continue
                with destination.open("xb") as output:
                    output.write(contents)
                destination.chmod(mode & 0o777)
            else:
                raise ValueError("sidecar_sysroot_archive_entry_unsupported")
        for destination, source in hardlinks:
            if not source.is_file() or source.is_symlink():
                raise ValueError("sidecar_sysroot_archive_hardlink_invalid")
            os.link(source, destination)
    finally:
        lib.archive_read_free(reader)


def materialize(lock, output):
    validate_lock(lock)
    output = Path(output).absolute()
    if output.exists():
        raise ValueError("sidecar_sysroot_output_exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".sedes-sysroot-", dir=output.parent))
    try:
        root = staging / "root"
        root.mkdir(mode=0o700)
        for package in lock["packages"]:
            contents, _ = download(package["url"], package["sha256"])
            filename = staging / (package["name"] + ".rpm")
            filename.write_bytes(contents)
            extract_payload(filename, root)
            filename.unlink()
        (root / ".sedes-sysroot-lock.json").write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
        root.rename(output)
    finally:
        shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolve", action="store_true", help="Write a new exact RPM lock; review before materializing")
    parser.add_argument("--lock", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    lock_path = Path(args.lock)
    if args.resolve:
        if args.output:
            parser.error("Resolution and materialization are separate operations")
        with lock_path.open("x") as output:
            try:
                output.write(json.dumps(resolve_lock(), indent=2, sort_keys=True) + "\n")
            except BaseException:
                lock_path.unlink()
                raise
    else:
        if not args.output:
            parser.error("--output is required when materializing a lock")
        materialize(json.loads(lock_path.read_text()), args.output)


if __name__ == "__main__":
    main()
