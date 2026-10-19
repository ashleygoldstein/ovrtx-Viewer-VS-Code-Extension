"""Check the source release and optional VSIX against an explicit file allowlist."""
import argparse
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = {
    'package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'extension.js',
    'session.js', 'panel.css', 'runtime/camera.py', 'runtime/launch.py',
    'runtime/prepare.py', 'runtime/renderer.py', 'runtime/server.py',
    'runtime/web/index.html', 'runtime/web/viewer.css', 'runtime/web/viewer.js',
}
SOURCE = PACKAGE | {
    '.gitignore', '.gitattributes', '.vscodeignore', '.vscode/launch.json',
    'test/extension.test.js', 'test/session.test.js', 'test/viewer-lifecycle.test.js',
    'test/browser.cjs', 'test/test_runtime.py', 'test/test_launch.py',
    'test/test_cleanup.py', 'test/audit_release.py', 'test/gpu_soak.py',
}
PATTERNS = {
    'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'GitHub token': r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b',
    'cloud access key': r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'credential URL': r'https?://[^\s/]+:[^\s/@]+@',
    'private home path': r'(?:[A-Za-z]:[/\\]Users[/\\]|/home/|/Users/)[A-Za-z0-9_.-]+',
    'internal URL': r'https?://[^\s/]*(?:nvidia\.(?:com|net)|nvcorp\.nvidia\.com)/',
    'legacy branding': r'digital[- ]twin|factory[- ]line|berlin[- ]digital',
    'restricted source marker': r'(?i:confiden[t]ial|trade[ ]secret|NVIDIA[ ]INTERNAL|DO[ ]NOT[ ]DISTRIBUTE)',
}


def inspect_text(name, data, errors):
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        errors.append(f'{name}: unexpected binary content')
        return
    for label, pattern in PATTERNS.items():
        if re.search(pattern, text):
            errors.append(f'{name}: {label} match (inspect locally; contents redacted)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vsix', type=Path)
    args = parser.parse_args()
    errors, checked = [], 0
    for file in ROOT.rglob('*'):
        relative = file.relative_to(ROOT)
        if any(part in ('.git', 'qa', 'node_modules', '__pycache__', '.venv') for part in relative.parts):
            continue
        info = file.lstat()
        if file.is_symlink() or getattr(info, 'st_reparse_tag', 0) in (0xA0000003, 0xA000000C):
            errors.append(f'{relative}: symlink or junction')
            continue
        if file.is_dir():
            continue
        if info.st_nlink != 1:
            errors.append(f'{relative}: hardlink count {info.st_nlink}')
        if file.suffix == '.vsix':
            continue
        name = relative.as_posix()
        if name not in SOURCE:
            errors.append(f'{name}: not on source allowlist')
        inspect_text(name, file.read_bytes(), errors)
        checked += 1
    if args.vsix:
        with zipfile.ZipFile(args.vsix) as archive:
            expected = {'extension/' + (item.lower() if item == 'README.md' else item) for item in PACKAGE} | {'[Content_Types].xml', 'extension.vsixmanifest'}
            names = archive.namelist()
            if len(names) != len(set(names)):
                errors.append('VSIX contains duplicate paths')
            if set(names) != expected:
                errors.append(f'VSIX allowlist mismatch: {sorted(set(names) ^ expected)}')
            for entry in archive.infolist():
                if stat.S_ISLNK(entry.external_attr >> 16):
                    errors.append(f'{entry.filename}: archived symlink')
                inspect_text(entry.filename, archive.read(entry), errors)
    for error in errors:
        print(error)
    if errors:
        raise SystemExit(f'FAILED: {len(errors)} findings')
    print(f'PASS: {checked} source files; no detected secrets, private paths, restricted markers, or filesystem links.'
          + (' VSIX contents match the allowlist.' if args.vsix else ''))
    print('Pattern checks do not establish ownership, licensing permission, or the absence of all secrets.')


if __name__ == '__main__':
    main()
