Acknowledgements
================

Faceclaw is an open source project, at https://github.com/jimrandomh/faceclaw.
Contributors include:
    James Babcock <jimrandomh@gmail.com>
    Kalani Helekunihi <i@am.guru>


Many thanks to g2-kit-unofficial: https://github.com/Commute773/g2-kit-unofficial/,
evenRealities-openCFW https://github.com/kalanihelekunihi/evenRealities-openCFW/,
and others who contributed to documenting the G2's bluetooth protocol and firmware.

G2 microphone LC3 decoding uses Google's liblc3: https://github.com/google/liblc3

Even G1 support builds on ScouterKit (MIT License), by the ScouterKit authors:
https://github.com/mafik/scouter_kit. The firmware Faceclaw installs on a G1 is a
modified build of its g1v0, using the Zephyr RTOS and Nordic's nRF Connect SDK; the
parts of it that are Even Realities' own are downloaded from Even, not shipped here.

RayNeo iO support builds on the Glassly SDK and custom firmware by Tetramo, Inc.
and Mentra Labs, Inc. (MIT License): https://github.com/tetramo-labs/glassly and
https://github.com/tetramo-labs/glassly-rayneo-cfw. The iO wire codecs in
native/kotlin/shared/.../rayneo/RayNeoIoProtocol.kt follow their protocol work.

iPhone notification icons are Pebble's notification and timeline icons, from
https://github.com/pebble-dev/iconography: the original Pebble Technology icons
and Rebble community additions. They are licensed under the Apache License 2.0;
see app/graphics/pebble-icons.LICENSE. Faceclaw's table of the iPhone apps they
stand for builds on the one in the PebbleOS firmware,
https://github.com/coredevices/PebbleOS (also Apache License 2.0).

The browser demo draws its fonts with opentype.js (MIT License):
https://github.com/opentypejs/opentype.js.

Weather data outside the US is by Open-Meteo.com: https://open-meteo.com/. It is
licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

The Terminus font is by Dimitar Zhekov's Terminus: https://framagit.org/ohnonot/terv-terc
and is distributed under the SIL Open Font License; see app/fonts/terminus/LICENSE.

The TerminusV proportional font is by ohnonot, derived from Terminus:
https://framagit.org/ohnonot/terv-terc. It is also distributed under the SIL
Open Font License; see app/fonts/terminusv/LICENSE.

The CJK font is Source Han Sans SC Light by Adobe:
https://github.com/adobe-fonts/source-han-sans. It is distributed under the SIL
Open Font License, Version 1.1; see app/fonts/source-han-sans/LICENSE.txt.
Faceclaw includes the G2's serialized 20 px LVGL build of the font so
phone-side rendering matches the glasses.
