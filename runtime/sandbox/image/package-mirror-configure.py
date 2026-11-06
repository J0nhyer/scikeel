import pathlib
import sys

from devpi_server.config import get_pluginmanager, parseoptions
from devpi_server.main import xom_from_config

store = pathlib.Path(sys.argv[1]).resolve()
url = sys.argv[2]
if not url.startswith(("http://", "https://")):
    raise SystemExit("invalid PyPI mirror URL")
config = parseoptions(get_pluginmanager(), ["devpi-server", "--serverdir", str(store)])
xom = xom_from_config(config)
with xom.keyfs.write_transaction():
    stage = xom.model.getstage("root/pypi")
    stage.modify(mirror_url=url, mirror_cache_expiry=3600, mirror_no_project_list=True)
