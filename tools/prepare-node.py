#!/usr/bin/env python3
"""
为 APK 准备「手机本地运行 LibreTV 服务」所需的 Node.js 运行时与前端补丁。

产出的文件全部是构建期第三方二进制或二次打补丁产物，不入库（见 .gitignore）：
  app/src/main/jniLibs/arm64-v8a/*.so      Node 可执行文件 + 其动态依赖
  app/src/main/assets/libretv-standalone.bin  LibreTV 2.22.0 standalone（默认经 HLS/播放器/极光 UI 补丁并以 XZ 打包）
  app/src/main/assets/node-runtime.json       运行时清单（供 Java 读取）

说明：
  * 从清华 TUNA Termux 镜像抓取 aarch64 Node.js 与依赖库，改写 ELF .dynstr 短库名以适配 Android nativeLibraryDir。
  * 从上游 LibreTV v2.22.0 Release 获取 standalone 包（也可通过 --standalone / LIBRETV_STANDALONE_TAR 指定本地离线包）。
  * 默认调用同目录 patch_hls.patch_archive() 注入 HLS 403 本地反代、播放器控制、稳健性补丁与 Aurora 极光 UI，并裁剪构建期 TypeScript、以 XZ 压缩。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
JNI = ROOT / "app/src/main/jniLibs/arm64-v8a"
ASSETS = ROOT / "app/src/main/assets"
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "libretv-node-cache"
CACHE = Path(os.environ.get("LIBRETV_NODE_CACHE", str(DEFAULT_CACHE)))

MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/"
PACKAGES_GZ = MIRROR + "dists/stable/main/binary-aarch64/Packages.gz"
STANDALONE_URL = (
    "https://github.com/LibreSpark/LibreTV/releases/download/v2.22.0/"
    "libretv-2.22.0-standalone.tar.gz"
)
NODE_PKG = "nodejs-lts"
DEP_PKGS = ["libc++", "openssl", "c-ares", "libicu", "libsqlite", "zlib"]

# DT_NEEDED / SONAME 原名 -> 打包后的短名（长度必须不增加）
RENAME = {
    "libz.so.1": "libz.so",
    "libcrypto.so.3": "libcrypto.so",
    "libssl.so.3": "libssl.so",
    "libicui18n.so.79": "libicui18n.so",
    "libicuuc.so.79": "libicuuc.so",
    "libicudata.so.79": "libicudata.so",
}

# 打包文件名 <- deb 内的逻辑名（可能是符号链接）
WANT = {
    "libnode.so": "__NODE_BINARY__",
    "libc++_shared.so": "libc++_shared.so",
    "libcares.so": "libcares.so",
    "libsqlite3.so": "libsqlite3.so",
    "libz.so": "libz.so.1",
    "libcrypto.so": "libcrypto.so.3",
    "libssl.so": "libssl.so.3",
    "libicui18n.so": "libicui18n.so.79",
    "libicuuc.so": "libicuuc.so.79",
    "libicudata.so": "libicudata.so.79",
}


def log(msg: str) -> None:
    print("[node] " + msg, flush=True)


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log("下载 " + url.rsplit("/", 1)[-1])
    req = urllib.request.Request(url, headers={"User-Agent": "libretv-apk/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as w:
        shutil.copyfileobj(r, w)
    return dest


def parse_packages(path: Path) -> dict:
    text = gzip.open(path, "rt", errors="replace").read()
    meta = {}
    for block in text.split("\n\n"):
        d = {}
        for line in block.splitlines():
            if ": " in line:
                k, v = line.split(": ", 1)
                d.setdefault(k, v)
        if "Package" in d:
            meta[d["Package"]] = d
    return meta


def deb_members(deb: Path) -> dict:
    """返回 {逻辑路径 basename: (bytes, is_symlink, link_target)}。"""
    data = deb.read_bytes()
    assert data[:8] == b"!<arch>\n", "不是 ar 归档: " + str(deb)
    off, body = 8, None
    while off + 60 <= len(data):
        hdr = data[off:off + 60]
        name = hdr[:16].decode("ascii").strip()
        size = int(hdr[48:58].decode("ascii").strip() or "0")
        if name.startswith("data.tar"):
            body = data[off + 60:off + 60 + size]
            break
        off += 60 + size + (size % 2)
    assert body, "deb 里没有 data.tar: " + str(deb)
    out = {}
    with tarfile.open(fileobj=io.BytesIO(body)) as tf:
        for m in tf.getmembers():
            base = os.path.basename(m.name)
            if not base or ".so" not in base:
                continue
            if m.issym() or m.islnk():
                out[base] = (None, True, m.linkname)
            elif m.isfile():
                f = tf.extractfile(m)
                out[base] = (f.read() if f else b"", False, "")
    return out


def resolve(members: dict, name: str, depth: int = 0):
    """跟随 deb 内符号链接，拿到真实文件内容。"""
    if depth > 5 or name not in members:
        return None
    data, is_link, target = members[name]
    if is_link:
        return resolve(members, os.path.basename(target), depth + 1)
    return data


def patch_elf(data: bytes) -> bytes:
    """等长替换 .dynstr 中带版本号的库名，使打包文件名以 .so 结尾。"""
    for old, new in RENAME.items():
        assert len(new) <= len(old), (old, new)
        pat = old.encode() + b"\0"
        rep = new.encode() + b"\0" * (len(old) - len(new) + 1)
        assert len(rep) == len(pat)
        data = data.replace(pat, rep)
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="准备 LibreTV Android 开源版 Node 运行时")
    parser.add_argument("--standalone", type=Path, help="本地 libre-tv standalone tar.gz 路径（可选）")
    parser.add_argument("--icu-data-lib", type=Path, help="预先裁剪好的 arm64 libicudata.so（可选）")
    parser.add_argument("--raw-runtime", action="store_true", help="跳过 HLS/UI 补丁与 XZ 重打包，保留上游原包")
    args = parser.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    JNI.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    idx = fetch(PACKAGES_GZ, CACHE / "Packages.gz")
    meta = parse_packages(idx)
    if NODE_PKG not in meta:
        log("错误：镜像里找不到 " + NODE_PKG)
        return 1
    node_version = meta[NODE_PKG].get("Version", "unknown")

    pool: dict = {}
    pkg_names = [NODE_PKG] + DEP_PKGS
    for name in pkg_names:
        m = meta.get(name)
        if not m:
            log("警告：找不到依赖包 " + name)
            continue
        deb = fetch(MIRROR + m["Filename"], CACHE / os.path.basename(m["Filename"]))
        log("解包 %-12s %s" % (name, m.get("Version", "")))
        for k, v in deb_members(deb).items():
            pool.setdefault(k, v)

    # node 二进制
    node_deb = CACHE / os.path.basename(meta[NODE_PKG]["Filename"])
    node_raw = None
    data = node_deb.read_bytes()
    off = 8
    while off + 60 <= len(data):
        hdr = data[off:off + 60]
        nm = hdr[:16].decode("ascii").strip()
        sz = int(hdr[48:58].decode("ascii").strip() or "0")
        if nm.startswith("data.tar"):
            with tarfile.open(fileobj=io.BytesIO(data[off + 60:off + 60 + sz])) as tf:
                for t in tf.getmembers():
                    if t.isfile() and t.name.endswith("/bin/node"):
                        f = tf.extractfile(t)
                        node_raw = f.read()
            break
        off += 60 + sz + (sz % 2)
    if not node_raw:
        log("错误：node 二进制未找到")
        return 1
    pool["__NODE_BINARY__"] = (node_raw, False, "")

    icu_override = args.icu_data_lib or (
        Path(os.environ["LIBRETV_ICU_DATA_LIB"]) if os.environ.get("LIBRETV_ICU_DATA_LIB") else None
    )

    written = []
    for out_name, logical in WANT.items():
        if out_name == "libicudata.so" and icu_override:
            if not icu_override.is_file():
                log("错误：找不到 --icu-data-lib 文件: " + str(icu_override))
                return 1
            raw = icu_override.read_bytes()
        else:
            raw = resolve(pool, logical)
            if raw is None:
                log("错误：缺少库 " + logical + " -> " + out_name)
                return 1
            raw = patch_elf(raw)
        (JNI / out_name).write_bytes(raw)
        try:
            os.chmod(JNI / out_name, 0o755)
        except OSError:
            pass
        written.append(out_name)
        log("  %-24s %8.1f MB" % (out_name, len(raw) / 1048576))

    # LibreTV standalone 运行包
    env_sa = os.environ.get("LIBRETV_STANDALONE_TAR")
    standalone = args.standalone or (Path(env_sa) if env_sa else CACHE / "libretv-2.22.0-standalone.tar.gz")
    if not standalone.is_file():
        if args.standalone or env_sa:
            log("错误：找不到指定的运行包 " + str(standalone))
            return 1
        fetch(STANDALONE_URL, standalone)

    raw_blob = standalone.read_bytes()
    if args.raw_runtime:
        final_blob = raw_blob
    else:
        sys.path.insert(0, str(TOOLS_DIR))
        from patch_hls import patch_archive
        log("应用开源版 HLS 反代 + 播放器控制 + 稳健性 + 极光 UI 补丁（XZ 打包）...")
        final_blob = patch_archive(
            raw_blob,
            player_controls=True,
            prune_typescript=True,
            runtime_xz=True,
        )

    # 必须用 .bin 后缀：aapt 会自动 gunzip assets 里的 *.gz 并去掉后缀
    runtime_name = "libretv-standalone.bin"
    (ASSETS / runtime_name).write_bytes(final_blob)

    runtime_sha = hashlib.sha256(final_blob).hexdigest()
    manifest = {
        "abi": "arm64-v8a",
        "nodeVersion": node_version,
        "nodeLib": "libnode.so",
        "libs": written,
        "runtimeArchive": runtime_name,
        "runtimeSha256": runtime_sha,
        "defaultPort": 8899,
        "patched": not args.raw_runtime,
        "note": "构建期生成的第三方运行时清单，二进制文件本身不入库",
    }
    (ASSETS / "node-runtime.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    total = sum((JNI / n).stat().st_size for n in written)
    log("完成：%d 个 ELF，合计 %.1f MB（未压缩）；运行包 %.2f MB" % (
        len(written), total / 1048576, len(final_blob) / 1048576
    ))
    log("运行包 %s，SHA256 %s" % (runtime_name, runtime_sha[:16]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
