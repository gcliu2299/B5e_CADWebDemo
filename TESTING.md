# NLCAD — Automated Testing

NLCAD uses functional tests, a real-model smoke test, and a real-model robustness report. Run these commands from the project root after installing `requirements.txt`, `pytest`, and `httpx`.

## 1. Functional tests — must pass

```powershell
python -m pytest tests -q -m "not real_model"
```

Covers CAD commands, JSON schema validation, geometry and undo behavior, FastAPI endpoints, model architecture, sequential execution, manual-drawing command integration, and DXF endpoint behavior. API prediction tests in this group use mocks.

## 2. Real-model smoke test — must pass

```powershell
python -m pytest tests/test_real_inference.py -q -m real_model
```

Loads the actual `cad_model.pt` and verifies an end-to-end prediction. This checks basic model functionality, not its overall accuracy.

## 3. Real-model robustness evaluation — prediction mistakes are reported, not fatal

```powershell
python -m pytest tests/test_model_robustness.py -q -s -m real_model
```

Uses actual Transformer inference on samples from `cad_splits.json` and on additional punctuation/format variations. It reports valid-command rate, intent accuracy, and exact-match accuracy, and writes incorrect predictions to `model_robustness_report.json`.

For more held-out examples per command (default: 1):

```powershell
$env:NLCAD_ROBUST_SAMPLES_PER_COMMAND="5"
python -m pytest tests/test_model_robustness.py -q -s -m real_model
Remove-Item Env:NLCAD_ROBUST_SAMPLES_PER_COMMAND
```

The format probes are separate from the held-out metrics. This evaluation is sample-based; its accuracy is not necessarily the project's full-test accuracy. Missing model/split files or inference exceptions fail the test, but individual wrong predictions do not.

## 4. Frontend sentence-splitting tests

```powershell
node tests/test_frontend.js
```

Requires Node.js. Tests splitting logic, not the full browser drawing interface.

## CI / Deployment policy

- **Block deployment:** functional test failures, smoke-test failures, missing model/checkpoint, or inference crashes.
- **Allow deployment, record results:** ordinary wrong predictions in the robustness evaluation.
- Configure GitHub Actions to run all required checks and set Render Auto-Deploy to **After CI Checks Pass**. Merely running tests locally does not enforce deployment gates.

## Limitations

- Multi-command tests cover sequential backend calls; JavaScript sentence splitting is tested separately.
- The DXF API test mocks the export writer; it does not prove compatibility with external CAD software.
- Mouse-drawing interactions require separate browser automation to test end-to-end.
