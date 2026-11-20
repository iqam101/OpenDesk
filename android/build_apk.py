"""Build dist/OpenDesk.apk without Gradle.

Needs: a JDK (17 works) on PATH or in JAVA_HOME, the Android SDK (build-tools + one platform;
found through ANDROID_HOME or %LOCALAPPDATA%/Android/Sdk) and Pillow for the launcher icons.

    python android/build_apk.py
    python android/build_apk.py --stage-only   # only assemble android/build/assets (to test the UI in a browser)
"""
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BUILD = HERE / "build"
OUT = ROOT / "dist" / "OpenDesk.apk"
KEYSTORE = HERE / "opendesk.keystore"  # created on the first build; keep it to be able to install updates
KS_PASS = "android"
MIN_SDK, TARGET_SDK = "24", "34"
VERSION_CODE, VERSION_NAME = "1", "2.0.0"


def run(*cmd):
    cmd = [str(c) for c in cmd]
    print(">", " ".join(cmd[:3]), "..." if len(cmd) > 3 else "")
    subprocess.run(cmd, check=True)


def newest(folder):
    def key(p):
        return [int(x) for x in re.findall(r"\d+", p.name)]
    items = sorted((p for p in folder.iterdir() if p.is_dir()), key=key)
    if not items:
        sys.exit(f"Nothing installed in {folder}")
    return items[-1]


def stage_web():
    """assets/web = the desktop UI (public/) + the mobile layer, with index.html loading both."""
    web = BUILD / "assets" / "web"
    shutil.copytree(ROOT / "public", web)
    for f in (HERE / "web").iterdir():
        shutil.copy(f, web / f.name)
    page = (web / "index.html").read_text(encoding="utf-8")
    for old, new in (
        ('content="width=device-width, initial-scale=1.0"',
         'content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"'),
        ('<link rel="stylesheet" href="/static/style.css">',
         '<link rel="stylesheet" href="/static/style.css">\n  <link rel="stylesheet" href="/static/mobile.css">'),
        ('<script src="/static/app.js"></script>',
         '<script src="/static/mobile.js"></script>\n  <script src="/static/app.js"></script>'),
    ):
        if old not in page:
            sys.exit(f"index.html no longer contains: {old}")
        page = page.replace(old, new)
    (web / "index.html").write_text(page, encoding="utf-8")
    return web


def stage_res():
    from PIL import Image
    res = BUILD / "res"
    shutil.copytree(HERE / "res", res)
    icon = Image.open(ROOT / "assets" / "icon.png").convert("RGBA")
    for name, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        d = res / f"mipmap-{name}"
        d.mkdir()
        icon.resize((size, size), Image.LANCZOS).save(d / "ic_launcher.png")
    return res


def main():
    shutil.rmtree(BUILD, ignore_errors=True)
    BUILD.mkdir(parents=True)
    stage_web()
    if "--stage-only" in sys.argv:
        print("Staged", BUILD / "assets" / "web")
        return
    res = stage_res()

    sdk = Path(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
               or Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk")
    if not (sdk / "build-tools").is_dir():
        sys.exit(f"Android SDK not found at {sdk}. Set ANDROID_HOME.")
    tools = newest(sdk / "build-tools")
    platform = sdk / "platforms" / f"android-{TARGET_SDK}"
    if not (platform / "android.jar").is_file():
        platform = newest(sdk / "platforms")
    android_jar = platform / "android.jar"
    ext = ".exe" if os.name == "nt" else ""
    bat = ".bat" if os.name == "nt" else ""
    java_home = os.environ.get("JAVA_HOME")
    jbin = (lambda n: Path(java_home) / "bin" / (n + ext)) if java_home else (lambda n: n)
    print("SDK tools:", tools.name, "| platform:", platform.name)

    # resources + manifest
    run(tools / f"aapt2{ext}", "compile", "--dir", res, "-o", BUILD / "res.zip")
    run(tools / f"aapt2{ext}", "link", "-o", BUILD / "base.apk", "-I", android_jar,
        "--manifest", HERE / "AndroidManifest.xml", "-A", BUILD / "assets", "--java", BUILD / "gen",
        "--min-sdk-version", MIN_SDK, "--target-sdk-version", TARGET_SDK,
        "--version-code", VERSION_CODE, "--version-name", VERSION_NAME, BUILD / "res.zip")

    # code
    sources = [*HERE.glob("src/**/*.java"), *(BUILD / "gen").glob("**/*.java")]
    (BUILD / "classes").mkdir()
    run(jbin("javac"), "-nowarn", "-Xlint:-options", "-encoding", "UTF-8", "--release", "8",
        "-classpath", android_jar, "-d", BUILD / "classes", *sources)
    (BUILD / "dex").mkdir()
    run(tools / f"d8{bat}", "--release", "--lib", android_jar, "--min-api", MIN_SDK,
        "--output", BUILD / "dex", *(BUILD / "classes").glob("**/*.class"))
    # Repack with the code added, keeping each entry stored or compressed as aapt2 chose.
    with zipfile.ZipFile(BUILD / "base.apk") as src, zipfile.ZipFile(BUILD / "unsigned.apk", "w") as dst:
        for item in src.infolist():
            dst.writestr(item.filename, src.read(item), item.compress_type)
        dst.write(BUILD / "dex" / "classes.dex", "classes.dex", zipfile.ZIP_DEFLATED)

    # align + sign
    run(tools / f"zipalign{ext}", "-f", "-p", "4", BUILD / "unsigned.apk", BUILD / "aligned.apk")
    if not KEYSTORE.exists():
        run(jbin("keytool"), "-genkeypair", "-keystore", KEYSTORE, "-storepass", KS_PASS, "-keypass", KS_PASS,
            "-alias", "opendesk", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-dname", "CN=OpenDesk")
    OUT.parent.mkdir(exist_ok=True)
    run(tools / f"apksigner{bat}", "sign", "--ks", KEYSTORE, "--ks-pass", f"pass:{KS_PASS}",
        "--ks-key-alias", "opendesk", "--out", OUT, BUILD / "aligned.apk")
    run(tools / f"apksigner{bat}", "verify", "--verbose", OUT)
    sig = OUT.with_suffix(".apk.idsig")
    if sig.exists():
        sig.unlink()
    print(f"\nBuilt {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
