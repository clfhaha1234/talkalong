#!/usr/bin/env python3
"""A/B comparison for the barge-in tuning experiment.

Reads outputs/A-baseline.json (current config) + outputs/B-tuned.json
(BARGE_IN_TUNING=1 config) and reports:
  - Per-case verdict matrix (A vs B)
  - FBR for A and B
  - True-positive recall for A and B
  - Ship verdict against pre-registered criteria

Pre-registered ship criteria (locked at experiment start):
  1. B FBR <= 10% (at most 1 false-positive case out of 7 triggers a turn)
  2. B recall = 100% (all 4 true-positive cases trigger a turn)
"""
import json
from pathlib import Path

HERE = Path(__file__).parent

def load(name):
    return json.load(open(HERE / 'outputs' / name))

def case_triggered(c):
    ev = c['events']
    final_stt = any(u['final'] for u in ev['user_transcriptions'])
    late_state = any(s['turnID'] >= 2 for s in ev['agent_states'])
    return final_stt or late_state

def case_metrics(d):
    by_axis = {'true-positive': [], 'false-positive-risk': [], 'false-positive-clean': []}
    for c in d['cases']:
        by_axis[c['axis']].append((c['case_id'], case_triggered(c)))
    return by_axis

import sys
B_NAME = sys.argv[1] if len(sys.argv) > 1 else 'B-tuned.json'
a = load('A-baseline.json')
b = load(B_NAME)
print(f"Comparing A-baseline.json vs {B_NAME}\n")

am = case_metrics(a)
bm = case_metrics(b)

print("=" * 70)
print("A/B PER-CASE TRIGGERED MATRIX")
print("=" * 70)
print(f"{'case':<6} {'axis':<24} {'A':<8} {'B':<8} {'delta':<10}")
print("-" * 70)
for axis in ['true-positive', 'false-positive-risk', 'false-positive-clean']:
    for (cid, at), (_, bt) in zip(am[axis], bm[axis]):
        d = 'unchanged' if at == bt else ('fix ✓' if at and not bt else 'regression ✗')
        print(f"{cid:<6} {axis:<24} {str(at):<8} {str(bt):<8} {d:<10}")

# Compute aggregate metrics
def stats(m):
    real_total = len(m['true-positive'])
    real_trig = sum(1 for _, t in m['true-positive'] if t)
    fp_cases = m['false-positive-risk'] + m['false-positive-clean']
    fp_total = len(fp_cases)
    fp_trig = sum(1 for _, t in fp_cases if t)
    recall = real_trig / real_total if real_total else 0
    fbr = fp_trig / fp_total if fp_total else 0
    return recall, fbr, real_trig, real_total, fp_trig, fp_total

ra, fbra, rta, rtotala, fta, ftotala = stats(am)
rb, fbrb, rtb, rtotalb, ftb, ftotalb = stats(bm)

print()
print("=" * 70)
print("AGGREGATE")
print("=" * 70)
print(f"{'metric':<25} {'A baseline':<18} {'B tuned':<18} {'delta':<10}")
print("-" * 70)
print(f"{'True-positive recall':<25} {rta}/{rtotala} = {ra*100:5.1f}%     {rtb}/{rtotalb} = {rb*100:5.1f}%     {(rb-ra)*100:+5.1f}pp")
print(f"{'FBR (false barge-in)':<25} {fta}/{ftotala} = {fbra*100:5.1f}%     {ftb}/{ftotalb} = {fbrb*100:5.1f}%     {(fbrb-fbra)*100:+5.1f}pp")

print()
print("=" * 70)
print("SHIP VERDICT (pre-registered criteria)")
print("=" * 70)
crit1 = fbrb <= 0.10
crit2 = rb == 1.0
print(f"  [{'✅' if crit1 else '❌'}] B FBR <= 10% (actual {fbrb*100:.1f}%)")
print(f"  [{'✅' if crit2 else '❌'}] B recall = 100% (actual {rb*100:.1f}%)")
print()
verdict = 'SHIP ✅' if (crit1 and crit2) else 'DO NOT SHIP ❌'
print(f"  Verdict: {verdict}")
