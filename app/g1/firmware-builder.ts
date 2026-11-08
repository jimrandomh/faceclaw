/**
 * Prepares the g1v0 image on the phone, as app/g2/firmware-builder.ts does for a G2: downloads Even's public firmware,
 * checks it, and puts the parts this firmware embeds back into what the app ships. The result is byte for byte the
 * image that was built, tested and signed, and it is checked to be. Also prepares Even's own images for an uninstall.
 * It does not touch the glasses.
 */
import { knownFolders } from "@nativescript/core";

import { firmwareSha256, writeFirmwareFile } from "../native/firmware-files";
import { decodeBase64 } from "../util/base64";
import { fetchWithUserAgent } from "../util/http";
import { EVEN_G1_RESTORE } from "./even-firmware";
import { G1V0_IMAGE } from "./firmware/g1v0-image";
import { G1V0_OWN_BYTES_BASE64 } from "./firmware/g1v0-own-bytes";
import { assembleG1Image, decodeG1OwnBytes, extractEvenG1Images, G1FirmwareError, readZipEntry } from "./firmware-image";

export type G1BuildProgress = "downloading" | "verifying" | "assembling" | "writing";

export type BuiltG1Firmware = { path: string; bytes: number; version: string };

/** Even's release for an uninstall: the application core's image and the network core's. */
export type BuiltEvenG1Firmware = { appPath: string; netCorePath: string; bytes: number; version: string };

function sha256(bytes: Uint8Array): string {
  return firmwareSha256(bytes.slice().buffer);
}

async function downloadStockZip(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchWithUserAgent(url);
  } catch (error) {
    throw new G1FirmwareError(`Could not reach Even's firmware server: ${(error as Error)?.message ?? error}`);
  }
  if (!response.ok) throw new G1FirmwareError(`The firmware download failed (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function buildG1Firmware(onProgress?: (progress: G1BuildProgress) => void): Promise<BuiltG1Firmware> {
  onProgress?.("downloading");
  const zip = await downloadStockZip(G1V0_IMAGE.stockZipUrl);

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

export async function buildEvenG1Firmware(onProgress?: (progress: G1BuildProgress) => void): Promise<BuiltEvenG1Firmware> {
  onProgress?.("downloading");
  const zip = await downloadStockZip(EVEN_G1_RESTORE.zipUrl);

  onProgress?.("verifying");
  const { app, netCore } = extractEvenG1Images(zip, EVEN_G1_RESTORE, sha256);

  onProgress?.("writing");
  const folder = knownFolders.documents().path;
  const appPath = `${folder}/even_g1_${EVEN_G1_RESTORE.version}_app.bin`;
  const netCorePath = `${folder}/even_g1_${EVEN_G1_RESTORE.version}_net.bin`;
  writeFirmwareFile(appPath, app.slice().buffer);
  writeFirmwareFile(netCorePath, netCore.slice().buffer);
  return { appPath, netCorePath, bytes: app.length + netCore.length, version: EVEN_G1_RESTORE.version };
}
