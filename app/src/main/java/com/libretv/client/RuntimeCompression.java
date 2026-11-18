package com.libretv.client;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.GZIPInputStream;

import org.tukaani.xz.XZInputStream;

final class RuntimeCompression {
    private RuntimeCompression() {}

    static InputStream open(InputStream asset) throws IOException {
        BufferedInputStream input = new BufferedInputStream(asset, 32768);
        input.mark(2);
        int first = input.read();
        int second = input.read();
        input.reset();
        if (first == 0x1f && second == 0x8b) return new GZIPInputStream(input);
        if (first == 0xfd && second == 0x37) return new XZInputStream(input, 16 * 1024);
        throw new IOException("无法识别的运行包压缩格式");
    }
}
