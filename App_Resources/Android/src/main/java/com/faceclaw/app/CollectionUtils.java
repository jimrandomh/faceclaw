package com.faceclaw.app;
import java.util.ArrayList;
import java.util.List;

public class CollectionUtils {
    public static List<byte[]> singletonList(byte[] value) {
        List<byte[]> list = new ArrayList<>(1);
        list.add(value);
        return list;
    }

    public static List<byte[]> listOf(byte[] a, byte[] b) {
        List<byte[]> list = new ArrayList<>(2);
        list.add(a);
        list.add(b);
        return list;
    }

    public static List<byte[]> listOf(byte[] a, byte[] b, byte[] c) {
        List<byte[]> list = new ArrayList<>(3);
        list.add(a);
        list.add(b);
        list.add(c);
        return list;
    }
}
