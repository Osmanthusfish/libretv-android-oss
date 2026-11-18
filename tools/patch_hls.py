"""Adapt the bundled LibreTV 2.22.0 player fallback and existing authenticated proxy."""
import gzip
import io
import lzma
import tarfile
from pathlib import Path

SERVER_PROXY = ".next/server/chunks/324.js"
PLAYER = ".next/static/chunks/501.f7d7f68479be3e23.js"
HELPER = ".next/server/chunks/ltv-hls.cjs"


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError(f"Bundled LibreTV source has changed at {before[:72]!r}")
    return text.replace(before, after, 1)


def patch_proxy(source):
    source = replace_once(
        source,
        'async function p(a,b){let c,h=(0,e.P)(a);',
        'async function p(a,b){const ltvParams=new URL(a.url).searchParams,'
        'ltvHls=ltvParams.get("ltv_hls")==="1",ltv=require("./ltv-hls.cjs");'
        'let c,h=(0,e.P)(a);if(ltvHls&&h)return h;',
    )
    source = replace_once(
        source,
        'let o=a.headers.get("range");',
        'const ltvRef=ltvHls?ltv.referer(ltvParams.get("ref"),b):"";'
        'if(ltvRef){i.Referer=ltvRef;i.Origin=new URL(ltvRef).origin}'
        'let o=a.headers.get("range");',
    )
    source = replace_once(
        source,
        'if(r.includes("mpegurl")||r.includes("x-mpegurl")||b.toLowerCase().endsWith(".m3u8"))',
        'if(ltvHls&&!c.ok){if(c.body)await c.body.cancel();'
        'return new d.NextResponse(c.status===304?null:"HLS upstream HTTP "+c.status,{status:c.status,'
        'headers:{"Cache-Control":"no-store"}})}'
        'if(ltvHls&&c.body&&ltv.isManifest(r,b,p)){try{'
        'return new d.NextResponse(ltv.rewrite(await ltv.readManifest(c),p,ltvRef),'
        '{status:c.status,headers:{"Content-Type":"application/vnd.apple.mpegurl",'
        '"Cache-Control":"no-store"}})}catch{return new d.NextResponse('
        '"Unable to read HLS manifest",{status:502})}}'
        'if(!ltvHls&&(r.includes("mpegurl")||r.includes("x-mpegurl")||b.toLowerCase().endsWith(".m3u8")))',
    )
    return replace_once(
        source,
        's.set("Cache-Control",r.startsWith("image/")?',
        's.set("Cache-Control",ltvHls?"private, no-store":r.startsWith("image/")?',
    )


def patch_player(source):
    source = replace_once(
        source,
        'theme:"#2563eb"',
        'theme:"#00b8e6"',
    )
    source = replace_once(
        source,
        'o.A.CONTROL_HIDE_TIME=a?S.mc:S.Lq',
        'o.A.CONTROL_HIDE_TIME=a?4e3:S.Lq',
    )
    return replace_once(
        source,
        'eD(e,"/api/proxy?url=".concat(encodeURIComponent(t)),!1);',
        'eD(e,"/api/proxy?"+new URLSearchParams({ltv_hls:"1",'
        'ref:new URLSearchParams(location.search).get("sourceUrl")||"",'
        'url:new URL(t,location.href).href}),!1);',
    )


def patch_player_ui(source):
    source = replace_once(
        source,
        's.video.playbackRate=3,d=!0,eE("3 倍速")',
        's.video.playbackRate=2,d=!0,eE("2 倍速")',
    )
    source = replace_once(
        source,
        'Z&&!$&&(0,i.jsx)("div",{className:"absolute inset-0 bg-black pointer-events-none",'
        'style:{backgroundImage:"url(/player-poster.png)",backgroundSize:"contain",'
        'backgroundPosition:"center",backgroundRepeat:"no-repeat"}})',
        '!$&&(0,i.jsx)("div",{"data-ltv-poster":Z?"1":"0",'
        'className:"ltv-player-poster absolute inset-0 bg-black pointer-events-none",'
        'style:{backgroundImage:"url(/player-poster.png)",backgroundSize:"cover",'
        'backgroundPosition:"center",backgroundRepeat:"no-repeat"}})',
    )
    return replace_once(
        source,
        'd&&!$&&(0,i.jsx)("div",{className:"absolute bottom-16 right-3 text-[10px] '
        'text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none",children:"自动连播已开启"})',
        'd&&!$&&(0,i.jsx)("div",{"data-ltv-autoplay-badge":Z?"1":"0",'
        'className:"ltv-autoplay-badge absolute top-3 right-3 z-10 text-[10px] px-2.5 py-1 rounded-full pointer-events-none",'
        'children:"自动连播已开启"})',
    )


def patch_archive(blob, player_controls=False, prune_typescript=False, runtime_xz=False):
    patches = {SERVER_PROXY: patch_proxy, PLAYER: patch_player}
    binary_patches = {}
    if player_controls:
        from patch_player import WATCH, patch_watch
        from patch_stability import STABILITY_PATCHES
        from patch_ui_fx import UI_FX_TEXT_PATCHES, build_brand_assets
        patches[WATCH] = patch_watch
        patches.update(STABILITY_PATCHES)
        patches.update(UI_FX_TEXT_PATCHES)
        binary_patches.update(build_brand_assets())
    output = io.BytesIO()
    compressor = (lzma.LZMAFile(output, "w", preset=6) if runtime_xz else
                  gzip.GzipFile(fileobj=output, mode="wb", compresslevel=9, mtime=0))
    with (tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as original,
          compressor as compressed,
          tarfile.open(fileobj=compressed, mode="w|", format=tarfile.GNU_FORMAT) as archive):
        for entry in original:
            key = entry.name.removeprefix("./")
            # The bundled production app already contains the compiled Next server and pages.
            if prune_typescript and (key == "node_modules/typescript"
                                     or key.startswith("node_modules/typescript/")):
                continue
            content = original.extractfile(entry) if entry.isfile() else None
            if key in patches:
                data = patches.pop(key)(content.read().decode("utf-8")).encode("utf-8")
                if key == PLAYER and player_controls:
                    data = patch_player_ui(data.decode("utf-8")).encode("utf-8")
                entry.size = len(data)
                entry.mtime = 0
                entry.uid = 0
                entry.gid = 0
                entry.uname = ""
                entry.gname = ""
                content = io.BytesIO(data)
            elif key in binary_patches:
                data = binary_patches.pop(key)
                entry.size = len(data)
                entry.mtime = 0
                entry.uid = 0
                entry.gid = 0
                entry.uname = ""
                entry.gname = ""
                content = io.BytesIO(data)
            archive.addfile(entry, content)
        if patches or binary_patches:
            missing = sorted([*patches.keys(), *binary_patches.keys()])
            raise ValueError(f"Missing runtime entries: {', '.join(missing)}")
        data = Path(__file__).with_name("hls-proxy.cjs").read_bytes()
        helper = tarfile.TarInfo("./" + HELPER)
        helper.size = len(data)
        helper.mtime = 0
        helper.mode = 0o644
        helper.uid = 0
        helper.gid = 0
        helper.uname = ""
        helper.gname = ""
        archive.addfile(helper, io.BytesIO(data))
    return output.getvalue()
