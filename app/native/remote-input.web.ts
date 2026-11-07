/** No inbound control server in a browser; the demo's page is the remote. */
import type { InterfaceAddress } from "../remote/listeners";

export function remoteNative(_onRequestReady: () => void): any { return null; }
export function remoteInterfaces(): InterfaceAddress[] { return []; }
export function randomTokenSecret(): string { return ""; }
export function tokenHash(_value: string): string { return ""; }
export function copyRemoteToken(_value: string): void {}
