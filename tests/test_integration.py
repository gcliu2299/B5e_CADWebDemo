"""Test chained CAD operations, manual/AI interoperability, and API export."""
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
import main
from executor import Executor


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, 'executor', Executor())
    return TestClient(main.app)


def run(client, command):
    response = client.post('/execute', json={'command': command})
    assert response.status_code == 200, response.text
    return response.json()


def test_sequential_commands_share_state(client):
    # Mirrors the UI's sequential /execute requests (not a batch API).
    run(client, {'command': 'CREATE_LINE', 'x1': 0, 'y1': 0, 'x2': 3, 'y2': 4})
    run(client, {'command': 'MOVE_OBJECT', 'id': 1, 'dx': 2, 'dy': -1})
    run(client, {'command': 'SET_COLOR', 'id': 1, 'color': 'red'})
    obj = client.get('/state').json()['objects'][0]
    assert (obj['x1'], obj['y1'], obj['x2'], obj['y2']) == (2, -1, 5, 3)
    assert obj['color'] == 'red'
    run(client, {'command': 'DELETE_OBJECT', 'id': 1})
    assert client.get('/state').json()['objects'] == []


def test_manual_creation_then_ai_edit(client):
    # Manual drawing and NLP both submit standard executor commands.
    run(client, {'command': 'CREATE_CIRCLE', 'x': 2, 'y': 3, 'radius': 4})
    run(client, {'command': 'MOVE_OBJECT', 'id': 1, 'dx': 5, 'dy': -2})
    result = run(client, {'command': 'GET_POSITION', 'id': 1})
    assert result['result'] == {'x': 7, 'y': 1}
    assert result['objects'][0]['radius'] == 4
    run(client, {'command': 'UNDO'})  # Undo last state change (MOVE), not read-only GET.
    assert client.get('/state').json()['objects'][0]['x'] == 2


def test_failed_middle_command_leaves_earlier_steps(client):
    run(client, {'command': 'CREATE_POINT', 'x': 1, 'y': 2})
    response = client.post('/execute', json={'command': {'command': 'DELETE_OBJECT', 'id': 999}})
    assert response.status_code == 400
    assert [obj['id'] for obj in client.get('/state').json()['objects']] == [1]
    run(client, {'command': 'CREATE_POINT', 'x': 3, 'y': 4})
    assert [obj['id'] for obj in client.get('/state').json()['objects']] == [1, 2]


def test_dxf_export_endpoint(client, monkeypatch, tmp_path):
    run(client, {'command': 'CREATE_POINT', 'x': 1, 'y': 2})
    seen = {}

    def fake_export(objects, path):
        seen['objects'] = list(objects.values())
        Path(path).write_text('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n')

    monkeypatch.setattr(main, 'export_dxf', fake_export)
    response = client.get('/export/dxf')
    assert response.status_code == 200
    assert 'cad_drawing.dxf' in response.headers.get('content-disposition', '')
    assert b'SECTION' in response.content
    assert seen['objects'][0]['type'] == 'point'
