/**
 * Even's official G1 firmware, which an uninstall puts back: both images of one public release, the application core's
 * and the network core's (the Bluetooth controller), as Even's own update installs them, so the two always match.
 * From Even's CDN, checked against these SHA-256 sums (scouter_kit g1_firmware/stock_images.txt). Every public image
 * says 0.0.0 in its MCUboot header, so the hashes are the only way to tell releases apart.
 */
export type EvenG1Release = {
  version: string;
  zipUrl: string;
  zipSha256: string;
  appSha256: string;
  netCoreSha256: string;
};

export const EVEN_G1_RESTORE: EvenG1Release = {
  version: "1.6.6",
  zipUrl: "https://cdn.evenreal.co/firmware/dcfa510c090e476c10a6f6c348a22415.zip",
  zipSha256: "748836f2d9d092b0783cbb7672fdccec4f730051cad27f095bbb156ac3e5d316",
  appSha256: "ae032838e27037156da98e19de90df78f5406715751f3b38adf50498db3010c1",
  netCoreSha256: "c277749be97a2763742db399afeb10ca6916059abd60d41bbc05c8892c002c77",
};
