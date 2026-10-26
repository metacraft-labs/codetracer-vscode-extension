"""A program whose recording is longer than one window of the panels.

The WDIO panel suites (test/wdio/specs/panels/) run on its recording
(scripts/record-test-traces.sh python-panels): 200 calls of `square` and `report`
under `main` give the Call Trace several hundred rows, and the 201 lines it
prints give the Event Log 201 events, both far more than either panel shows
at once, so a scroll has to fetch rows the first window did not hold.
"""


def square(n):
    return n * n


def report(i, value):
    print(f"step {i}: {value}")
    return value


def main():
    total = 0
    for i in range(200):
        total += report(i, square(i))
    print(f"total {total}")


main()
