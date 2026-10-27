"""The recording the "Add to Scratchpad" suite runs on.

test/wdio/specs/panels/scratchpad-add.e2e.ts double-clicks the Call Trace row
of `check` and adds editor selections at that stop. `board` is a local there,
and it is a list of rows, so `board[0]` is an expression the replay can
evaluate (an index into a recorded value) while `board.no_such_field` is one
it must refuse. Recorded by `scripts/record-test-traces.sh python-scratchpad`.
"""


def check(board):
    first = board[0]
    return len(first)


def main():
    board = [[5, 3, 0], [6, 0, 0], [0, 9, 8]]
    print(f"first row has {check(board)} cells")


main()
