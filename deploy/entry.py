"""Run with Python -I: no untrusted working directory, PYTHONPATH or user packages."""
import sys
sys.path.insert(0, '/opt/qintopia-image-release/lib')
from common import ReleaseError
from server import serve

try:
    serve()
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    print('QinTopia image: ' + (str(error) if isinstance(error, ReleaseError) else 'operation failed; inspect release status'), file=sys.stderr)
    sys.exit(1)
