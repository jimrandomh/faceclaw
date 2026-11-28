# writing-data

Builds `writing.lex`, the lexicon of the suggestions while writing with the band (the `writing`
crate), and its manifest `writing.json`, into the glasses app's assets.

```sh
./fetch.sh                      # sources into ./sources (gitignored), the AOSP lists checked
cargo run --release -p writing-data -- sources \
  ../../app/src/main/assets/writing/writing.lex ../../app/src/main/assets/writing/writing.json
```

Sources:

- **AOSP LatinIME word lists** (`en_US`, `pt_BR`; Apache-2.0), pinned to a commit in
  `fetch.sh`: the words, their spellings and frequencies; the ones flagged offensive are kept
  but never suggested. Portuguese gets the 2009 spelling the list predates (idéia -> ideia,
  vôo -> voo, freqüente -> frequente, pára -> para, auto-estima -> autoestima).
- **Tatoeba sentences** (`eng`, `por`; CC BY 2.0 FR, https://tatoeba.org): how often each word
  comes in everyday sentences and which word follows which. The exports change weekly; the
  manifest records the hashes of the ones used.

80,000 words per language and the likeliest 12 next words of each frequent word: about 5 MB,
2.3 MB compressed in the APK.
