import json, sys

# Reads the extension perf trail (extension-perf.jsonl, one snapshot per ~5s)
# and surfaces the metrics that matter for the Firefox unresponsive-script
# freeze: main-thread CPU share, long-task counts, and the cost of the two
# badge-positioning paths during scroll.
#
#   tail -f "<browser-plugin-dir>/extension-perf.jsonl" | python3 scripts/_watch-perf.py
#   cat       "<browser-plugin-dir>/extension-perf.jsonl" | python3 scripts/_watch-perf.py
#
# longtask.* and the cpu.buckets are cumulative per content-script frame, so we
# show the delta within a single URL's sample sequence (the trail interleaves
# watch page, chat iframe, studio, accounts — each with its own counters).

def bucket(cpu, name):
    b = (cpu.get("buckets") or {}).get(name) or {}
    return b.get("count", 0), b.get("totalMs", 0.0)

rows = []
prev_by_url = {}
for line in sys.stdin:
    try:
        e = json.loads(line)
    except Exception:
        continue
    s = e.get("snapshot") or {}
    cpu = s.get("cpu") or {}
    lt = cpu.get("longtask") or {}
    url = e.get("url", "")
    cur = {
        "ltCount": lt.get("count", 0),
        "ltTotal": lt.get("totalMs", 0.0),
        "reposCount": bucket(cpu, "placeBadges:reposition")[0],
        "reposMs": bucket(cpu, "placeBadges:reposition")[1],
        "scrollCount": bucket(cpu, "placeBadges:scroll")[0],
        "scrollMs": bucket(cpu, "placeBadges:scroll")[1],
    }
    prev = prev_by_url.get(url)
    prev_by_url[url] = cur
    if prev is None:
        continue
    d = {k: cur[k] - prev[k] for k in cur}
    if any(v < 0 for v in d.values()):
        continue  # counter reset (frame reload)
    pct = ((cpu.get("share") or {}).get("pct")) or 0
    ltMax = lt.get("maxMs", 0)
    if d["scrollCount"] == 0 and d["reposCount"] == 0 and pct == 0 and d["ltCount"] == 0:
        continue  # idle window
    rows.append((e.get("ts", "")[11:23], url[:38], pct, ltMax, d))

for ts, url, pct, ltMax, d in rows[-30:]:
    print("t={} {:>38} cpu={:>5}% | longtask Δcount={:>3} max={:>4}ms Δtotal={:>6.0f}ms | "
          "scroll-trim Δ{:>3} fires/{:>6.0f}ms | full-replace Δ{:>3} fires/{:>6.0f}ms".format(
              ts, url, pct, d["ltCount"], ltMax, d["ltTotal"],
              d["scrollCount"], d["scrollMs"], d["reposCount"], d["reposMs"]))

if rows:
    tot_lt = sum(d["ltCount"] for *_, d in rows)
    max_lt = max((ltMax for *_, ltMax, _ in rows), default=0)
    print("--- {} active windows | longtasks total={} maxMs={} ---".format(len(rows), tot_lt, max_lt))
    print("(want: longtasks ~0, max well under ~50ms, cpu% low during scroll)")
else:
    print("--- no active (non-idle) windows in trail yet ---")
