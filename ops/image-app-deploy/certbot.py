"""Establish automatic renewal for the application HTTPS endpoint."""
import pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
from remote import dispatch
script=(ROOT/'ops/image-app-deploy/certbot-setup.sh').read_text()
dispatch('qintopia-image-app-certificate',script,timeout=1500)
