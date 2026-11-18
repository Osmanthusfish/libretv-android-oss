"""Connect the mobile controls to the upstream watch page without duplicating its state."""
from patch_hls import replace_once

WATCH = ".next/static/chunks/app/watch/page-dfc5e83f9075ddc2.js"


def patch_watch(source):
    return replace_once(
        source,
        'let ec=E?',
        '(0,l.useEffect)(()=>{if(!b||!V)return;'
        'const saveNow=()=>{const video=D.current?.querySelector("video")||document.querySelector("video");'
        'if(video&&Number.isFinite(video.duration)&&video.currentTime>0&&!video.ended)'
        'er(video.currentTime,video.duration)};'
        'const controls={count:Y.length,index:X,stream:Q,'
        'select:e=>{if(Number.isInteger(e)&&e>=0&&e<Y.length)es(e)},'
        'switchSource:()=>A(true),save:saveNow};window.__ltvWatch=controls;'
        'const save=()=>{if(document.visibilityState==="hidden")saveNow()};'
        'document.addEventListener("visibilitychange",save);'
        'window.addEventListener("pagehide",saveNow);'
        'return()=>{document.removeEventListener("visibilitychange",save);'
        'window.removeEventListener("pagehide",saveNow);'
        'if(window.__ltvWatch===controls)delete window.__ltvWatch}},'
        '[b,V?.url,Y.length,X,Q,es,er]);let ec=E?',
    )
