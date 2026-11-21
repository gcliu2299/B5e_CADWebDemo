"""Optional live-checkpoint inference smoke test; run when explicitly requested."""
from pathlib import Path
import pytest
from cad_schema import validate_command, parse_command
from inference import Predictor


@pytest.mark.real_model
def test_real_checkpoint_greedy_prediction():
    path = Path(__file__).resolve().parents[1] / 'cad_model.pt'
    if not path.exists():
        pytest.skip('cad_model.pt not present')
    predictor = Predictor(str(path), device='cpu')
    raw = predictor.predict('draw a line from (1,2) to (6,2).')
    command = validate_command(parse_command(raw))
    assert command['command'] == 'CREATE_LINE'
    assert (command['x1'], command['y1'], command['x2'], command['y2']) == (1, 2, 6, 2)
