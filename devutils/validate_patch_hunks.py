#!/usr/bin/env python3
"""Validate that every unified-diff hunk header's line counts match the body.

Used as a CI-free sanity check for hand-edited .patch files in this repo: for
each `@@ -a,b +c,d @@` hunk it counts the actual '-'/' ' (old) and '+'/' ' (new)
lines in the hunk body and asserts they equal b and d. Pass the patch paths as
argv; exits non-zero on any mismatch.
"""
import re
import sys

HDR = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


def check(path):
    text = open(path, encoding='utf-8').read()
    # A trailing newline yields a spurious empty final element from split('\n');
    # drop it so the last hunk's line count isn't over-counted by one.
    if text.endswith('\n'):
        text = text[:-1]
    lines = text.split('\n')
    i = 0
    ok = True
    nh = 0
    while i < len(lines):
        m = HDR.match(lines[i])
        if not m:
            i += 1
            continue
        nh += 1
        old_exp = int(m.group(2)) if m.group(2) is not None else 1
        new_exp = int(m.group(4)) if m.group(4) is not None else 1
        i += 1
        old = new = 0
        while i < len(lines):
            l = lines[i]
            if HDR.match(l):
                break
            if l.startswith('--- ') or l.startswith('+++ ') or l.startswith('diff '):
                break
            if l.startswith('+'):
                new += 1
            elif l.startswith('-'):
                old += 1
            elif l.startswith(' '):
                old += 1
                new += 1
            elif l == '':
                old += 1
                new += 1
            elif l.startswith('\\'):
                pass  # "\ No newline at end of file"
            else:
                break
            i += 1
        if old != old_exp or new != new_exp:
            ok = False
            print(f'MISMATCH {path}: hunk#{nh} header old={old_exp} '
                  f'new={new_exp} actual old={old} new={new} (near line {i})')
    print(f'{path}: checked {nh} hunks; '
          f'{"ALL CONSISTENT" if ok else "FAILURES ABOVE"}')
    return ok


if __name__ == '__main__':
    all_ok = True
    for p in sys.argv[1:]:
        all_ok = check(p) and all_ok
    sys.exit(0 if all_ok else 1)
