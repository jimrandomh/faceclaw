/**
 * Prepares the g1v0 image on the phone, as app/g2/firmware-builder.ts does for a G2: downloads Even's public firmware,
 * checks it, and puts the parts this firmware embeds back into what the app ships. The result is byte for byte the
 * image that was built, tested and signed, and it is checked to be. It does not touch the glasses.
 */
import { knownFolders } from "@nativescript/core";

import { firmwareSha256, writeFirmwareFile } from "../native/firmware-files";
import { decodeBase64 } from "../util/base64";
import { fetchWithUserAgent } from "../util/http";
import { G1V0_IMAGE } from "./firmware/g1v0-image";
import { G1V0_OWN_BYTES_BASE64 } from "./firmware/g1v0-own-bytes";
import { assembleG1Image, decodeG1OwnBytes, G1FirmwareError, readZipEntry } from "./firmware-image";

export type G1BuildProgress = "downloading" | "verifying" | "assembling" | "writing";

export type BuiltG1Firmware = { path: string; bytes: number; version: string };

function sha256(bytes: Uint8Array): string {
  return firmwareSha256(bytes.slice().buffer);
}

async function downloadStockZip(): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchWithUserAgent(G1V0_IMAGE.stockZipUrl);
  } catch (error) {
    throw new G1FirmwareError(`Could not reach Even's firmware server: ${(error as Error)?.message ?? error}`);
  }
  if (!response.ok) throw new G1FirmwareError(`The firmware download failed (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function buildG1Firmware(onProgress?: (progress: G1BuildProgress) => void): Promise<BuiltG1Firmware> {
  onProgress?.("downloading");
  const zip = await downloadStockZip();

  onProgress?.("verifying");
  const zipHash = sha256(zip);
  if (zipHash !== G1V0_IMAGE.stockZipSha256) {
    throw new G1FirmwareError(`Even's firmware download failed verification.\nexpected ${G1V0_IMAGE.stockZipSha256}\ngot      ${zipHash}`);
  }

  onProgress?.("assembling");
  const own = decodeG1OwnBytes(G1V0_OWN_BYTES_BASE64, decodeBase64);
  const image = assembleG1Image(G1V0_IMAGE, own, (name) => readZipEntry(zip, name), sha256);

  onProgress?.("writing");
  const path = `${knownFolders.documents().path}/g1v0_${G1V0_IMAGE.version}.bin`;
  writeFirmwareFile(path, image.slice().buffer);
  return { path, bytes: image.length, version: G1V0_IMAGE.version };
}
