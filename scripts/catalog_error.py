"""Bounded, credential-redacted GitHub annotation. Never print request headers or signed URLs."""
import json
import os
import re
import sys
from pathlib import Path


def annotate(phase, status, text):
    try:
        value = json.loads(text)
        text = str(value.get('error') or value.get('message') or 'Gateway returned an error without a message') if isinstance(value, dict) else 'Non-object gateway response'
    except (ValueError, TypeError):
        text = text[:1000] or 'No response body; inspect workflow step and gateway availability'
    for key, value in os.environ.items():
        if value and len(value) > 8 and any(word in key for word in ['TOKEN', 'KEY', 'PASSWORD', 'SECRET']):
            text = text.replace(value, '[redacted]')
    text = re.sub(r'https?://[^\s"<>]+', '[URL redacted]', text)
    text = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[JWT redacted]', text)
    message = f'{phase}: HTTP/status {status}: {text}'[:2000]
    message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f'::error title=Android catalog gateway::{message}', file=sys.stderr, flush=True)


if __name__ == '__main__':
    phase, status, file = sys.argv[1:4]
    try:
        text = Path(file).read_text()[:10000]
    except OSError:
        text = ''
    annotate(phase, status, text)
