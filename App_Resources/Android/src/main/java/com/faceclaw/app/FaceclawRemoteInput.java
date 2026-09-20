package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import org.json.JSONArray;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.json.JSONObject;

/** Explicit-address, bounded, one-request-per-connection input port. JS polls on its own thread. */
public final class FaceclawRemoteInput {
    private static final FaceclawRemoteInput INSTANCE = new FaceclawRemoteInput();
    public static FaceclawRemoteInput getInstance() { return INSTANCE; }
    private ServerSocket server;
    private Socket client;
    private String pending, reply;
    private long nextId, requestId;
    private long deadline;

    public synchronized String start(int port) { return startAddress(port, "127.0.0.1"); }
    public synchronized String startAddress(int port, String address) {
        if (server != null) return "";
        try {
            // Numeric local addresses only; never resolve hostnames or bind a wildcard.
            if (!address.matches("[0-9.]+|[0-9a-fA-F]*:[0-9a-fA-F:.]*(%[a-zA-Z0-9_.-]+)?")) return "Invalid local address.";
            InetAddress local = InetAddress.getByName(address);
            if (local.isAnyLocalAddress() || local.isMulticastAddress() || NetworkInterface.getByInetAddress(local) == null)
                return "Address is not assigned to a local interface.";
            ServerSocket listener = new ServerSocket(port, 8, local);
            server = listener;
            Thread thread = new Thread(() -> serve(listener), "FaceclawInput");
            thread.setDaemon(true);
            thread.start();
            return "";
        } catch (Exception e) { return "Could not open local input port " + port + "."; }
    }
    public synchronized void stop() {
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        try { if (client != null) client.close(); } catch (Exception ignored) {}
        server = null; client = null; pending = null; requestId = 0; reply = null;
        notifyAll();
    }
    public synchronized String nextRequest() {
        if (System.currentTimeMillis() >= deadline) { pending = null; return null; }
        String result = pending; pending = null; return result;
    }
    public synchronized void complete(long id, String value) {
        if (id == requestId && System.currentTimeMillis() < deadline) { reply = value; notifyAll(); }
    }
    private void serve(ServerSocket listener) {
        while (!listener.isClosed()) {
            try (Socket socket = listener.accept()) {
                synchronized (this) { if (server != listener) return; client = socket; }
                socket.setSoTimeout(5000);
                socket.setTcpNoDelay(true);
                long readDeadline = System.currentTimeMillis() + 5000;
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                int b;
                for (;;) {
                    long remaining = readDeadline - System.currentTimeMillis();
                    if (remaining <= 0) throw new Exception("Read timeout");
                    socket.setSoTimeout((int) remaining);
                    b = socket.getInputStream().read();
                    if (b == -1 || b == '\n') break;
                    if (body.size() >= 65536) throw new Exception("Invalid frame");
                    body.write(b);
                }
                if (b != '\n') continue;
                String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(body.toByteArray())).toString();
                String response;
                synchronized (this) {
                    if (server != listener) return;
                    requestId = ++nextId;
                    deadline = System.currentTimeMillis() + 5000;
                    reply = null;
                    pending = new JSONObject().put("id", requestId).put("expiresAt", deadline)
                        .put("body", text).toString();
                    while (reply == null && server == listener && System.currentTimeMillis() < deadline) {
                        wait(Math.max(1, deadline - System.currentTimeMillis()));
                    }
                    response = reply != null ? reply : "{\"ok\":false,\"error\":\"timeout\",\"message\":\"Faceclaw did not respond in time.\"}";
                    if (server == listener) { pending = null; reply = null; requestId = 0; }
                }
                socket.getOutputStream().write((response + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                // Never log request bodies: they contain credentials and possibly private text.
            } finally {
                synchronized (this) { if (server == listener) client = null; }
            }
        }
    }
    public static String interfaces() {
        JSONArray result = new JSONArray();
        try {
            for (NetworkInterface device : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!device.isUp()) continue;
                for (InetAddress address : Collections.list(device.getInetAddresses())) {
                    if (address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isAnyLocalAddress()) continue;
                    result.put(new JSONObject().put("name", device.getName()).put("address", address.getHostAddress())
                        .put("pointToPoint", device.isPointToPoint()));
                }
            }
        } catch (Exception ignored) {}
        return result.toString();
    }
    public String randomSecret() {
        byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return hex(bytes);
    }
    public String hash(String value) {
        try { return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException("SHA-256 unavailable", e); }
    }
    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
}
