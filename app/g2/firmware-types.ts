export type FlashState = "validating" | "connecting" | "flashing" | "rebooting" | "done" | "error";

export type FlashProgress = {
  lens: string;
  componentIndex: number;
  componentCount: number;
  blockIndex: number;
  blockCount: number;
  /** Bytes flashed so far across the whole lens image — the size-weighted progress signal. */
  bytesSent: number;
  bytesTotal: number;
};

