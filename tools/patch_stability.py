"""Harden search concurrency, source health cooldowns, and homepage fallback."""

SEARCH_ROUTE = ".next/server/app/api/search/route.js"
HEALTH_SERVER = ".next/server/chunks/998.js"
HEALTH_CLIENT = ".next/static/chunks/354-fe055eb932927f43.js"
HOME_PAGE = ".next/static/chunks/app/page-cc426da9637e393f.js"


def _replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError(f"Bundled LibreTV source mismatch at {before[:72]!r} (count={text.count(before)})")
    return text.replace(before, after, 1)


def patch_search_route(source):
    """Cap concurrent upstream source queries to avoid mobile 5G/hotspot socket storms."""
    before = (
        'if("1"!==new URL(a.url).searchParams.get("stream")){'
        'let a=E(await Promise.all(e.map(a=>D(a,d))),d,f);'
        'return(0,x.lx)(g,a,6e4),u.NextResponse.json(a)}'
        'let i=new TextEncoder;'
        'return new Response(new ReadableStream({async start(a){'
        'let b=!1,c=c=>{if(!b)try{a.enqueue(i.encode(JSON.stringify(c)+"\\n"))}catch{b=!0}},h=Array(e.length);'
        'await Promise.all(e.map(async(a,b)=>{let e=await D(a,d);h[b]=e;let{list:g}=E([e],d,f);'
        'c({type:"source",...e,list:g})}));'
    )
    after = (
        'let ltvPool=async(items,limit,fn)=>{let out=Array(items.length),idx=0;'
        'await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{'
        'for(;idx<items.length;){let cur=idx++;out[cur]=await fn(items[cur],cur)}}));return out};'
        'if("1"!==new URL(a.url).searchParams.get("stream")){'
        'let a=E(await ltvPool(e,8,a=>D(a,d)),d,f);'
        'return(0,x.lx)(g,a,6e4),u.NextResponse.json(a)}'
        'let i=new TextEncoder;'
        'return new Response(new ReadableStream({async start(a){'
        'let b=!1,c=c=>{if(!b)try{a.enqueue(i.encode(JSON.stringify(c)+"\\n"))}catch{b=!0}},h=Array(e.length);'
        'await ltvPool(e,8,async(a,b)=>{let e=await D(a,d);h[b]=e;let{list:g}=E([e],d,f);'
        'c({type:"source",...e,list:g})});'
    )
    return _replace_once(source, before, after)


def patch_health_server(source):
    """Relax cooldown tiers (3m -> 10m -> 30m max, no permanent lock) and raise streak threshold to 5."""
    source = _replace_once(source, "let m=[18e5,864e5];", "let m=[18e4,6e5,18e5];")
    source = _replace_once(source, "if(!a.ok&&g>=2)", "if(!a.ok&&g>=5)")
    return _replace_once(
        source,
        "let b=h+1,c=m[b-1];i.disableCount=b,void 0===c?i.permanent=!0:i.disabledUntil=d+c,"
        "f.push({key:a.sourceKey,level:b,permanent:void 0===c,ttlMs:c})",
        "let b=h+1,c=m[Math.min(b-1,m.length-1)];i.disableCount=b,i.disabledUntil=d+c,"
        "f.push({key:a.sourceKey,level:b,permanent:!1,ttlMs:c})",
    )


def patch_health_client(source):
    """Mirror relaxed cooldowns on client, hide expired red badges, and prune stale persisted health."""
    source = _replace_once(source, "let f=[18e5,864e5];", "let f=[18e4,6e5,18e5];")
    source = _replace_once(source, "if(!e.ok&&d>=2)", "if(!e.ok&&d>=5)")
    source = _replace_once(
        source,
        "let t=m+1,r=f[t-1];p.disableCount=t,void 0===r?p.permanent=!0:p.disabledUntil=n+r,"
        "a.push({key:e.sourceKey,level:t,permanent:void 0===r,ttlMs:r})",
        "let t=m+1,r=f[Math.min(t-1,f.length-1)];p.disableCount=t,p.disabledUntil=n+r,"
        "a.push({key:e.sourceKey,level:t,permanent:!1,ttlMs:r})",
    )
    source = _replace_once(
        source,
        'return r.ok?(0,n.jsxs)("span",{className:"text-[10px]',
        'if(r.disabledUntil&&r.disabledUntil<=Date.now())return null;'
        'return r.ok?(0,n.jsxs)("span",{className:"text-[10px]',
    )
    return _replace_once(
        source,
        "y(h.getState()),h.persist.onFinishHydration(y)",
        "let ltvCleanHealth=()=>{let sh=h.getState().sourceHealth;"
        "if(!sh||0===Object.keys(sh).length)return;"
        "let now=Date.now(),nxt={},chg=!1;"
        "for(let[k,v]of Object.entries(sh)){"
        "if(!v||v.permanent||(v.disabledUntil&&v.disabledUntil<=now)"
        "||(!v.ok&&!v.disabledUntil&&(v.failStreak??0)<=2)){chg=!0;continue}"
        "nxt[k]=v}chg&&h.setState({sourceHealth:nxt})};"
        "y(h.getState()),ltvCleanHealth(),h.persist.onFinishHydration(e=>{y(e),ltvCleanHealth()})",
    )


def patch_home_page(source):
    """Avoid mass-disabling sources when 100% fail (network outage) and add home retry buttons."""
    source = _replace_once(
        source,
        'c.FH.search(x.slice(0,100),K,v,{signal:t,onSource:e=>{'
        'for(let s of(E(t=>[...t,e]),o.CU.getState().recordSourceHealth([e]))){var t;'
        'm(s.permanent?"「".concat(L(s.key),"」多次失败，已停止参与搜索，可在设置中恢复"):'
        '"「".concat(L(s.key),"」连续超时/失败，已停用 ").concat((0,d.CF)(null!=(t=s.ttlMs)?t:0)),"warning")}}})',
        '(()=>{let _ltvBatch=[];return c.FH.search(x.slice(0,100),K,v,{signal:t,'
        'onSource:e=>{_ltvBatch.push(e),E(t=>[...t,e])}}).then(res=>{'
        'if(K.length>=3&&_ltvBatch.length>=K.length&&_ltvBatch.every(e=>!e.ok)){'
        'm("全部点播源连接失败，可能是手机网络或切网波动，已保留全部片源不予停用","warning");return res}'
        'let dis=o.CU.getState().recordSourceHealth(_ltvBatch);'
        'for(let s of dis.slice(0,3)){var t2;'
        'm("「".concat(L(s.key),"」连续超时/失败，已暂停 ").concat((0,d.CF)(null!=(t2=s.ttlMs)?t2:0)),"warning")}'
        'if(dis.length>3)m("另有 ".concat(dis.length-3," 个异常源已暂停"),"warning");'
        'return res})})()',
    )
    source = _replace_once(
        source,
        'd.isError?(0,n.jsx)("p",{className:"text-center text-sm text-faint py-8",'
        'children:"推荐内容加载失败，可稍后重试或在设置中关闭"}):d.isLoading?(0,n.jsx)(P,{}):'
        '(0,n.jsx)("div",{className:"grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5",'
        'children:u.map(e=>(0,n.jsx)(w,{item:e,onClick:()=>a(e.title)},e.id))})',
        'd.isError||(!d.isLoading&&0===u.length)?(0,n.jsxs)("div",{className:"text-center py-8 space-y-2.5",'
        'children:[(0,n.jsx)("p",{className:"text-sm text-faint",'
        'children:d.isError?"推荐内容加载失败，请检查网络或点击重试":"暂无推荐内容，可检查网络后重试"}),'
        '(0,n.jsx)("button",{type:"button",onClick:()=>d.refetch(),'
        'className:"px-4 py-2 rounded-lg text-xs bg-chip text-content hover:bg-hover transition-colors",'
        'children:"重新加载推荐"})]}):d.isLoading?(0,n.jsx)(P,{}):'
        '(0,n.jsx)("div",{className:"grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5",'
        'children:u.map(e=>(0,n.jsx)(w,{item:e,onClick:()=>a(e.title)},e.id))})',
    )
    return source


STABILITY_PATCHES = {
    SEARCH_ROUTE: patch_search_route,
    HEALTH_SERVER: patch_health_server,
    HEALTH_CLIENT: patch_health_client,
    HOME_PAGE: patch_home_page,
}
