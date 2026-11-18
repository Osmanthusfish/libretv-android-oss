#!/usr/bin/env bash
# 构建 LibreTV 安卓开源客户端 APK（零内置源，默认产出 release 签名包）。
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${LIBRETV_TOOLS:-/tmp/libretv-apk-tools}"
SDK="${ANDROID_HOME:-/tmp/androidsdk}"

find_java_home() {
  local d
  for d in "${JAVA_HOME:-}" "$TOOLS"/jdk-*/Contents/Home "$TOOLS"/jdk-*; do
    if [ -n "$d" ] && [ -x "$d/bin/java" ]; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

JAVA_HOME="$(find_java_home || true)"
if [ -z "$JAVA_HOME" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "缺少 JDK 17，请先执行 ./prepare-tools.sh" >&2; exit 1
fi
if [ ! -f "$SDK/platforms/android-34/android.jar" ]; then
  echo "缺少 Android SDK 34，请先执行 ./prepare-tools.sh" >&2; exit 1
fi
if [ ! -x "$TOOLS/gradle-8.6/bin/gradle" ]; then
  echo "缺少 Gradle 8.6，请先执行 ./prepare-tools.sh" >&2; exit 1
fi

export JAVA_HOME ANDROID_HOME="$SDK"
export PATH="$JAVA_HOME/bin:$PATH"
printf 'sdk.dir=%s\n' "$SDK" > "$ROOT/local.properties"

# ---------------------------------------------------------------- 开源版：绝不打包任何内置源
SOURCE_ASSETS="libretv-settings.json sources.json default-sources.json"
MOVED_ASSETS=""
restore_source_assets() {
  for f in $MOVED_ASSETS; do
    if [ -f "$ROOT/.oss-bak-$f" ]; then
      mv "$ROOT/.oss-bak-$f" "$ROOT/app/src/main/assets/$f" || true
    fi
  done
}
trap restore_source_assets EXIT INT TERM

for f in $SOURCE_ASSETS; do
  if [ -f "$ROOT/app/src/main/assets/$f" ]; then
    mv "$ROOT/app/src/main/assets/$f" "$ROOT/.oss-bak-$f"
    MOVED_ASSETS="$MOVED_ASSETS $f"
    echo "[源] 构建期移开 ${f}（开源版不含内置源）"
  fi
done

echo "[源] 开源版：APK 内不含任何预置源，首次启动后请在「设置 → 源管理 / 导入源」里自行配置"

# 手机本地服务运行时：Node ELF + patched standalone 运行包（构建期生成，不入库）
PY="${PY:-python3}"
NODE_LIB="$ROOT/app/src/main/jniLibs/arm64-v8a/libnode.so"
NODE_TAR="$ROOT/app/src/main/assets/libretv-standalone.bin"
if [ "${LIBRETV_NODE_REFRESH:-0}" = "1" ] || [ ! -f "$NODE_LIB" ] || [ ! -f "$NODE_TAR" ]; then
  echo "[Node] 准备手机本地服务运行时并注入开源版补丁 ..."
  "$PY" "$ROOT/tools/prepare-node.py" || { echo "[Node] 运行时准备失败" >&2; exit 1; }
else
  echo "[Node] 运行时已缓存，跳过（LIBRETV_NODE_REFRESH=1 可强制刷新）"
fi

VER="$(sed -n "s/^[[:space:]]*versionName[[:space:]]*'\([^']*\)'.*/\1/p" "$ROOT/app/build.gradle" | head -1)"
[ -n "$VER" ] || VER="unknown"
mkdir -p "$ROOT/dist"

cd "$ROOT"
"$TOOLS/gradle-8.6/bin/gradle" assembleRelease --no-daemon --console=plain

UNSIGNED="$ROOT/app/build/outputs/apk/release/app-release-unsigned.apk"
if [ ! -f "$UNSIGNED" ]; then
  echo "构建结束但未找到 release APK：$UNSIGNED" >&2; exit 1
fi

BT_DIR="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
KS="${LIBRETV_OSS_KEYSTORE:-$TOOLS/libretv-oss.p12}"
KS_PASS="${LIBRETV_OSS_KEYSTORE_PASS:-libretv-oss}"
KS_ALIAS="${LIBRETV_OSS_KEY_ALIAS:-libretv-oss}"

if [ -n "$BT_DIR" ] && [ -x "$BT_DIR/zipalign" ] && [ -x "$BT_DIR/apksigner" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
  if [ ! -f "$KS" ]; then
    "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KS" -storetype PKCS12 \
      -storepass "$KS_PASS" -keypass "$KS_PASS" -alias "$KS_ALIAS" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=LibreTV Android OSS, O=OpenSource" >/dev/null 2>&1
  fi
  ALIGNED="$TOOLS/libretv-release-aligned.apk"
  OUT="$ROOT/dist/LibreTV-${VER}.apk"
  "$BT_DIR/zipalign" -p -f 4 "$UNSIGNED" "$ALIGNED"
  "$BT_DIR/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" \
    --ks-key-alias "$KS_ALIAS" --out "$OUT" "$ALIGNED"
  rm -f "$ALIGNED"
else
  OUT="$ROOT/dist/LibreTV-${VER}-unsigned.apk"
  cp "$UNSIGNED" "$OUT"
  echo "[警告] 未找到 zipalign/apksigner/keytool，输出未签名 release APK：$OUT"
fi

echo "=== 产物 ==="
ls -lh "$OUT"
shasum -a 256 "$OUT"
