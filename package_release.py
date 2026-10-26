"""Build reproducible public archives using a reviewed, explicit file allowlist."""
import hashlib
import json
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent

def digest(data):
    return hashlib.sha256(data).hexdigest()

def archive(path, contents):
    with ZipFile(path, 'x', compression=ZIP_DEFLATED, compresslevel=9) as z:
        for name, data in sorted(contents.items()):
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    with ZipFile(path) as z:
        if z.testzip() is not None:
            raise RuntimeError('Archive integrity check failed')
        if set(z.namelist()) != set(contents):
            raise RuntimeError('Archive file list mismatch')
        for name, data in contents.items():
            if digest(z.read(name)) != digest(data):
                raise RuntimeError('Archive hash mismatch: ' + name)

def main():
    version = json.loads((ROOT / 'edge-extension/manifest.json').read_text(encoding='utf-8'))['version']
    if sys.argv[1:] != [version]:
        raise SystemExit('Pass the current version explicitly: python package_release.py ' + version)
    names = json.loads((ROOT / 'PUBLIC_FILES.json').read_text(encoding='utf-8'))
    if len(names) != len(set(names)):
        raise SystemExit('Duplicate public paths')
    contents = {}
    for name in names:
        candidate = ROOT / name
        if not isinstance(name, str) or '\\' in name or Path(name).is_absolute() or '..' in Path(name).parts:
            raise SystemExit('Unsafe public path')
        if candidate.is_symlink() or not candidate.is_file() or not candidate.resolve().is_relative_to(ROOT):
            raise SystemExit('Missing or unsafe public file: ' + name)
        contents[name] = candidate.read_bytes()
    extension_names = {p.relative_to(ROOT).as_posix() for p in (ROOT / 'edge-extension').rglob('*') if p.is_file()}
    if extension_names != {n for n in names if n.startswith('edge-extension/')}:
        raise SystemExit('Public allowlist does not match complete extension source')
    out = ROOT / 'dist'
    out.mkdir(exist_ok=True)
    install_path = out / ('shiye-' + version + '-extension.zip')
    source_path = out / ('shiye-' + version + '-source.zip')
    checksum_path = out / 'SHA256SUMS.txt'
    if any(p.exists() for p in (install_path, source_path, checksum_path)):
        raise SystemExit('Release files already exist; use a fresh checkout/output directory')
    hashes = {name: digest(data) for name, data in sorted(contents.items())}
    source_files = dict(contents)
    source_files['SOURCE_SHA256.json'] = (json.dumps(hashes, indent=2) + '\n').encode('utf-8')
    install_files = {name.removeprefix('edge-extension/'): data for name, data in contents.items() if name.startswith('edge-extension/')}
    install_files['LICENSE'] = contents['LICENSE']
    archive(install_path, install_files)
    archive(source_path, source_files)
    checksum_path.write_text(''.join(digest(p.read_bytes()) + '  ' + p.name + '\n' for p in (install_path, source_path)), encoding='utf-8')
    print(json.dumps({'version': version, 'public_files': len(contents), 'extension_files': len(extension_names), 'artifacts': [p.name for p in (install_path, source_path, checksum_path)]}))

if __name__ == '__main__':
    main()
