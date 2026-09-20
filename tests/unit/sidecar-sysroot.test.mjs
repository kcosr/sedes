import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const run = promisify(execFile);
const helper = path.resolve("scripts/prepare-sidecar-rocky8-sysroot.py");
const setup = `
import importlib.util, io, json, pathlib, sys, tarfile, tempfile
spec = importlib.util.spec_from_file_location('sysroot', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def rejects(function, message):
    try: function()
    except ValueError as error:
        assert str(error) == message, str(error)
    else: raise AssertionError('expected rejection: ' + message)
`;

describe.skipIf(process.platform !== "linux")(
  "locked Rocky sysroot preparation",
  () => {
    it("extracts ordinary payloads and rejects parent traversal or escaping links", async () => {
      await run("python3", [
        "-B",
        "-c",
        setup +
          `
with tempfile.TemporaryDirectory() as temporary:
    base = pathlib.Path(temporary)
    root = base / 'root'; root.mkdir()
    archive = base / 'fixture.tar'
    with tarfile.open(archive, 'w') as output:
        entry = tarfile.TarInfo('usr/include/features.h'); entry.size = 6
        output.addfile(entry, io.BytesIO(b'header'))
    module.extract_payload(archive, root)
    assert (root / 'usr/include/features.h').read_bytes() == b'header'
    with tarfile.open(archive, 'w') as output:
        entry = tarfile.TarInfo('../escaped'); entry.size = 1
        output.addfile(entry, io.BytesIO(b'x'))
    rejects(lambda: module.extract_payload(archive, root), 'sidecar_sysroot_archive_path_invalid')
    assert not (base / 'escaped').exists()
    with tarfile.open(archive, 'w') as output:
        entry = tarfile.TarInfo('usr/include/escape'); entry.type = tarfile.SYMTYPE; entry.linkname = '../../../../outside'
        output.addfile(entry)
    rejects(lambda: module.extract_payload(archive, root), 'sidecar_sysroot_archive_link_escape')
`,
        helper,
      ]);
    });

    it("rejects non-official URLs and modified package bytes", async () => {
      await run("python3", [
        "-B",
        "-c",
        setup +
          `
rejects(lambda: module.checked_url('https://example.com/package.rpm'), 'sidecar_sysroot_url_invalid')
rejects(lambda: module.checked_url(module.ORIGIN + '../other.rpm'), 'sidecar_sysroot_url_invalid')
class Response:
    url = module.ORIGIN + 'fixture.rpm'
    stdout = b'changed'
module.subprocess.run = lambda *args, **kwargs: Response()
rejects(lambda: module.download(Response.url, 'a' * 64), 'sidecar_sysroot_checksum_mismatch')
`,
        helper,
      ]);
    });

    it("publishes no sysroot and cleans staging after an invalid downloaded archive", async () => {
      await run("python3", [
        "-B",
        "-c",
        setup +
          `
lock = {'schemaVersion': 1, 'architecture': 'x64', 'distribution': 'rocky8', 'packages': [
    {'name': name, 'url': module.ORIGIN + name + '.x86_64.rpm', 'sha256': 'a' * 64}
    for name in module.PACKAGES]}
module.download = lambda *args: (b'invalid archive', 'a' * 64)
with tempfile.TemporaryDirectory() as temporary:
    output = pathlib.Path(temporary) / 'sysroot'
    rejects(lambda: module.materialize(lock, output), 'sidecar_sysroot_archive_open_failed')
    assert not output.exists()
    assert list(pathlib.Path(temporary).iterdir()) == []
`,
        helper,
      ]);
    });
  },
);
