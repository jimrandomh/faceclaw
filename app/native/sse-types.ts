export type SseListener = {
  onLine(line: string): void;
  onHttpError(code: number, body: string): void;
  onComplete(): void;
  onFailure(message: string): void;
};
