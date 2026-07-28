# Changelog

What shipped, newest first.

This file starts empty on purpose. History from before it existed is not
back-filled, so an empty list means nothing has shipped since the file was
created; it does not mean the work is missing. Add a release when you ship it.

## Format

The desktop welcome screen parses this file, so the shape is load bearing:

    ## 0.9.0 - 2026-08-01
    - One line per change.
    - Say what changed for a player, not which file moved.

Rules the parser follows:

- A release is a `##` line whose first word starts with a digit (a leading `v`
  is allowed). Everything after `-` on that line is the date, shown as written.
- The `-` lines under a release are its entries. The list ends at the next
  release heading.
- Every other line is prose and is ignored, including this section. A malformed
  file yields no releases rather than an error.

Releases go directly below this line, newest first.

## 1.4.0 - 2026-07-28

- nodechess runs on Linux: an AppImage for any distribution, or a .deb for Debian, Ubuntu and Mint. Both are 64 bit.
- Stockfish analysis is not available on Linux yet, because there is no Linux engine build to import. Settings, Datasets offers the puzzle database only. Online play, the 20+ board games and the puzzles all work.
- The download page offers the Linux build to visitors on Linux, instead of telling them there is nothing for them.
- A browser we cannot identify is offered Windows rather than Linux, so an unrecognised machine gets the build it is most likely to be able to run.
- Downloads are named nodechess rather than Chess, matching the rename. Older releases keep their original names and still install.
