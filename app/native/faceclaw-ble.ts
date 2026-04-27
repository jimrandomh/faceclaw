import { Utils } from "@nativescript/core";

declare const com: any;

type NotificationListener = (address: string, characteristicUuid: string, data: Uint8Array) => void;
type ConnectionListener = (address: string, connected: boolean) => void;

function toUint8Array(bytes: ArrayLike<number> | null | undefined): Uint8Array {
  if (!bytes) return new Uint8Array(0);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i]! & 0xff;
  }
  return out;
}

function toJavaByteArray(bytes: Uint8Array): number[] {
  const out = Array.create("byte", bytes.length) as number[];
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    out[i] = value > 127 ? value - 256 : value;
  }
  return out;
}

function toJavaByteList(frames: Uint8Array[]): any {
  const list = new java.util.ArrayList();
  for (const frame of frames) {
    list.add(toJavaByteArray(frame));
  }
  return list;
}

export class FaceclawBleBridge {
  private readonly manager: any;
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly listenerProxy: any;

  constructor() {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");

    this.manager = new com.faceclaw.app.FaceclawBleManager(context);
    this.listenerProxy = new com.faceclaw.app.FaceclawBleListener({
      onNotification: (address: string, characteristicUuid: string, data: ArrayLike<number>) => {
        const bytes = toUint8Array(data);
        for (const listener of this.notificationListeners) {
          listener(String(address), String(characteristicUuid), bytes);
        }
      },
      onConnectionStateChange: (address: string, connected: boolean) => {
        for (const listener of this.connectionListeners) {
          listener(String(address), Boolean(connected));
        }
      },
    });
    this.manager.setListener(this.listenerProxy);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onConnectionStateChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async connect(address: string, timeoutMs: number): Promise<void> {
    if (!this.manager.connect(address, timeoutMs)) {
      throw new Error(`connect failed: ${address}`);
    }
  }

  async requestMtu(address: string, mtu: number, timeoutMs: number): Promise<void> {
    if (!this.manager.requestMtu(address, mtu, timeoutMs)) {
      throw new Error(`requestMtu failed: ${address}`);
    }
  }

  async requestConnectionPriority(address: string, priority: number): Promise<void> {
    if (!this.manager.requestConnectionPriority(address, priority)) {
      throw new Error(`requestConnectionPriority failed: ${address} ${priority}`);
    }
  }

  async discoverServices(address: string, timeoutMs: number): Promise<void> {
    if (!this.manager.discoverServices(address, timeoutMs)) {
      throw new Error(`discoverServices failed: ${address}`);
    }
  }

  async enableNotifications(
    address: string,
    characteristicUuid: string,
    enable: boolean,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.manager.enableNotifications(address, characteristicUuid, enable, timeoutMs)) {
      throw new Error(`enableNotifications failed: ${address} ${characteristicUuid}`);
    }
  }

  async writeCharacteristic(
    address: string,
    characteristicUuid: string,
    data: Uint8Array,
    writeType: number,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.manager.write(address, characteristicUuid, toJavaByteArray(data), writeType, timeoutMs)) {
      throw new Error(`write failed: ${address} ${characteristicUuid}`);
    }
  }

  async writeCharacteristicFrames(
    address: string,
    characteristicUuid: string,
    frames: Uint8Array[],
    writeType: number,
    timeoutMs: number,
    allowFallback: boolean,
    interFrameDelayMs: number,
  ): Promise<void> {
    if (
      !this.manager.writeFrames(
        address,
        characteristicUuid,
        toJavaByteList(frames),
        writeType,
        timeoutMs,
        allowFallback,
        interFrameDelayMs,
      )
    ) {
      throw new Error(`write frames failed: ${address} ${characteristicUuid}`);
    }
  }

  async queueCharacteristicFrames(
    address: string,
    characteristicUuid: string,
    frames: Uint8Array[],
    writeType: number,
    timeoutMs: number,
    allowFallback: boolean,
    interFrameDelayMs: number,
  ): Promise<void> {
    if (
      !this.manager.queueWriteFrames(
        address,
        characteristicUuid,
        toJavaByteList(frames),
        writeType,
        timeoutMs,
        allowFallback,
        interFrameDelayMs,
      )
    ) {
      throw new Error(`queue write frames failed: ${address} ${characteristicUuid}`);
    }
  }

  async disconnect(address: string): Promise<void> {
    this.manager.disconnect(address);
  }

  async close(): Promise<void> {
    this.manager.close();
  }
}
