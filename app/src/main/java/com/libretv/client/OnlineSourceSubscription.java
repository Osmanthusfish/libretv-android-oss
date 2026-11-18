package com.libretv.client;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Proxy;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

final class OnlineSourceSubscription {
    private static final int MAX_BYTES = 512 * 1024;

    private OnlineSourceSubscription() {}

    static URL httpsUrl(String value) throws IOException {
        try {
            URI uri = new URI(value);
            if ("https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                    && uri.getUserInfo() == null) return uri.toURL();
        } catch (URISyntaxException | IllegalArgumentException ignored) { }
        throw new IOException("HTTPS subscription URL required");
    }

    static String fetch(String configuredUrl) throws IOException {
        URL url = httpsUrl(configuredUrl);
        for (int redirect = 0; redirect <= 3; redirect++) {
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection(Proxy.NO_PROXY);
            try {
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(10000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json, text/plain;q=0.9");
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String next = connection.getHeaderField("Location");
                    if (next == null) throw new IOException("Missing subscription redirect");
                    url = httpsUrl(new URL(url, next).toExternalForm());
                    continue;
                }
                if (status != 200 || connection.getContentLength() > MAX_BYTES) {
                    throw new IOException("Invalid subscription response");
                }
                try (InputStream in = connection.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    for (int count; (count = in.read(buffer)) != -1;) {
                        if (out.size() + count > MAX_BYTES) throw new IOException("Subscription exceeds size limit");
                        out.write(buffer, 0, count);
                    }
                    return out.toString("UTF-8");
                }
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many subscription redirects");
    }
}
