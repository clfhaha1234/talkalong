#!/usr/bin/env python3
"""Render the 3 charts for this experiment. Custom because /auto-lab's
chart.py assumes all arms run on test; we run only baseline + iter3 on
test (per Phase 5 discipline)."""
import json
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

INK = "#222222"
WIN = "#2E7D32"
LOSS = "#C62828"
MUTED = "#9E9E9E"

data = json.load(open("data.json"))
os.makedirs("charts", exist_ok=True)

# --------- Chart 1: arm-bar on DEV (all 4 arms have data) ----------
arm_ids = ["baseline", "iter1", "iter2", "iter3"]
arm_names = [a["name"] for a in data["arms"]]
dev_means = [data["dev_set_aggregate"][a] for a in arm_ids]
baseline = dev_means[0]
threshold = baseline + 1.4

fig, ax = plt.subplots(figsize=(9, 5))
colors = [INK] + [LOSS if m < baseline else WIN for m in dev_means[1:]]
bars = ax.bar(range(4), dev_means, color=colors, alpha=0.92, width=0.55)
ax.axhline(threshold, color=MUTED, linestyle="--", linewidth=1.0)
ax.text(-0.3, threshold + 0.05, "pre-registered threshold (+1.4 pt)", ha="left", va="bottom",
        fontsize=9, color=MUTED, style="italic")
for i, m in enumerate(dev_means):
    if i > 0:
        ax.text(i, m + 0.1, f"{m - baseline:+.2f}", ha="center", va="bottom", fontsize=10)
    ax.text(i, m - 0.5, f"{m:.2f}", ha="center", va="top", color="white", fontsize=11, fontweight="bold")
ax.set_xticks(range(4))
ax.set_xticklabels(arm_names, fontsize=9)
ax.set_ylabel("Mean total / 18 (dev set, 11 cases)")
ax.set_ylim(11, 16)
ax.set_title("Phase 3 — Dev-set arm comparison (Strict Likert, Opus subagent judge)", fontsize=11)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()
fig.savefig("charts/arm-bar.png", dpi=160)
plt.close(fig)
print("wrote charts/arm-bar.png")

# --------- Chart 2: forest plot on TEST per-slice (baseline + iter3) ----------
slices = ["strategy-choice", "spoiler-defence", "empathy", "persona-stability", "domain-explain"]
slice_n = [2, 1, 2, 2, 1]
b_slice = [data["test_set_per_slice"]["baseline"][s] for s in slices]
i_slice = [data["test_set_per_slice"]["iter3"][s] for s in slices]
deltas = [i - b for b, i in zip(b_slice, i_slice)]
# CI = ±2pt rough (variance ~0.7 per case, so √2 case slice has CI ~2pt)
ci_half = 2.0

fig, ax = plt.subplots(figsize=(9, 5))
y_pos = list(range(len(slices) + 1))[::-1]  # top-down, aggregate at top
agg_delta = data["effect_sizes"]["iter3"]["aggregate"]["delta"]
labels = [f"AGGREGATE (n=8)"] + [f"{s} (n={n})" for s, n in zip(slices, slice_n)]
all_deltas = [agg_delta] + deltas
for i, (y, d, lbl) in enumerate(zip(y_pos, all_deltas, labels)):
    color = LOSS if d < -1.4 else (WIN if d > 1.4 else MUTED)
    ax.errorbar(d, y, xerr=ci_half, fmt="o", color=color, markersize=10, capsize=5, linewidth=2)
    ax.text(d, y + 0.18, f"{d:+.2f}", ha="center", va="bottom", fontsize=9, color=color)
ax.axvline(0, color=INK, linewidth=0.8, alpha=0.4)
ax.axvline(-1.4, color=LOSS, linestyle=":", linewidth=1.0, alpha=0.5)
ax.axvline(1.4, color=WIN, linestyle=":", linewidth=1.0, alpha=0.5)
ax.text(-1.4, -0.5, "−1.4 (loss floor)", ha="center", va="top", fontsize=8, color=LOSS)
ax.text(1.4, -0.5, "+1.4 (ship threshold)", ha="center", va="top", fontsize=8, color=WIN)
ax.set_yticks(y_pos)
ax.set_yticklabels(labels, fontsize=10)
ax.set_xlabel("Δ vs baseline (pt on 0-18 scale, test set, ±2pt CI)")
ax.set_xlim(-5.5, 3)
ax.set_title("Phase 5 — Test-set verdict: iter3 vs baseline (per slice + aggregate)", fontsize=11)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()
fig.savefig("charts/forest-plot.png", dpi=160)
plt.close(fig)
print("wrote charts/forest-plot.png")

# --------- Chart 3: cost-vs-accuracy (degenerate; all arms same model) ----------
fig, ax = plt.subplots(figsize=(9, 5))
costs = [0.075] * 4  # gemini-flash-lite cost per 1k tokens, USD
labels = ["baseline", "iter1", "iter2", "iter3"]
acc = dev_means
colors2 = [INK, MUTED, MUTED, LOSS]
ax.scatter(costs, acc, s=200, c=colors2, alpha=0.85)
for i, (c, a, l) in enumerate(zip(costs, acc, labels)):
    ax.text(c + 0.0008, a, f"{l} ({a:.2f})", va="center", fontsize=10)
ax.set_xlabel("Cost per 1k tokens (USD) — identical across arms (same model)")
ax.set_ylabel("Mean total / 18 (dev set)")
ax.set_xlim(0.07, 0.082)
ax.set_ylim(11.5, 14.5)
ax.set_title("Cost vs accuracy — no Pareto curve (same model, same cost; only prompt varies)", fontsize=10.5)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.text(0.071, 11.8, "All 4 arms share the same model (Gemini-3.1-flash-lite).\nPrompt-token delta is < 200 tokens — cost is effectively identical.\nThe 'next' Pareto move is a different MODEL, not a different prompt.",
        fontsize=9, color=MUTED, style="italic")
fig.tight_layout()
fig.savefig("charts/cost-vs-accuracy.png", dpi=160)
plt.close(fig)
print("wrote charts/cost-vs-accuracy.png")
