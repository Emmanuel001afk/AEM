"""Readiness check against metadata from the actual latest GitHub release.
Only prepares a short-lived upload URL; it never uploads bytes or finalizes/publishes a catalog row.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path
from catalog_error import annotate

release = json.loads(Path('catalog-check/release.json').read_text())
if release.get('family') != 'com.aem.store' or not re.fullmatch(r'\d+\.\d+\.\d+', release.get('version', '')):
    raise SystemExit('Expected actual AEM release metadata')
run = int(release['run'])
code = int(release['androidVersionCode'])
source = Path('src/services/supabase/client.ts').read_text()
key = re.search(r'DEFAULT_PUBLISHABLE_KEY="([^"]+)"', source).group(1)
os.environ['SUPABASE_KEY'] = key
payload = {'action': 'prepare', 'repo': 'Emmanuel001afk/AEM', 'run_id': run,
           'filename': 'app-release.apk', 'application_name': 'AEM Store',
           'version_name': release['version'], 'version_code': code, 'channel': 'stable',
           'package_identity': 'com.aem.store', 'title': 'AEM Store APK',
           'source_release_id': f'github-actions-{run}'}
request = urllib.request.Request('https://wfvvmyixqcwosmuldxoq.supabase.co/functions/v1/aem-publish-github-artifact',
                                 data=json.dumps(payload).encode(), method='POST', headers={
                                     'apikey': key, 'Authorization': f'Bearer {key}',
                                     'x-github-token': os.environ['GH_TOKEN'], 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(request, timeout=60) as response:
        body = json.load(response)
    if not body.get('upload_url'):
        annotate('readiness prepare', 'invalid-response', 'No upload URL returned')
        sys.exit(1)
    # Never disclose the signed URL/token.
    print('::notice title=Catalog readiness::Gateway authorized actual release metadata and prepared an upload URL. No bytes uploaded and no catalog row published by this diagnostic.')
except urllib.error.HTTPError as error:
    annotate('readiness prepare', error.code, error.read(10000).decode(errors='replace'))
    sys.exit(1)
except urllib.error.URLError as error:
    annotate('readiness network', 'unreachable', str(error.reason))
    sys.exit(1)
