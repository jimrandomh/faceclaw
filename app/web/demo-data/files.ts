import { DOCUMENTS_ROOT, fileExists, textToBytes, writeFile } from "../vfs";

/** What the Files and Teleprompter apps open to on a first visit. */
const SAMPLE_FILES: Record<string, string> = {
  "Documents/Welcome.txt": `Welcome to the Faceclaw demo.

Everything on this display is the real app, compiled for your browser. Only the hardware is missing: no glasses, no ring, no phone. Your notifications, calendar and music here are made up, so poke at anything you like.

Scroll with the wheel or arrow keys.
Tap to select.
Double-tap to go back.
Hold for the system menu.
`,
  "Documents/Reading on glasses.txt": `Why read on your face?

A phone demands that you look down at it. Glasses don't: the text sits a little above the middle of what you are already looking at, and it goes away when you stop asking for it.

The G2 shows 16 shades of green on a transparent panel, so black is not dark, it is simply nothing. Good interfaces for this display draw very little: a line of text, a highlight, an icon. Everything else stays the world.

Reading long documents on it is better than you would expect, and walking while doing so is safer than you would fear. Your mileage may vary, and please look both ways. `,
  "Scripts/Keynote.txt": `Good morning, and thank you all for coming.

Three years ago, we asked a simple question. What would it take for a computer to help you without asking for your attention first?

Every device we own today begins the same way: you stop what you are doing, you look down, and you give it your eyes and your hands. We wanted to try the opposite, so we started from the smallest display we could get away with.

You are looking at one right now. It has no camera. It has no speaker to speak of. It has a ring, a few hundred pixels of green light, and an operating system small enough to explain in an afternoon.

Here is what surprised us. People kept it on. Not because it did anything impressive, but because it mostly did nothing, and then, at the moment it mattered, it told them one thing.

That is the whole idea. Thank you.
`,
  "Scripts/Toast.txt": `For those who don't know me, I've known these two since before either of them could parallel park, which I'm told one of them still can't.

When they told me they were getting married, I wasn't surprised. I've watched them argue about the correct way to load a dishwasher for eleven years, and neither of them has ever once wanted to stop.

So please raise your glasses. To a lifetime of being wrong together, happily, and very loudly. Cheers. `,
  "Notes/Packing list.txt": `Portland trip

- Rain jacket
- Charging case
- The good umbrella
- Book I will not read
- Other book I will not read
`,
};

export function seedDemoFiles(): void {
  for (const [path, text] of Object.entries(SAMPLE_FILES)) {
    const fullPath = `${DOCUMENTS_ROOT}/${path}`;
    if (!fileExists(fullPath)) writeFile(fullPath, textToBytes(text));
  }
}
