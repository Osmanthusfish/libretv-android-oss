package com.libretv.client;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** HTTP transport for SSDP-discovered LAN devices whose addresses change at runtime. */
final class DlnaHttp {
    private static final int MAX_BODY = 512 * 1024;
    private static final int MAX_LINE = 8192;

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private DlnaHttp() {}

    static Response request(URL url, int connectTimeout, int readTimeout, String soapAction, byte[] body)
            throws IOException {
        if (!"http".equals(url.getProtocol()) || url.getUserInfo() != null) {
            throw new IOException("无效的 DLNA HTTP 地址");
        }
        // Resolve once and connect to that exact address. Plain HTTP here serves LAN devices only.
        InetAddress address = InetAddress.getByName(url.getHost());
        if (!address.isSiteLocalAddress() && !address.isLinkLocalAddress()) {
            throw new IOException("DLNA 明文连接需要局域网地址");
        }
        int port = url.getPort() < 0 ? 80 : url.getPort();
        String path = url.getFile().isEmpty() ? "/" : url.getFile();
        if (path.indexOf('\r') >= 0 || path.indexOf('\n') >= 0
                || path.indexOf(' ') >= 0 || !path.startsWith("/")) {
            throw new IOException("无效的 DLNA 请求路径");
        }
        String headers = (body == null ? "GET " : "POST ") + path + " HTTP/1.1\r\n"
                + "Host: " + url.getHost() + (port == 80 ? "" : ":" + port) + "\r\n"
                + "Connection: close\r\nAccept-Encoding: identity\r\n"
                + "User-Agent: LibreTV Android DLNA/1.0\r\n";
        if (body != null) {
            headers += "Content-Type: text/xml; charset=\"utf-8\"\r\n"
                    + "SOAPACTION: " + soapAction + "\r\nContent-Length: " + body.length + "\r\n";
        }
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(address, port), connectTimeout);
            socket.setSoTimeout(readTimeout);
            OutputStream out = new BufferedOutputStream(socket.getOutputStream());
            out.write((headers + "\r\n").getBytes(StandardCharsets.US_ASCII));
            if (body != null) out.write(body);
            out.flush();
            return readResponse(new BufferedInputStream(socket.getInputStream()));
        }
    }

    private static Response readResponse(InputStream in) throws IOException {
        int status;
        int contentLength;
        boolean chunked;
        do {
            String[] first = line(in).split(" ", 3);
            if (first.length < 2 || !first[0].startsWith("HTTP/")) {
                throw new IOException("无效的 DLNA HTTP 响应");
            }
            status = number(first[1], 10);
            contentLength = -1;
            chunked = false;
            int headerBytes = 0;
            for (String header = line(in); !header.isEmpty(); header = line(in)) {
                headerBytes += header.length();
                if (headerBytes > 32768) throw new IOException("DLNA 响应头过大");
                int colon = header.indexOf(':');
                if (colon < 0) continue;
                String value = header.substring(colon + 1).trim();
                String name = header.substring(0, colon);
                if ("Content-Length".equalsIgnoreCase(name)) contentLength = number(value, 10);
                if ("Transfer-Encoding".equalsIgnoreCase(name)) chunked = "chunked".equalsIgnoreCase(value);
            }
        } while (status == 100);
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        if (status != 204 && status != 304) {
            if (chunked) {
                for (int size = chunkSize(in); size > 0; size = chunkSize(in)) {
                    readBody(in, body, size);
                    if (!line(in).isEmpty()) throw new IOException("无效的 DLNA HTTP 分块");
                }
            } else {
                readBody(in, body, contentLength);
            }
        }
        return new Response(status, body.toString("UTF-8"));
    }

    private static int chunkSize(InputStream in) throws IOException {
        String header = line(in);
        int extension = header.indexOf(';');
        return number((extension < 0 ? header : header.substring(0, extension)).trim(), 16);
    }

    private static int number(String value, int radix) throws IOException {
        try {
            int number = Integer.parseInt(value, radix);
            if (number >= 0) return number;
        } catch (NumberFormatException ignored) { }
        throw new IOException("无效的 DLNA HTTP 数值");
    }

    private static void readBody(InputStream in, ByteArrayOutputStream body, int remaining) throws IOException {
        byte[] buffer = new byte[4096];
        while (remaining != 0) {
            int length = in.read(buffer, 0, remaining < 0 ? buffer.length : Math.min(buffer.length, remaining));
            if (length < 0) {
                if (remaining > 0) throw new EOFException("DLNA HTTP 响应不完整");
                return;
            }
            if (body.size() + length > MAX_BODY) throw new IOException("DLNA HTTP 响应过大");
            body.write(buffer, 0, length);
            if (remaining > 0) remaining -= length;
        }
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        for (int value = in.read(); value != -1; value = in.read()) {
            if (value == '\n') return buffer.toString("ISO-8859-1");
            if (buffer.size() == MAX_LINE) throw new IOException("DLNA HTTP 响应头行过长");
            if (value != '\r') buffer.write(value);
        }
        throw new EOFException("DLNA HTTP 响应不完整");
    }
}
