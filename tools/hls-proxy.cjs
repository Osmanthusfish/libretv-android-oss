'use strict';

// Android HLS fallback shares the upstream proxy's authentication and DNS checks.
const MAX_MANIFEST = 2 * 1024 * 1024;

function httpUrl(value, base) {
  try {
    const url = new URL(value, base);
    if ((url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username && !url.password) return url;
  } catch {}
  return null;
}

function referer(value, target) {
  const url = (value && httpUrl(value)) || httpUrl(target);
  return url ? url.origin + '/' : '';
}

function proxyUrl(target, ref) {
  return '/api/proxy?' + new URLSearchParams({ ltv_hls: '1', ref, url: target });
}

function rewrite(manifest, finalUrl, ref) {
  function resolve(value) {
    if (/^\/api\/(?:proxy(?:[/?]|$)|live\/stream(?:[/?]|$))/.test(value)) return value;
    const target = httpUrl(value, finalUrl);
    return target ? proxyUrl(target.href, ref) : value;
  }
  return manifest.split(/\r?\n/).map(line => {
    const value = line.trim();
    if (!value) return line;
    if (!value.startsWith('#')) return resolve(value);
    if (!value.startsWith('#EXT-X-')) return line;
    // Matches URI and attributes ending in -URI (for example SERVER-URI).
    return line.replace(/([:,]\s*(?:[\w-]+-)?URI=)"([^"]+)"/g,
      (match, attr, uri) => attr + '"' + resolve(uri) + '"');
  }).join('\n');
}

function isManifest(contentType, requestedUrl, finalUrl) {
  return /mpegurl/i.test(contentType) ||
    [requestedUrl, finalUrl].some(url => /\.m3u8$/i.test(httpUrl(url)?.pathname || ''));
}

async function readManifest(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let manifest = '';
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) return manifest + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_MANIFEST) {
        await reader.cancel();
        throw new Error('HLS manifest exceeds 2 MiB');
      }
      manifest += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.releaseLock();
  }
}

module.exports = { referer, rewrite, isManifest, readManifest };
