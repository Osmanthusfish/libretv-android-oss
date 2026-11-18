#!/usr/bin/env python3
"""
跨平台构建纯净零源 LibreTV Android 开源版 APK（不依赖 Gradle，仅需 Android SDK + JDK 8+ + Python 3）。

特性：
  * 严格排除 default-sources.json / sources.json / libretv-settings.json，保证 0 内置点播/直播源；
  * 保持 network_security_config.xml 原样（仅允许 127.0.0.1 本地环回明文，无任何外部源域名）；
  * 若输入运行时为未补丁包，自动调用 patch_hls.patch_archive() 注入 HLS 403 反代、播放器控制、稳健性与极光 UI 并 XZ 压缩；
  * 固定 ZIP 条目时间戳、编译 debuggable=false、使用独立非个人 OSS 证书进行 v1/v2/v3 签名。

示例：
  python tools/build-oss-apk.py --runtime-from-apk ../dist/LibreTV-1.2.4-oss-debug-原版.apk --out ../dist/LibreTV-1.2.17-oss.apk
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
APP_DIR = REPO_ROOT / "app"
MAIN_DIR = APP_DIR / "src" / "main"

FORBIDDEN_SOURCE_ASSETS = {
    "assets/default-sources.json",
    "assets/sources.json",
    "assets/libretv-settings.json",
}
SIGNATURE_PREFIX = "META-INF/"
SIGNATURE_EXTS = (".SF", ".RSA", ".DSA", ".EC")
NEUTRAL_ZIP_TIME = (2026, 1, 1, 0, 0, 0)

XZ_URL = "https://repo1.maven.org/maven2/org/tukaani/xz/1.12/xz-1.12.jar"
XZ_SHA256 = "3e158a87bd73d8afb4b6e8239c013b7d049c48563f45860ce99cd2e448cf4a6b"


def find_sdk(explicit: Path | None) -> Path:
    candidates = [explicit] if explicit else []
    for env_key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        val = os.environ.get(env_key)
        if val:
            candidates.append(Path(val))
    local_props = REPO_ROOT / "local.properties"
    if local_props.is_file():
        m = re.search(r"^sdk\.dir=(.+)$", local_props.read_text(encoding="utf-8", errors="ignore"), re.M)
        if m:
            candidates.append(Path(m.group(1).replace("\\\\", "\\").replace("\\:", ":")))
    for path in candidates:
        if path and path.is_dir():
            return path.resolve()
    raise FileNotFoundError("Android SDK not found; set ANDROID_HOME or pass --sdk")


def tool_exe(directory: Path, stem: str) -> Path:
    suffixes = (".exe", ".bat", "") if os.name == "nt" else ("", ".sh")
    for suffix in suffixes:
        candidate = directory / f"{stem}{suffix}"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"Tool '{stem}' not found in {directory}")


def version_key(name: str):
    return [int(part) if part.isdigit() else 0 for part in re.split(r"[^0-9]+", name) if part]


def find_build_tools_and_platform(sdk: Path, min_compile: int):
    bt_dirs = [p for p in (sdk / "build-tools").glob("*") if p.is_dir()]
    if not bt_dirs:
        raise FileNotFoundError(f"No build-tools found under {sdk / 'build-tools'}")
    bt = sorted(bt_dirs, key=lambda p: version_key(p.name))[-1]

    plat_dirs = []
    for p in (sdk / "platforms").glob("android-*"):
        if (p / "android.jar").is_file():
            api = version_key(p.name)
            plat_dirs.append((api[0] if api else 0, p))
    if not plat_dirs:
        raise FileNotFoundError(f"No platforms/android-*/android.jar found under {sdk / 'platforms'}")
    eligible = [pair for pair in plat_dirs if pair[0] >= min_compile]
    android_jar = (sorted(eligible) if eligible else sorted(plat_dirs))[-1][1] / "android.jar"
    return bt, android_jar


def resolve_xz_jar(explicit: Path | None, cache_dir: Path) -> Path:
    if explicit:
        data = explicit.read_bytes()
        if hashlib.sha256(data).hexdigest() != XZ_SHA256:
            raise ValueError(f"SHA-256 mismatch for {explicit}")
        return explicit.resolve()
    cached = cache_dir / "xz-1.12.jar"
    if not cached.is_file() or hashlib.sha256(cached.read_bytes()).hexdigest() != XZ_SHA256:
        cached.parent.mkdir(parents=True, exist_ok=True)
        print(f"[deps] downloading xz-1.12.jar ...", flush=True)
        req = urllib.request.Request(XZ_URL, headers={"User-Agent": "libretv-oss-builder/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r, open(cached, "wb") as w:
            shutil.copyfileobj(r, w)
        if hashlib.sha256(cached.read_bytes()).hexdigest() != XZ_SHA256:
            raise ValueError("Downloaded xz-1.12.jar failed SHA-256 verification")
    return cached


def ensure_oss_keystore(ks_path: Path, ks_pass: str, ks_alias: str) -> Path:
    if ks_path.is_file():
        return ks_path
    ks_path.parent.mkdir(parents=True, exist_ok=True)
    keytool = shutil.which("keytool")
    if keytool:
        subprocess.run([
            keytool, "-genkeypair", "-v",
            "-keystore", str(ks_path), "-storetype", "PKCS12",
            "-storepass", ks_pass, "-keypass", ks_pass,
            "-alias", ks_alias, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-dname", "CN=LibreTV Android OSS, O=OpenSource",
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return ks_path
    from datetime import datetime, timedelta, timezone
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "LibreTV Android OSS"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "OpenSource"),
    ])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=10000))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                          data_encipherment=False, key_agreement=False, key_cert_sign=False,
                          crl_sign=False, encipher_only=False, decipher_only=False),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CODE_SIGNING]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    ks_path.write_bytes(pkcs12.serialize_key_and_certificates(
        name=ks_alias.encode(), key=key, cert=cert, cas=None,
        encryption_algorithm=serialization.BestAvailableEncryption(ks_pass.encode()),
    ))
    return ks_path


def run_cmd(*args, cwd=None):
    subprocess.run([str(a) for a in args], check=True, cwd=cwd)


def build_oss_apk(args) -> Path:
    gradle_text = (APP_DIR / "build.gradle").read_text(encoding="utf-8")
    min_sdk = re.search(r"\bminSdk\s+(\d+)", gradle_text)[1]
    target_sdk = re.search(r"\btargetSdk\s+(\d+)", gradle_text)[1]
    compile_sdk = int(re.search(r"\bcompileSdk\s+(\d+)", gradle_text)[1])
    ver_code = re.search(r"\bversionCode\s+(\d+)", gradle_text)[1]
    ver_name = re.search(r"\bversionName\s+'([^']+)'", gradle_text)[1]

    sdk = find_sdk(args.sdk)
    bt_dir, android_jar = find_build_tools_and_platform(sdk, compile_sdk)
    aapt2 = tool_exe(bt_dir, "aapt2")
    d8 = tool_exe(bt_dir, "d8")
    zipalign = tool_exe(bt_dir, "zipalign")
    apksigner = tool_exe(bt_dir, "apksigner")

    cache_dir = Path(tempfile.gettempdir()) / "libretv-oss-build-cache"
    xz_jar = resolve_xz_jar(args.xz_jar, cache_dir)

    default_ks = cache_dir / "libretv-oss-release.p12"
    ks_path = ensure_oss_keystore(args.keystore or default_ks, args.ks_pass, args.ks_alias)

    with tempfile.TemporaryDirectory(prefix="libretv-oss-") as tmp:
        work = Path(tmp)
        manifest = work / "AndroidManifest.xml"
        manifest.write_text(
            (MAIN_DIR / "AndroidManifest.xml").read_text(encoding="utf-8").replace(
                "<manifest ", '<manifest package="com.libretv.client" ', 1
            ),
            encoding="utf-8",
        )
        res_dir = work / "res"
        shutil.copytree(MAIN_DIR / "res", res_dir)

        compiled = work / "res.zip"
        resource_apk = work / "resources.apk"
        generated = work / "generated"
        generated.mkdir()
        run_cmd(aapt2, "compile", "--dir", res_dir.name, "-o", compiled.name, cwd=work)
        run_cmd(
            aapt2, "link", "-I", android_jar, "--manifest", manifest.name,
            "--min-sdk-version", min_sdk, "--target-sdk-version", target_sdk,
            "--version-code", ver_code, "--version-name", ver_name,
            "--java", generated.name, "-o", resource_apk.name, compiled.name,
            cwd=work,
        )

        classes = work / "classes"
        classes.mkdir()
        sources = sorted((MAIN_DIR / "java").rglob("*.java")) + sorted(generated.rglob("*.java"))
        classpath = os.pathsep.join((str(android_jar), str(xz_jar)))
        run_cmd("javac", "-encoding", "UTF-8", "--release", "8", "-classpath", classpath, "-d", classes, *sources)

        class_jar = work / "classes.jar"
        with zipfile.ZipFile(class_jar, "w", zipfile.ZIP_DEFLATED) as zout, zipfile.ZipFile(xz_jar) as xz:
            for cls in sorted(classes.rglob("*.class")):
                zout.write(cls, cls.relative_to(classes).as_posix())
            for item in xz.namelist():
                if item.startswith("org/tukaani/xz/") and item.endswith(".class"):
                    zout.writestr(item, xz.read(item))
        run_cmd(d8, "--release", "--min-api", min_sdk, "--lib", android_jar, "--output", work, class_jar)

        # Runtime preparation (strictly 0 sources)
        assets_dir = MAIN_DIR / "assets"
        asset_bytes = {
            f"assets/{p.relative_to(assets_dir).as_posix()}": p.read_bytes()
            for p in sorted(assets_dir.rglob("*"))
            if p.is_file() and f"assets/{p.relative_to(assets_dir).as_posix()}" not in FORBIDDEN_SOURCE_ASSETS
        }

        jni_bytes = {}
        jni_dir = MAIN_DIR / "jniLibs" / "arm64-v8a"
        if args.runtime_from_apk:
            with zipfile.ZipFile(args.runtime_from_apk) as orig:
                for info in orig.infolist():
                    if info.filename.startswith("lib/arm64-v8a/") and info.filename.endswith(".so"):
                        jni_bytes[info.filename] = orig.read(info.filename)
                if "assets/libretv-standalone.bin" not in asset_bytes:
                    asset_bytes["assets/libretv-standalone.bin"] = orig.read("assets/libretv-standalone.bin")
                if "assets/node-runtime.json" not in asset_bytes:
                    asset_bytes["assets/node-runtime.json"] = orig.read("assets/node-runtime.json")
        else:
            if not jni_dir.is_dir() or "assets/libretv-standalone.bin" not in asset_bytes:
                raise FileNotFoundError(
                    "Prepared jniLibs/assets runtime missing; run tools/prepare-node.py first or pass --runtime-from-apk"
                )
            for so in sorted(jni_dir.glob("*.so")):
                jni_bytes[f"lib/arm64-v8a/{so.name}"] = so.read_bytes()

        if args.icu_data_lib:
            jni_bytes["lib/arm64-v8a/libicudata.so"] = args.icu_data_lib.read_bytes()

        manifest_info = json.loads(asset_bytes["assets/node-runtime.json"].decode("utf-8"))
        if not manifest_info.get("patched"):
            sys.path.insert(0, str(TOOLS_DIR))
            from patch_hls import patch_archive
            print("[oss] patching standalone runtime (HLS proxy, controls, stability, Aurora UI, XZ)...", flush=True)
            patched_blob = patch_archive(
                asset_bytes["assets/libretv-standalone.bin"],
                player_controls=True,
                prune_typescript=True,
                runtime_xz=True,
            )
            asset_bytes["assets/libretv-standalone.bin"] = patched_blob
            manifest_info["runtimeSha256"] = hashlib.sha256(patched_blob).hexdigest()
            manifest_info["patched"] = True
            asset_bytes["assets/node-runtime.json"] = json.dumps(manifest_info, ensure_ascii=False, indent=2).encode("utf-8")

        unsigned_apk = work / "unsigned.apk"
        with zipfile.ZipFile(unsigned_apk, "w", zipfile.ZIP_DEFLATED) as out, zipfile.ZipFile(resource_apk) as linked:
            for entry in linked.infolist():
                if entry.filename in FORBIDDEN_SOURCE_ASSETS:
                    continue
                if entry.filename.startswith(SIGNATURE_PREFIX) and (
                    entry.filename.upper().endswith(SIGNATURE_EXTS) or entry.filename == "META-INF/MANIFEST.MF"
                ):
                    continue
                zi = zipfile.ZipInfo(entry.filename, date_time=NEUTRAL_ZIP_TIME)
                zi.compress_type = entry.compress_type
                zi.external_attr = entry.external_attr
                out.writestr(zi, linked.read(entry.filename), compress_type=entry.compress_type)

            for dex in sorted(work.glob("classes*.dex")):
                zi = zipfile.ZipInfo(dex.name, date_time=NEUTRAL_ZIP_TIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(zi, dex.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)

            for name, payload in sorted(jni_bytes.items()):
                zi = zipfile.ZipInfo(name, date_time=NEUTRAL_ZIP_TIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(zi, payload, compress_type=zipfile.ZIP_DEFLATED)

            for name, payload in sorted(asset_bytes.items()):
                if name in FORBIDDEN_SOURCE_ASSETS:
                    raise AssertionError(f"Refusing forbidden source asset: {name}")
                zi = zipfile.ZipInfo(name, date_time=NEUTRAL_ZIP_TIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(zi, payload, compress_type=zipfile.ZIP_DEFLATED)

        aligned_apk = work / "aligned.apk"
        run_cmd(zipalign, "-f", "-p", "4", unsigned_apk, aligned_apk)

        out_path = args.out.resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        run_cmd(
            apksigner, "sign",
            "--ks", ks_path,
            "--ks-pass", f"pass:{args.ks_pass}",
            "--ks-key-alias", args.ks_alias,
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "true",
            "--v3-signing-enabled", "true",
            "--out", out_path,
            aligned_apk,
        )
        run_cmd(apksigner, "verify", "-v", out_path)
        return out_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, help="Android SDK path (defaults to ANDROID_HOME / ANDROID_SDK_ROOT)")
    parser.add_argument("--xz-jar", type=Path, help="Optional verified org.tukaani:xz:1.12 JAR path")
    parser.add_argument("--runtime-from-apk", type=Path, help="Supply base lib/arm64-v8a & runtime from an unmodified OSS APK")
    parser.add_argument("--icu-data-lib", type=Path, help="Optional trimmed arm64 libicudata.so path")
    parser.add_argument("--keystore", type=Path, help="Optional PKCS12 signing keystore (auto-generates generic OSS key if omitted)")
    parser.add_argument("--ks-pass", default="libretv-oss", help="Keystore password")
    parser.add_argument("--ks-alias", default="libretv-oss", help="Keystore alias")
    parser.add_argument("--out", type=Path, required=True, help="Output signed zero-source OSS APK path")
    args = parser.parse_args()
    out_apk = build_oss_apk(args)
    sha = hashlib.sha256(out_apk.read_bytes()).hexdigest()
    print(f"DONE -> {out_apk} ({out_apk.stat().st_size:,} B, SHA-256={sha})")


if __name__ == "__main__":
    main()
