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
