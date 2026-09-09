package com.faceclaw.sdk;

/** Pure lifecycle reducer, usable in JVM tests and app services. No frame or Android objects retained. */
public final class WindowState {
    private int width, height;
    private long generation;
    private boolean visible, screenOn;
    public int width() { return width; }
    public int height() { return height; }
    public long generation() { return generation; }
    public boolean canDraw() { return visible && screenOn && width > 0 && height > 0; }
    public void accept(HostEvent event) {
        if (event instanceof HostEvent.Window) {
            HostEvent.Window window = (HostEvent.Window) event;
            width = window.width; height = window.height; generation = window.generation;
            if (window.isOpen()) { visible = false; screenOn = false; }
        } else if (event instanceof HostEvent.Visibility) {
            HostEvent.Visibility state = (HostEvent.Visibility) event;
            visible = state.visible; screenOn = state.screenOn;
        } else if (event instanceof HostEvent.Signal && event.type.equals("close")) {
            disconnect();
        }
    }
    public void disconnect() { width = height = 0; generation = 0; visible = screenOn = false; }
}
