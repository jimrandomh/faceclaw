/// <reference path="./node_modules/@nativescript/types/index.d.ts" />
/** True only in the browser demo (app/web/); scripts/build-web.mjs defines it, and the phones leave it undefined. */
// oxlint-disable-next-line no-var -- a global's type is only declared this way
declare var isWeb: boolean | undefined;
