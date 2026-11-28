#!/usr/bin/env bash
# Downloads the lexicon's sources into $1 (default: sources/ here), checks the pinned ones and
# unpacks them as the data tool reads them. See README.md.
set -euo pipefail
dir="${1:-$(dirname "$0")/sources}"
mkdir -p "$dir"
cd "$dir"
# AOSP LatinIME word lists (Apache-2.0), pinned to a commit.
AOSP=127336e9f29d69607eab55982324b210279ae8c5
for list in en_US pt_BR; do
  curl -sSL "https://android.googlesource.com/platform/packages/inputmethods/LatinIME/+/$AOSP/dictionaries/${list}_wordlist.combined.gz?format=TEXT" \
    | base64 -d > "${list}_wordlist.combined.gz"
done
sha256sum -c - <<'SUMS'
0f78dd455b532be169a23f233227b811fabced4b5bd7fc9c40cc05839793bcbd  en_US_wordlist.combined.gz
f9b7c2f610eacebc782c7d24e64d8ad2620b449defbac326507dfb5702c6c48b  pt_BR_wordlist.combined.gz
SUMS
# Tatoeba sentences (CC BY 2.0 FR). The exports change weekly: their hashes go into the
# manifest the tool writes, not checked here.
for lang in eng por; do
  curl -sSL -o "${lang}_sentences.tsv.bz2" "https://downloads.tatoeba.org/exports/per_language/${lang}/${lang}_sentences.tsv.bz2"
done
for list in en_US pt_BR; do zcat "${list}_wordlist.combined.gz" > "${list}_wordlist.combined"; done
for lang in eng por; do bzcat "${lang}_sentences.tsv.bz2" > "${lang}_sentences.tsv"; done
echo "sources in $dir"
