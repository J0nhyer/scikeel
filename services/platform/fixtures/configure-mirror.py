"""Configure a disposable local-only public index for the real mirror probe."""
import pathlib
import sys
from devpi_server.config import get_pluginmanager, parseoptions
from devpi_server.main import xom_from_config

store = pathlib.Path(sys.argv[1]).resolve()
if not store.name.startswith('scikeel-mirror-probe-') or not sys.argv[2].startswith('http://127.0.0.1:'):
    raise SystemExit('synthetic mirror identity required')
config = parseoptions(get_pluginmanager(), ['devpi-server', '--serverdir', str(store)])
xom = xom_from_config(config)
with xom.keyfs.write_transaction():
    stage = xom.model.getstage('root/pypi')
    stage.modify(mirror_url=sys.argv[2], mirror_cache_expiry=3600, mirror_no_project_list=True)
