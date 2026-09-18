package com.faceclaw.app;

/** Production Android encoder oracle for the iOS transport parity test. */
public final class CfwTransportVectors {
    public static void main(String[] args) {
        CfwTransport transport = new CfwTransport();
        for (String line : args) {
            String[] fields = line.split(":", -1);
            if (fields[0].equals("reset")) { transport.reset(); continue; }
            int id = Integer.parseInt(fields[0]), lenses = Integer.parseInt(fields[1]);
            int maxWrite = Integer.parseInt(fields[2]);
            byte[] payload = java.util.HexFormat.of().parseHex(fields[3]);
            StringBuilder result = new StringBuilder();
            for (byte[] packet : transport.encode(payload, id, lenses, maxWrite + 3))
                result.append(java.util.HexFormat.of().formatHex(packet)).append(" ");
            System.out.println(result.toString().trim());
        }
    }
}
