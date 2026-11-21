"""Evaluate real CAD Transformer predictions without failing CI on ordinary mistakes."""
import json
import os
import random
from collections import defaultdict
from pathlib import Path

import pytest
from cad_schema import SCHEMAS, canonical, parse_command
from inference import Predictor

ROOT = Path(__file__).resolve().parents[1]


def get_cases():
    path = ROOT / "cad_splits.json"
    if not path.is_file():
        raise FileNotFoundError("cad_splits.json is required for held-out evaluation.")
    splits = json.loads(path.read_text(encoding="utf-8"))
    samples_per_command = max(1, int(os.getenv("NLCAD_ROBUST_SAMPLES_PER_COMMAND", "1")))
    grouped = defaultdict(list)
    for question, answer in splits["test"]:
        expected = parse_command(answer)
        grouped[expected["command"]].append((question, expected, "held_out_test"))
    rng = random.Random(42)
    cases = []
    for command in sorted(grouped):
        pool = grouped[command][:]
        rng.shuffle(pool)
        cases.extend(pool[:samples_per_command])
    # Operations absent from a split still receive explicit, labeled probes.
    for name, text in [
        ("CLEAR_CANVAS", "clear the canvas."),
        ("UNDO", "undo the last state change."),
    ]:
        if name not in grouped:
            cases.append((text, {"command": name}, "manual_probe"))
    # Format robustness probes are NOT part of the official held-out score.
    probes = [
        ("draw a line from (1,2) to (6,2)", {"command":"CREATE_LINE","x1":1,"y1":2,"x2":6,"y2":2}),
        ("draw a line from 1,2 to 6,2", {"command":"CREATE_LINE","x1":1,"y1":2,"x2":6,"y2":2}),
        ("draw a line from 1 2 to 6 2", {"command":"CREATE_LINE","x1":1,"y1":2,"x2":6,"y2":2}),
        ("place a point at 3 5", {"command":"CREATE_POINT","x":3,"y":5}),
        ("draw a circle centered at 2,2 with radius 4", {"command":"CREATE_CIRCLE","x":2,"y":2,"radius":4}),
        ("delete object 8", {"command":"DELETE_OBJECT","id":8}),
    ]
    cases.extend((text, expected, "format_probe") for text, expected in probes)
    return cases


@pytest.mark.real_model
def test_real_model_robustness_report():
    checkpoint = ROOT / "cad_model.pt"
    assert checkpoint.is_file(), "Missing cad_model.pt: cannot check deployable model."
    assert len(SCHEMAS) == 20
    predictor = Predictor(str(checkpoint), device="cpu")
    cases = get_cases()
    entries = []
    for question, expected, category in cases:
        # Unexpected inference exceptions are fatal: do not deploy a broken model.
        raw = predictor.predict(question)
        valid, intent, exact = False, False, False
        try:
            predicted = parse_command(raw)
            valid = True
            intent = predicted["command"] == expected["command"]
            exact = canonical(predicted) == canonical(expected)
        except ValueError:
            predicted = None
        entries.append({
            "source": category, "input": question, "expected": expected,
            "predicted": predicted, "raw_output": raw,
            "valid_json_command": valid, "correct_intent": intent,
            "exact_match": exact,
        })

    summary = {}
    for category in sorted({r["source"] for r in entries}):
        subset = [r for r in entries if r["source"] == category]
        n = len(subset)
        summary[category] = {
            "samples": n,
            "valid_command_rate": round(sum(r["valid_json_command"] for r in subset) / n, 4),
            "intent_accuracy": round(sum(r["correct_intent"] for r in subset) / n, 4),
            "exact_match_accuracy": round(sum(r["exact_match"] for r in subset) / n, 4),
        }
    report = {"summary": summary, "errors": [r for r in entries if not r["exact_match"]]}
    report_path = ROOT / "model_robustness_report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print("\nReal-model robustness:")
    for group, metrics in summary.items():
        print(f"  {group}: {metrics['samples']} samples | valid {metrics['valid_command_rate']:.1%} | "
              f"intent {metrics['intent_accuracy']:.1%} | exact {metrics['exact_match_accuracy']:.1%}")
    print(f"  Error cases saved: {report_path.name} ({len(report['errors'])} errors)")
    # Model mistakes do not fail CI; loading / inference exceptions do.
    assert entries
