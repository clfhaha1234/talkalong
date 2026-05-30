#!/usr/bin/env python3
"""Render the 3 charts. Same custom structure as PR #13 — auto-lab's
chart.py assumes all arms tested + variance trials per arm, which differs
from this experiment's structure."""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

INK = "#222222"
WIN = "#2E7D32"
LOSS = "#C62828"
MUTED = "#9E9E9E"
WARN = "#F57C00"

data = json.load(open("data.json"))
os.makedirs("charts", exist_ok=True)

arm_ids = ["baseline", "A1", "A2", "A3"]
arm_names = ["baseline\ngemini-flash-lite", "A1\ngemini-3-flash-preview", "A2\nclaude-haiku-4-5", "A3\nazure:gpt-5.4-mini"]

# --------- Chart 1: arm-bar on TEST (the verdict) ----------
test_means = [data["test_set_aggregate"][a] for a in arm_ids]
baseline_test = test_means[0]
threshold = baseline_test + 1.4

fig, ax = plt.subplots(figsize=(10, 5))
colors = [INK] + [LOSS if m - baseline_test <= -1.4 else (WARN if m < baseline_test else WIN) for m in test_means[1:]]
bars = ax.bar(range(4), test_means, color=colors, alpha=0.92, width=0.55)
ax.axhline(threshold, color=MUTED, linestyle="--", linewidth=1.0)
ax.text(-0.3, threshold + 0.08, "pre-registered ship threshold (+1.4 pt)", ha="left", va="bottom",
        fontsize=9, color=MUTED, style="italic")
ax.axhline(baseline_test - 1.4, color=LOSS, linestyle=":", linewidth=0.8, alpha=0.5)
ax.text(3.45, baseline_test - 1.4 - 0.05, "loss floor", ha="right", va="top", fontsize=8, color=LOSS, style="italic")
for i, m in enumerate(test_means):
    if i > 0:
        ax.text(i, m + 0.1, f"{m - baseline_test:+.2f}", ha="center", va="bottom", fontsize=10)
    ax.text(i, m - 0.5, f"{m:.2f}", ha="center", va="top", color="white", fontsize=11, fontweight="bold")
ax.set_xticks(range(4))
ax.set_xticklabels(arm_names, fontsize=9)
ax.set_ylabel("Mean total / 18 (TEST set, 8 cases, Opus subagent judge)")
ax.set_ylim(10, 16)
ax.set_title("Phase 5 verdict — Test-set arm comparison (planner-tier swap)", fontsize=11)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()
fig.savefig("charts/arm-bar.png", dpi=160)
plt.close(fig)
print("wrote charts/arm-bar.png")

# --------- Chart 2: cross-judge sanity (the methodological finding) ----------
opus_dev = [data["dev_set_aggregate"][a] for a in arm_ids]
gemini_dev = [data["dev_set_aggregate_gemini_cross_judge"][a] for a in arm_ids]

fig, ax = plt.subplots(figsize=(10, 5))
x = list(range(4))
w = 0.35
b1 = ax.bar([i - w/2 for i in x], opus_dev, w, color=INK, alpha=0.85, label="Opus subagent (primary)")
b2 = ax.bar([i + w/2 for i in x], gemini_dev, w, color=MUTED, alpha=0.85, label="Gemini-3.5-flash (cross-judge sanity)")
# Annotate the disagreement on A2
a2_x = 2
ax.annotate("DISAGREEMENT\nOpus +0.88 / Gemini -0.82\n→ Opus self-judging bias on Anthropic family",
            xy=(a2_x + w/2, gemini_dev[2]),
            xytext=(2.5, 11.0),
            fontsize=9, color=LOSS, fontweight="bold", ha="center",
            arrowprops=dict(arrowstyle="->", color=LOSS, lw=1.2))
for i, (o, g) in enumerate(zip(opus_dev, gemini_dev)):
    ax.text(i - w/2, o + 0.1, f"{o:.2f}", ha="center", va="bottom", fontsize=9)
    ax.text(i + w/2, g + 0.1, f"{g:.2f}", ha="center", va="bottom", fontsize=9)
ax.set_xticks(x)
ax.set_xticklabels(arm_names, fontsize=9)
ax.set_ylabel("Dev-set mean / 18")
ax.set_ylim(10, 15)
ax.set_title("Cross-judge sanity — Opus vs Gemini on dev (caught A2 self-judging-bias)", fontsize=11)
ax.legend(loc="upper right", fontsize=9)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()
fig.savefig("charts/cross-judge.png", dpi=160)
plt.close(fig)
print("wrote charts/cross-judge.png")

# --------- Chart 3: cost vs accuracy (now meaningful — 4 prices) ----------
# Combined cost = input + output, assume ~600 in / ~200 out per call → 0.75× input + 0.25× output blended (rough)
def blended(a):
    return 0.75 * a["cost_per_1m_in_usd"] + 0.25 * a["cost_per_1m_out_usd"]

costs = [blended(a) for a in data["arms"]]
test_accs = test_means
arm_ids2 = arm_ids

fig, ax = plt.subplots(figsize=(10, 5))
for i, (c, a, l) in enumerate(zip(costs, test_accs, arm_ids2)):
    color = INK if l == "baseline" else (LOSS if a - baseline_test <= -1.4 else MUTED)
    ax.scatter(c, a, s=300, c=color, alpha=0.85, edgecolor="black", linewidth=0.5)
    ax.annotate(arm_names[i].replace('\n', ' '), (c, a), xytext=(8, 5), textcoords="offset points", fontsize=9)
ax.set_xlabel("Blended cost ($/1M tokens, ~75% in / 25% out)")
ax.set_ylabel("Test mean / 18")
ax.set_xscale("log")
ax.set_title("Cost vs accuracy — baseline dominates (cheapest AND best on test)", fontsize=11)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.text(0.15, 11.5, "Baseline (cheapest planner) is also the highest scorer on test.\nNo Pareto improvement available — upgrading the planner is net-negative.",
        fontsize=9, color=MUTED, style="italic")
fig.tight_layout()
fig.savefig("charts/cost-vs-accuracy.png", dpi=160)
plt.close(fig)
print("wrote charts/cost-vs-accuracy.png")
