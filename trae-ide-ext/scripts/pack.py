#!/usr/bin/env python3
"""Build a minimal .vsix without npm/vsce.

VSIX is a plain ZIP with three special entries:
  [Content_Types].xml
  extension.vsixmanifest
  extension/<the extension files>

Usage:
  python3 scripts/pack.py [--out dist/agent-status-0.1.0.vsix]
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".xml" ContentType="text/xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"""

MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>Other</Categories>
    <Tags>agent,status,webgl,trae</Tags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"""

INCLUDE_DIRS = ("out", "lib", "media")
INCLUDE_FILES = ("package.json",)


def extension_files() -> list[Path]:
    files: list[Path] = []
    for name in INCLUDE_FILES:
        files.append(ROOT / name)
    for directory in INCLUDE_DIRS:
        base = ROOT / directory
        for path in sorted(base.rglob("*")):
            if path.is_file() and path.suffix not in {".map"}:
                files.append(path)
    return files


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    out = Path(args.out) if args.out else DIST / f"{package['name']}-{package['version']}.vsix"
    out.parent.mkdir(parents=True, exist_ok=True)

    manifest = MANIFEST.format(
        name=package["name"],
        version=package["version"],
        publisher=package["publisher"],
        display_name=package["displayName"],
        description=package["description"].replace("&", "&amp;").replace("<", "&lt;"),
    )

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("extension.vsixmanifest", manifest)
        for path in extension_files():
            archive.write(path, f"extension/{path.relative_to(ROOT).as_posix()}")

    size = out.stat().st_size
    print(f"built {out} ({size / 1024 / 1024:.1f} MiB, {len(extension_files())} files)")


if __name__ == "__main__":
    main()
